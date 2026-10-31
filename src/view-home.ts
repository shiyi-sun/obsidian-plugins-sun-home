import {
  ItemView,
  WorkspaceLeaf,
  Menu,
  setIcon,
  type MenuItem,
  type ViewStateResult,
} from "obsidian";
import type KbHomePlugin from "./main";
import {
  KnowledgeBase,
  KnowledgeGroup,
  scanKnowledgeBases,
  createKnowledgeBase,
  findGroupOf,
  getFolder,
  reconcileGroupOrders,
} from "./data";

export const VIEW_TYPE_KB_HOME = "kb-home-view";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 知识库列表页：语雀风格的卡片墙。
 * 分组标题 + 卡片网格；支持拖拽排序、分组折叠、新建知识库。
 */
export class KbHomeView extends ItemView {
  plugin: KbHomePlugin;
  private collapsed: Set<string> = new Set();
  private dragPath: string | null = null;
  private dragGroupId: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: KbHomePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_KB_HOME;
  }

  getDisplayText(): string {
    return "知识库";
  }

  getIcon(): string {
    return "library";
  }

  /** 持久化视图状态，避免布局恢复失败导致插件被禁用 */
  getState(): Record<string, unknown> {
    return { collapsed: Array.from(this.collapsed) };
  }

  async setState(state: Record<string, unknown>, _result: ViewStateResult): Promise<void> {
    const collapsed = state?.collapsed;
    if (Array.isArray(collapsed)) {
      this.collapsed = new Set(collapsed.filter((p): p is string => typeof p === "string"));
    }
    this.render();
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  /** 外部数据变化后调用，重绘 */
  public refresh(): void {
    this.render();
  }

  /**
   * 卡片墙唯一的数据入口。
   * 隐藏判定交给插件（与原生树共用 order.items[path].isHidden + glob 规则），
   * 在原生树里被藏起来的文件夹，不该在这里冒充知识库出现在列表上。
   */
  private scan(): KnowledgeBase[] {
    return scanKnowledgeBases(this.app, this.plugin.settings, this.plugin.isHiddenForList);
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("kb-home-container");

    const settings = this.plugin.settings;
    const all = this.scan();

    // 顶部工具条
    const toolbar = container.createDiv({ cls: "kb-home-toolbar" });
    toolbar.createEl("h2", { text: "知识库", cls: "kb-home-title" });
    const actions = toolbar.createDiv({ cls: "kb-home-actions" });

    const newKbBtn = actions.createEl("button", {
      cls: "kb-home-btn",
      attr: { "aria-label": "新建知识库" },
    });
    newKbBtn.setText("＋ 新建知识库");
    newKbBtn.onclick = () => this.promptNewKb(null);

    const newGroupBtn = actions.createEl("button", {
      cls: "kb-home-btn kb-home-btn-ghost",
      attr: { "aria-label": "新建分组" },
    });
    newGroupBtn.setText("＋ 新建分组");
    newGroupBtn.onclick = () => this.promptNewGroup();

    const body = container.createDiv({ cls: `kb-home-body kb-cards-${settings.cardStyle}` });

    // 先渲染分组（按定义顺序），再渲染未分组
    const grouped = new Set<string>();
    const missing: KnowledgeGroup[] = [];
    for (const g of settings.groups) {
      // 真实分组文件夹被外部删掉/移走时不渲染空壳，交给设置页处理
      if (!getFolder(this.app, g.path)) {
        missing.push(g);
        continue;
      }
      // 分组文件夹本身被隐藏时整组不出现（与根目录知识库的隐藏语义一致）
      if (this.plugin.isHiddenForList(g.path)) continue;
      const items = all.filter((kb) => kb.groupId === g.id);
      items.forEach((kb) => grouped.add(kb.path));
      this.renderGroup(body, g, items);
    }

    const ungrouped = all.filter((kb) => !grouped.has(kb.path));
    // 有分组时始终保留「未分组」区域：否则当所有库都在组里时，
    // 卡片没有任何可以把文件夹拖回根目录的落点。
    if (ungrouped.length > 0 || settings.groups.length > 0) {
      this.renderGroup(
        body,
        { id: "__ungrouped__", name: settings.groups.length ? "未分组" : "", path: "", order: [] },
        ungrouped
      );
    }

    if (missing.length > 0) {
      body.createDiv({
        cls: "kb-home-empty",
        text: `分组文件夹不存在：${missing.map((g) => g.path).join("、")}。请在设置里删除该分组或恢复文件夹。`,
      });
    }

    if (all.length === 0 && settings.groups.length === 0) {
      body.createDiv({
        cls: "kb-home-empty",
        text: "还没有知识库。在 vault 根目录新建一个文件夹，它就会自动出现在这里。",
      });
    }
  }

  private renderGroup(parent: HTMLElement, group: KnowledgeGroup, items: KnowledgeBase[]): void {
    const isUngrouped = group.id === "__ungrouped__";
    const isCollapsed = this.collapsed.has(group.id);

    const sec = parent.createDiv({ cls: "kb-group" });
    sec.dataset.groupId = group.id;
    sec.dataset.groupPath = group.path;

    // 整个分组区域都是放置目标：拖卡片到分组任意位置即可移入该分组。
    // 卡片自身的 drop 会 stopPropagation，所以这里只在「非卡片区域」生效。
    this.attachGroupDrop(sec, group);

    if (group.name) {
      const header = sec.createDiv({ cls: "kb-group-header" });
      const toggle = header.createEl("span", { cls: "kb-group-toggle" });
      toggle.setText(isCollapsed ? "▸" : "▾");
      header.createEl("span", { cls: "kb-group-name", text: group.name });
      header.createEl("span", { cls: "kb-group-count", text: `${items.length}` });

      header.onclick = () => {
        if (isCollapsed) this.collapsed.delete(group.id);
        else this.collapsed.add(group.id);
        this.render();
      };

      // 右键：分组的管理操作（文字标签，不依赖悬停小图标）
      header.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showGroupMenu(e, group, isCollapsed);
      });

      // 分组重命名 / 删除（未分组不允许）
      if (!isUngrouped) {
        this.attachGroupDrag(header, group);

        const tools = header.createDiv({ cls: "kb-group-tools" });
        const ren = tools.createEl("span", { cls: "kb-group-tool", text: "✎" });
        ren.onclick = (e) => {
          e.stopPropagation();
          this.promptRenameGroup(group);
        };
        const del = tools.createEl("span", { cls: "kb-group-tool", text: "✕" });
        del.onclick = (e) => {
          e.stopPropagation();
          this.deleteGroup(group);
        };
      }
    }

    if (isCollapsed) {
      // 折叠状态下也要能拖进来：给一个提示性的放置区
      const dropHint = sec.createDiv({
        cls: "kb-group-drop-hint",
        text: isUngrouped ? "拖到此处移出分组（放到根目录）" : "拖到此处移入本分组",
      });
      dropHint.dataset.groupDropHint = group.id;
      return;
    }

    const grid = sec.createDiv({ cls: "kb-grid" });

    for (const kb of items) {
      const card = grid.createDiv({ cls: "kb-card" });
      card.setAttribute("draggable", "true");
      card.dataset.path = kb.path;

      // 图标：自定义 emoji 保留，未设置时用主题色线性书本
      const iconEl = card.createDiv({ cls: "kb-card-icon" });
      if (kb.icon) {
        iconEl.addClass("is-emoji");
        iconEl.setText(kb.icon);
      } else {
        setIcon(iconEl, "book-open");
      }

      // 名称行
      const nameRow = card.createDiv({ cls: "kb-card-name-row" });
      nameRow.createEl("span", { cls: "kb-card-name", text: kb.name });

      // 悬停操作
      const tools = nameRow.createDiv({ cls: "kb-card-tools" });
      const edit = tools.createEl("span", { cls: "kb-card-tool", text: "⋯" });
      edit.onclick = (e) => {
        e.stopPropagation();
        this.promptEditKb(kb);
      };

      // 文档数（右对齐，单行展示）
      card.createDiv({ cls: "kb-card-count", text: `${kb.docCount} 篇` });

      // 点击进入
      card.onclick = () => this.plugin.openKbTree(kb);

      // 右键：编辑信息 / 移入分组
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showKbMenu(e as MouseEvent, kb);
      });

      // 拖拽排序
      this.attachDrag(card, kb, group);
    }

    // 空分组只留一行提示：新建入口在工具条按钮和分组标题的右键菜单里，
    // 不再每个分组末尾挂一张 96px 高的虚线「新建」大框。
    if (items.length === 0) {
      grid.createDiv({
        cls: "kb-group-empty",
        text: isUngrouped
          ? "没有未分组知识库 · 把卡片拖到这里 → 移出分组（放到根目录）"
          : "空分组 · 把卡片拖进来（会移动文件夹），或右键分组标题选「新建知识库」",
      });
    }
  }

  /** 给分组区域挂上拖放处理：把卡片拖到本分组即移入 */
  private attachGroupDrop(sec: HTMLElement, group: KnowledgeGroup): void {
    const isUngrouped = group.id === "__ungrouped__";
    // 「未分组」和真实分组的外壳 id 不同，比较归属时要归一成 null
    const targetGroupId = isUngrouped ? null : group.id;

    sec.addEventListener("dragover", (e) => {
      if (!this.dragPath) return;
      // 已在卡片上处理过的不重复处理
      if ((e.target as HTMLElement)?.closest?.(".kb-card")) return;
      // 拖回自己所在分组的空白处没有意义，也不该整块变色
      if (findGroupOf(this.plugin.settings, this.dragPath) === targetGroupId) {
        sec.removeClass("kb-group-drop-target");
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      sec.addClass("kb-group-drop-target");
    });

    sec.addEventListener("dragleave", (e) => {
      if (sec.contains(e.relatedTarget as Node)) return;
      sec.removeClass("kb-group-drop-target");
    });

    sec.addEventListener("drop", async (e) => {
      // 卡片自己的 drop 会 stopPropagation，走到这里说明落在分组空白/标题上
      if ((e.target as HTMLElement)?.closest?.(".kb-card")) return;
      e.preventDefault();
      sec.removeClass("kb-group-drop-target");
      const from = this.dragPath;
      this.dragPath = null;
      if (!from) return;
      await this.moveToGroup(from, isUngrouped ? null : group.id);
    });
  }

  /** 把某个知识库移入目标分组（groupId 为 null 表示移出到未分组） */
  private async moveToGroup(kbPath: string, groupId: string | null): Promise<void> {
    await this.plugin.moveKbToGroup(kbPath, groupId);
    this.render();
  }

  /** 拖动分组标题可调整分组之间的显示顺序；「未分组」固定在末尾，不参与排序 */
  private attachGroupDrag(header: HTMLElement, group: KnowledgeGroup): void {
    header.setAttribute("draggable", "true");

    header.addEventListener("dragstart", (e) => {
      this.dragGroupId = group.id;
      header.addClass("kb-group-dragging");
      e.dataTransfer?.setData("text/plain", `group:${group.id}`);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      e.stopPropagation();
    });

    header.addEventListener("dragend", () => {
      this.dragGroupId = null;
      header.removeClass("kb-group-dragging");
      this.clearGroupOrderMarks();
    });

    header.addEventListener("dragover", (e) => {
      if (!this.dragGroupId || this.dragGroupId === group.id) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const before = this.isDropBeforeHeader(e, header);
      header.toggleClass("kb-group-drop-before", before);
      header.toggleClass("kb-group-drop-after", !before);
    });

    header.addEventListener("dragleave", (e) => {
      if (header.contains(e.relatedTarget as Node)) return;
      header.removeClass("kb-group-drop-before");
      header.removeClass("kb-group-drop-after");
    });

    header.addEventListener("drop", async (e) => {
      if (!this.dragGroupId) return;
      e.preventDefault();
      e.stopPropagation();
      const before = this.isDropBeforeHeader(e, header);
      const draggedId = this.dragGroupId;
      this.dragGroupId = null;
      header.removeClass("kb-group-dragging");
      this.clearGroupOrderMarks();
      if (draggedId === group.id) return;
      await this.moveGroup(draggedId, group.id, before);
    });
  }

  private isDropBeforeHeader(e: DragEvent, header: HTMLElement): boolean {
    const rect = header.getBoundingClientRect();
    return (e.clientY ?? 0) < rect.top + rect.height / 2;
  }

  /** 把 fromId 移到 toId 前面或后面，并落盘 */
  private async moveGroup(fromId: string, toId: string, before: boolean): Promise<void> {
    const settings = this.plugin.settings;
    const groups = settings.groups.slice();
    const fromIndex = groups.findIndex((g) => g.id === fromId);
    if (fromIndex < 0) return;

    const [moved] = groups.splice(fromIndex, 1);
    const targetIndex = groups.findIndex((g) => g.id === toId);
    if (targetIndex < 0) return;

    groups.splice(before ? targetIndex : targetIndex + 1, 0, moved);
    settings.groups = groups;
    await this.plugin.saveSettingsNow();
    this.render();
  }

  private clearGroupOrderMarks(): void {
    this.containerEl
      .querySelectorAll<HTMLElement>(".kb-group-drop-before, .kb-group-drop-after")
      .forEach((el) => {
        el.removeClass("kb-group-drop-before");
        el.removeClass("kb-group-drop-after");
      });
  }

  /** 给卡片挂上拖拽事件 */
  private attachDrag(card: HTMLElement, kb: KnowledgeBase, group: KnowledgeGroup): void {
    card.addEventListener("dragstart", (e) => {
      this.dragPath = kb.path;
      card.addClass("kb-card-dragging");
      e.dataTransfer?.setData("text/plain", kb.path);
    });

    card.addEventListener("dragend", () => {
      this.dragPath = null;
      card.removeClass("kb-card-dragging");
      this.clearCardDropMarks();
      this.clearGroupDropMarks();
    });

    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      // 阻止冒泡，避免分组容器同时高亮
      e.stopPropagation();
      if (!this.dragPath || this.dragPath === kb.path) return;
      this.markCardDrop(card, this.isDropBeforeCard(e, card));
    });

    card.addEventListener("dragleave", (e) => {
      if (card.contains(e.relatedTarget as Node)) return;
      this.clearCardDropMark(card);
    });

    card.addEventListener("drop", (e) => {
      e.preventDefault();
      // 阻止冒泡到分组容器 —— 卡片间拖放只做「同级重排」，不改变分组归属
      e.stopPropagation();
      const before = this.isDropBeforeCard(e, card);
      this.clearCardDropMarks();
      const from = this.dragPath;
      if (!from || from === kb.path) return;
      // 跨分组拖到卡片上 = 移入该卡片所属分组
      const fromGroup = findGroupOf(this.plugin.settings, from);
      if ((kb.groupId ?? null) !== fromGroup) {
        void this.moveToGroup(from, kb.groupId ?? null);
      } else {
        void this.reorder(from, kb.path, group, before);
      }
      this.dragPath = null;
    });
  }

  /** 落点在卡片左半 → 插到它前面；右半 → 插到它后面 */
  private isDropBeforeCard(e: DragEvent, card: HTMLElement): boolean {
    const rect = card.getBoundingClientRect();
    return (e.clientX ?? 0) < rect.left + rect.width / 2;
  }

  /** 同一时刻只给一张卡片画落点：目标卡描边 + 插入线 */
  private markCardDrop(card: HTMLElement, before: boolean): void {
    for (const el of Array.from(
      this.containerEl.querySelectorAll<HTMLElement>(".kb-card-drop-target")
    )) {
      if (el !== card) this.clearCardDropMark(el);
    }
    card.addClass("kb-card-drop-target");
    card.toggleClass("kb-card-drop-before", before);
    card.toggleClass("kb-card-drop-after", !before);
  }

  private clearCardDropMark(card: HTMLElement): void {
    card.removeClass("kb-card-drop-target");
    card.removeClass("kb-card-drop-before");
    card.removeClass("kb-card-drop-after");
  }

  private clearCardDropMarks(): void {
    this.containerEl
      .querySelectorAll<HTMLElement>(".kb-card-drop-target")
      .forEach((el) => this.clearCardDropMark(el));
  }

  /** 清掉所有分组的高亮态 */
  private clearGroupDropMarks(): void {
    this.containerEl
      .querySelectorAll<HTMLElement>(".kb-group-drop-target")
      .forEach((el) => el.removeClass("kb-group-drop-target"));
  }

  /** 把 from 移动到 to 前面或后面 */
  private async reorder(
    from: string,
    to: string,
    group: KnowledgeGroup,
    before: boolean
  ): Promise<void> {
    const s = this.plugin.settings;
    const isUngrouped = group.id === "__ungrouped__";

    let order: string[];
    if (isUngrouped) {
      order = s.ungroupedOrder.slice();
    } else {
      const g = s.groups.find((x) => x.id === group.id);
      if (!g) return;
      order = g.order.slice();
    }

    // 确保列表里包含所有相关项（补齐未列入的）
    const all = this.scan();
    const siblingPaths = all
      .filter((k) => (isUngrouped ? !k.groupId : k.groupId === group.id))
      .map((k) => k.path);
    for (const p of siblingPaths) if (!order.includes(p)) order.push(p);

    const fi = order.indexOf(from);
    if (fi === -1) return;
    order.splice(fi, 1);

    // 先移除再找落点：当 from 原本在 to 前面时，to 的下标会前移一位
    const ti = order.indexOf(to);
    if (ti === -1) return;
    order.splice(before ? ti : ti + 1, 0, from);

    if (isUngrouped) {
      s.ungroupedOrder = order;
    } else {
      const g = s.groups.find((x) => x.id === group.id);
      if (g) g.order = order;
    }

    // 若把某个库拖进分组，需要更新归属
    if (!isUngrouped) {
      // 该库若原本属于别的组，移出
      for (const g of s.groups) {
        if (g.id !== group.id) g.order = g.order.filter((p) => p !== from);
      }
    }

    await this.plugin.saveSettings();
    this.render();
  }

  // ============ 交互弹窗 ============

  private promptNewKb(groupId: string | null): void {
    const group = groupId
      ? this.plugin.settings.groups.find((g) => g.id === groupId) ?? null
      : null;
    const where = group ? `「${group.name}」分组里` : "vault 根目录下";
    this.plugin.showInputModal(
      "新建知识库",
      `将在${where}创建同名文件夹`,
      "",
      async (name) => {
        if (!name?.trim()) return;
        try {
          const s = this.plugin.settings;
          const target = groupId ? s.groups.find((g) => g.id === groupId) : null;
          if (groupId && !target) throw new Error("分组不存在");
          let parentPath = "/";
          if (target) {
            if (!getFolder(this.app, target.path)) throw new Error("分组文件夹不存在");
            parentPath = target.path;
          }
          await createKnowledgeBase(this.app, name.trim(), parentPath);
          reconcileGroupOrders(this.app, s);
          await this.plugin.saveSettingsNow();
          this.render();
        } catch (err) {
          this.plugin.notice(errorText(err));
        }
      }
    );
  }

  private promptNewGroup(): void {
    this.plugin.showInputModal(
      "新建分组",
      "将创建一个真实文件夹作为分组；组内知识库是它的直接子文件夹",
      "",
      async (name) => {
        if (!name?.trim()) return;
        try {
          await this.plugin.createGroup(name.trim());
          this.render();
        } catch (err) {
          this.plugin.notice(errorText(err));
        }
      }
    );
  }

  private promptRenameGroup(group: KnowledgeGroup): void {
    this.plugin.showInputModal("重命名分组", "请输入新的分组名称", group.name, async (name) => {
      if (!name?.trim()) return;
      try {
        await this.plugin.renameGroup(group, name.trim());
        this.render();
      } catch (err) {
        this.plugin.notice(errorText(err));
      }
    });
  }

  private async deleteGroup(group: KnowledgeGroup): Promise<void> {
    this.plugin.confirmModal(
      "删除分组",
      `确定删除分组「${group.name}」吗？组内 ${group.order.length} 个知识库会移回 vault 根目录（变成未分组），然后删除空的分组文件夹；不会删除任何笔记。`,
      async () => {
        const result = await this.plugin.dissolveGroup(group);
        if (result.errors.length > 0) {
          this.plugin.notice("删除分组时出错：" + result.errors[0]);
        }
        this.render();
      }
    );
  }

  /** 分组标题的右键菜单 */
  private showGroupMenu(e: MouseEvent, group: KnowledgeGroup, isCollapsed: boolean): void {
    const menu = new Menu();
    const isUngrouped = group.id === "__ungrouped__";

    menu.addItem((item) =>
      item
        .setTitle("新建知识库")
        .setIcon("file-plus")
        .onClick(() => this.promptNewKb(isUngrouped ? null : group.id))
    );
    menu.addItem((item) =>
      item
        .setTitle(isCollapsed ? "展开此分组" : "折叠此分组")
        .setIcon("chevrons-up-down")
        .onClick(() => {
          if (isCollapsed) this.collapsed.delete(group.id);
          else this.collapsed.add(group.id);
          this.render();
        })
    );

    if (!isUngrouped) {
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle("重命名分组").setIcon("pencil").onClick(() => this.promptRenameGroup(group))
      );
      menu.addItem((item) =>
        item.setTitle("删除分组").setIcon("trash").onClick(() => this.deleteGroup(group))
      );
    }

    menu.showAtMouseEvent(e);
  }

  /** 知识库卡片的右键菜单 */
  private showKbMenu(e: MouseEvent, kb: KnowledgeBase): void {
    const menu = new Menu();
    const currentGroupId = kb.groupId ?? "";

    menu.addItem((item) =>
      item.setTitle("编辑信息").setIcon("pencil").onClick(() => this.promptEditKb(kb))
    );

    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle("移入分组").setIcon("folder-tree");
      // setSubmenu 未在公开类型里声明；旧版本缺失时退化为在当前菜单里平铺
      const maybeSubmenu = item as MenuItem & { setSubmenu?: () => Menu };
      const sub: Menu =
        typeof maybeSubmenu.setSubmenu === "function" ? maybeSubmenu.setSubmenu() : menu;
      const targets: [string, string][] = [["（未分组）", ""]];
      for (const g of this.plugin.settings.groups) targets.push([g.name, g.id]);
      for (const [label, gid] of targets) {
        sub.addItem((si) =>
          si
            .setTitle(label)
            .setIcon(gid === currentGroupId ? "check" : "folder")
            .onClick(() => void this.moveToGroup(kb.path, gid === "" ? null : gid))
        );
      }
    });

    menu.addSeparator();
    // 隐藏用的是原生树那一个标记：藏起来后这张卡片消失，原生树里也同时不见
    menu.addItem((item) =>
      item
        .setTitle("从列表隐藏")
        .setIcon("eye-off")
        .onClick(() => void this.plugin.setItemHidden(kb.path, true))
    );

    menu.showAtMouseEvent(e);
  }

  private promptEditKb(kb: KnowledgeBase): void {
    // 用一个小菜单：改名 / 改图标 / 移入分组
    this.plugin.showKbEditModal(kb, async () => {
      this.render();
    });
  }
}
