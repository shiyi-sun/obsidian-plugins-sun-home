import {
  ItemView,
  WorkspaceLeaf,
  TFolder,
  TFile,
  TAbstractFile,
  Menu,
  Notice,
  setIcon,
} from "obsidian";
import type KbHomePlugin from "./main";
import { SORT_OPTIONS } from "./core/menu";
import { isFolderSettings, type FolderSettings, type SortOrder } from "./core/order-types";

export const VIEW_TYPE_KB_TREE = "kb-tree-view";

/** 拖拽落点位置 */
type DropSide = "before" | "after" | "inside";

/** 拖拽时悬停在折叠文件夹上多久自动展开（与原生一致） */
const EXPAND_DELAY_MS = 1000;

/**
 * 单库树视图：点卡片后，左侧栏只显示这一个知识库的内部树。
 * 结构：知识库根 → 子文件夹 → 笔记。
 *
 * 行 DOM 直接复用原生文件浏览器的类名与嵌套（.tree-item.nav-folder/.nav-file
 * > .tree-item-self > .tree-item-inner，缩进靠 .tree-item-children 嵌套），
 * 外观交给 app.css 与主题，行为也以原生为标尺：
 * - 同文件夹内拖拽调序（顺序与原生树共用 order.items[文件夹].customOrder）
 * - 拖到文件夹行中间移入；拖到别处条目的上/下沿 = 移进那个文件夹
 * - 拖到库根标题 = 移回库根；重名自动避让；停在折叠文件夹上一秒自动展开
 * - Ctrl/中键开新标签；隐藏与置顶沿用原生树那一份 order.items 标记
 */
export class KbTreeView extends ItemView {
  plugin: KbHomePlugin;
  private currentPath: string | null = null;
  private collapsed: Set<string> = new Set();
  /** 是否自动展开并高亮当前打开的笔记 */
  private autoReveal = true;
  /** 「自动定位」按钮的 DOM 引用，用于同步激活态 */
  private autoRevealBtn: HTMLElement | null = null;

  // ---------- 拖拽状态 ----------
  /** 正在被拖拽的条目路径 */
  private dragPath: string | null = null;
  /** 上一次命中的落点条目，用于清理指示样式 */
  private lastDropEl: HTMLElement | null = null;
  /** 当前落点类型 */
  private dropSide: DropSide = "before";
  /** 悬停待自动展开的文件夹（同原生：停在折叠文件夹上一会儿就展开） */
  private expandPath: string | null = null;
  private expandTimer = 0;

  // ---------- 点击手势保护 ----------
  /** 指针正按在本面板内；此期间不重建 DOM，见 render() */
  private inGesture = false;
  /** 手势期间被推迟的重绘 */
  private pendingRender = false;

  constructor(leaf: WorkspaceLeaf, plugin: KbHomePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_KB_TREE;
  }

  getDisplayText(): string {
    return this.currentPath ? this.currentPath.split("/").pop()! : "知识库目录";
  }

  getIcon(): string {
    return "folder-tree";
  }

  /** 持久化视图状态，供 Obsidian 重启后恢复布局（缺此方法会导致恢复失败） */
  getState(): Record<string, unknown> {
    return {
      currentPath: this.currentPath,
      autoReveal: this.autoReveal,
      collapsed: Array.from(this.collapsed),
    };
  }

  async setState(state: any, _result: any): Promise<void> {
    if (state) {
      this.currentPath = state.currentPath ?? this.currentPath;
      this.autoReveal = state.autoReveal ?? this.autoReveal;
      if (Array.isArray(state.collapsed)) {
        this.collapsed = new Set(state.collapsed);
      }
    }
    this.render();
  }

  async onOpen(): Promise<void> {
    this.render();

    // Obsidian 在 pointerdown 阶段就把被点的侧栏面板设为 activeLeaf，
    // 于是 active-leaf-change 恰好夹在 mousedown 与 click 之间触发。
    // 若此时重建 DOM，正被点击的那一行会被销毁，click 再也送不到它身上，
    // 表现为「切第二个笔记要双击」。所以手势期间只登记重绘，等手势收尾再补。
    this.registerDomEvent(this.containerEl, "pointerdown", () => {
      this.inGesture = true;
    });
    // click 冒泡到面板时，行上的处理器已经跑完，此时补重绘是安全的。
    // 右键与拖拽不会派发 click，分别用 contextmenu / dragend 收尾。
    for (const type of ["click", "contextmenu", "dragend"] as const) {
      this.registerDomEvent(this.containerEl, type, () => this.endGesture());
    }

    // 活动文件变化时：先同步高亮（轻量，只切 class），
    // 若开启自动定位再展开父级（可能被手势保护推迟）。
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateActiveHighlight();
        if (this.autoReveal && this.currentPath) this.revealActive();
      })
    );
  }

  /**
   * 只更新高亮态，不重建 DOM。
   * 打开笔记后调用，保证树里当前笔记立即高亮，且不因 DOM 重建打断点击。
   */
  updateActiveHighlight(): void {
    const active = this.app.workspace.getActiveFile();
    const activePath = active?.path ?? null;
    this.containerEl
      .querySelectorAll<HTMLElement>(".kb-tree-body .nav-file-title")
      .forEach((self) => self.toggleClass("is-active", self.dataset.path === activePath));
  }

  /** 在树面板顶部自建一排工具按钮（位置与原生文件浏览器一致） */
  private renderToolbar(parent: HTMLElement): void {
    // 直接用原生的按钮类：nav-action-button / clickable-icon 的尺寸、颜色、hover
    // 全由 app.css 与主题负责，和侧栏文件浏览器那排长得一模一样，主题一改就跟上了。
    const bar = parent.createDiv({ cls: "nav-buttons-container kb-tree-toolbar" });

    const mk = (icon: string, title: string, onClick: (e: MouseEvent) => void) => {
      const btn = bar.createDiv({ cls: "clickable-icon nav-action-button" });
      btn.setAttribute("aria-label", title);
      btn.setAttribute("title", title);
      setIcon(btn, icon);
      btn.onclick = (e) => onClick(e);
      return btn;
    };

    mk("file-plus", "新建笔记", () => this.actionNewNote());
    mk("folder-plus", "新建文件夹", () => this.actionNewFolder());
    mk("arrow-up-down", "排序方式", (e) => this.showSortMenu(e));

    this.autoRevealBtn = mk("crosshair", "自动定位当前笔记", () => this.toggleAutoReveal());
    this.autoRevealBtn.toggleClass("is-active", this.autoReveal);

    mk("chevrons-down-up", "折叠全部 / 展开全部", () => this.toggleCollapseAll());
    mk("refresh-cw", "刷新", () => this.render());
  }

  /** 同步「自动定位」按钮的激活态样式 */
  private updateAutoRevealAction(): void {
    if (!this.autoRevealBtn) return;
    this.autoRevealBtn.toggleClass("is-active", this.autoReveal);
  }

  /** 外部调用：设置要展示的知识库 */
  public showKb(path: string): void {
    this.currentPath = path;
    this.collapsed.clear();
    this.render();
  }

  /** 文件夹改名 / 移动后跟随新路径；当前库在旧路径之下时同步更新 */
  public handlePathRenamed(oldPath: string, newPath: string): void {
    if (!this.currentPath) return;
    if (this.currentPath !== oldPath && !this.currentPath.startsWith(oldPath + "/")) return;

    this.currentPath =
      this.currentPath === oldPath
        ? newPath
        : newPath + this.currentPath.slice(oldPath.length);
    // 折叠状态按旧路径存，改名后直接清掉，避免整棵树错位折叠
    this.collapsed.clear();
    this.render();
  }

  public refresh(): void {
    this.render();
  }

  // ============================================================
  // 头部快捷操作
  // ============================================================

  /** 在指定文件夹下按原生文件树的做法直接建笔记：不弹名字框，默认「未命名」并自动避让重名 */
  private async createNoteIn(folder: TFolder): Promise<void> {
    let name = "未命名";
    for (let i = 1; this.app.vault.getAbstractFileByPath(`${folder.path}/${name}.md`); i++) {
      name = `未命名 ${i}`;
    }
    const file = await this.app.vault.create(`${folder.path}/${name}.md`, "");
    await this.plugin.openNote(file);
  }

  /** 新建笔记：在当前库根目录下建，或建到当前选中的文件夹 */
  private actionNewNote(): void {
    const folder = this.requireRootFolder();
    if (!folder) return;
    void this.createNoteIn(folder);
  }

  /** 新建文件夹：建在当前库根目录 */
  private actionNewFolder(): void {
    const folder = this.requireRootFolder();
    if (!folder) return;
    this.plugin.showInputModal("新建文件夹", `在「${folder.name}」下新建文件夹`, "", async (name) => {
      if (!name?.trim()) return;
      const path = `${folder.path}/${name.trim()}`;
      if (this.app.vault.getAbstractFileByPath(path)) {
        new Notice(`已存在：${path}`);
        return;
      }
      await this.app.vault.createFolder(path);
    });
  }

  /** 排序菜单（作用于整个库：库里每个文件夹的 sortOrder 都设成所选值） */
  private showSortMenu(evt: MouseEvent): void {
    const root = this.requireRootFolder();
    const engine = this.plugin.sortFeature;
    if (!root || !engine) return;
    const current = engine.ensureFolderSettings(root.path).sortOrder;
    const menu = new Menu();
    for (const [label, order] of SORT_OPTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(label)
          .setIcon(order === current ? "check" : "arrow-up-down")
          .onClick(() => this.applySortOrder(root, order))
      );
    }
    // 定位到按钮下方
    const rect = (evt.currentTarget as HTMLElement | null)?.getBoundingClientRect?.();
    if (rect) menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    else menu.showAtMouseEvent(evt);
  }

  /**
   * 把本库所有文件夹的排序方式统一设为 order。
   * 切到「自定义顺序」前先把各文件夹当前显示顺序固化进 customOrder ——
   * 否则顺序会跳回这个文件夹上一次手动排列的旧结果。
   */
  private applySortOrder(root: TFolder, order: SortOrder): void {
    const engine = this.plugin.sortFeature;
    if (!engine) return;
    const walk = (folder: TFolder): void => {
      const settings = engine.ensureFolderSettings(folder.path);
      if (order === "custom" && settings.sortOrder !== "custom") {
        settings.customOrder = this.sortEntries(this.folderEntries(folder), folder.path).map(
          (c) => c.name
        );
      }
      settings.sortOrder = order;
      for (const child of folder.children) if (child instanceof TFolder) walk(child);
    };
    walk(root);
    void this.plugin.saveSettingsNow();
    // 这一份设置原生文件浏览器也在读，让它立刻重排
    this.plugin.sortFeature?.sortExplorer();
    this.render();
  }

  /** 切换「自动定位当前笔记」 */
  private toggleAutoReveal(): void {
    this.autoReveal = !this.autoReveal;
    this.updateAutoRevealAction();
    new Notice(this.autoReveal ? "已开启：自动定位当前笔记" : "已关闭：自动定位当前笔记");
    if (this.autoReveal) this.revealActive();
  }

  /** 展开当前活动笔记的所有父级文件夹 */
  private revealActive(): void {
    const active = this.app.workspace.getActiveFile();
    if (!active || !this.currentPath) return;
    if (!active.path.startsWith(this.currentPath + "/")) return;

    // 展开从库根到该文件之间的所有文件夹；没有折叠项要解开就不必重绘
    const parts = active.path.split("/");
    let acc = "";
    let changed = false;
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (this.collapsed.delete(acc)) changed = true;
    }
    if (changed) this.render();
  }

  /** 一键折叠全部 / 展开全部 */
  private toggleCollapseAll(): void {
    const folder = this.requireRootFolder();
    if (!folder) return;

    const allFolders: TFolder[] = [];
    const walk = (f: TFolder): void => {
      for (const c of f.children) {
        if (c instanceof TFolder) {
          allFolders.push(c);
          walk(c);
        }
      }
    };
    walk(folder);

    // 若当前有任何未折叠的文件夹，就全部折叠；否则全部展开
    const anyExpanded = allFolders.some((f) => !this.collapsed.has(f.path));
    if (anyExpanded) {
      for (const f of allFolders) this.collapsed.add(f.path);
    } else {
      this.collapsed.clear();
    }
    this.render();
  }

  /** 取当前知识库根文件夹；若未设置则提示 */
  private requireRootFolder(): TFolder | null {
    if (!this.currentPath) {
      new Notice("请先选择一个知识库");
      return null;
    }
    const folder = this.app.vault.getAbstractFileByPath(this.currentPath);
    if (!(folder instanceof TFolder)) {
      new Notice("知识库不存在");
      return null;
    }
    return folder;
  }

  /**
   * 重绘入口。手势期间的重绘请求先记账，交由 endGesture() 在手势收尾时补做，
   * 避免正在被点击的行在半途中被销毁（那会吞掉这一次点击）。
   */
  private render(): void {
    if (this.inGesture) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    this.rebuild();
  }

  /** 手势收尾：补做被推迟的重绘 */
  private endGesture(): void {
    this.inGesture = false;
    if (!this.pendingRender) return;
    this.pendingRender = false;
    this.rebuild();
  }

  private rebuild(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("kb-tree-container");

    if (!this.currentPath) {
      container.createDiv({
        cls: "kb-tree-empty",
        text: "从知识库列表中选择一个知识库",
      });
      return;
    }

    const folder = this.app.vault.getAbstractFileByPath(this.currentPath);
    if (!(folder instanceof TFolder)) {
      container.createDiv({ cls: "kb-tree-empty", text: "知识库不存在" });
      return;
    }

    // 每次重绘新建的宿主：拖拽监听挂在它上面，重绘后随旧 DOM 一起消失，不会叠监听
    const host = container.createDiv({ cls: "kb-tree-host" });

    // 顶部：返回 + 库名 + 工具按钮
    const header = host.createDiv({ cls: "kb-tree-header nav-header" });

    const back = header.createEl("span", { cls: "kb-tree-back", text: "← 全部知识库" });
    back.onclick = () => this.plugin.openKbHome();

    const titleRow = header.createDiv({ cls: "kb-tree-title-row" });
    const title = titleRow.createEl("div", { cls: "kb-tree-title", text: folder.name });
    // 库根标题行同时是拖拽放置目标：条目才拖得回库根（否则只能拖进子文件夹，出不来）
    title.dataset.path = folder.path;
    title.setAttr("title", `拖到这里 → 移回「${folder.name}」根目录`);
    // 工具按钮排在标题行右侧（与原生文件浏览器一致）
    this.renderToolbar(titleRow);

    // 树主体：带上原生的 nav-files-container，滚动条与内边距走原生那一套
    const tree = host.createDiv({ cls: "kb-tree-body nav-files-container" });
    this.attachTreeDrag(host);
    this.renderChildren(tree, folder);

    // 空白区域右键：针对知识库根目录
    tree.addEventListener("contextmenu", (e) => {
      if (e.target === tree) {
        e.preventDefault();
        this.showFolderMenu(e, folder);
      }
    });
  }

  /** 是否置顶（与原生文件浏览器共用 order.items[path].isPinned 这一个标记） */
  private isPinned(path: string): boolean {
    return !!this.plugin.settings.order.items[path]?.isPinned;
  }

  /** 置顶图钉：与原生树右侧那枚同一个结构、同一份 CSS */
  private mountPin(rowSelf: HTMLElement, path: string): void {
    if (!this.isPinned(path)) return;
    const indicator = rowSelf.createDiv({ cls: "kb-indicator" });
    setIcon(indicator.createDiv({ cls: "kb-pin-indicator" }), "pin");
  }

  /** 某文件夹下参与树展示的直接子项：只含文件夹与 .md（隐藏项照样渲染，靠 .kb-hidden 控制显隐） */
  private folderEntries(folder: TFolder): TAbstractFile[] {
    return folder.children.filter(
      (c) => c instanceof TFolder || (c instanceof TFile && c.extension === "md")
    );
  }

  /**
   * 某文件夹下子项的显示顺序：直接调用与原生文件浏览器同一套排序器
   * （OrderManager.getSortedItems：置顶优先 → 该文件夹自己的 sortOrder → customOrder）。
   */
  private sortEntries(children: TAbstractFile[], parentPath: string): TAbstractFile[] {
    const engine = this.plugin.sortFeature;
    // sort 功能若装配失败（底座按功能隔离故障），这里退回按名称排，树照样能用
    if (!engine) return children.slice().sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return engine.orderManager
      .getSortedItems(engine.ensureFolderSettings(parentPath), children.map((file) => ({ file })))
      .map((i) => i.file);
  }

  private renderChildren(parent: HTMLElement, folder: TFolder): void {
    const ordered = this.sortEntries(this.folderEntries(folder), folder.path);
    for (const child of ordered) {
      if (child instanceof TFolder) {
        this.renderFolder(parent, child);
      } else if (child instanceof TFile) {
        this.renderFile(parent, child);
      }
    }
  }

  private renderFolder(parent: HTMLElement, folder: TFolder): void {
    const isCollapsed = this.collapsed.has(folder.path);

    const item = parent.createDiv({ cls: "tree-item nav-folder" });
    item.dataset.kind = "folder";
    if (this.plugin.isHiddenByRule(folder.path)) item.addClass("kb-hidden");

    const self = item.createDiv({
      cls: "tree-item-self nav-folder-title is-clickable mod-collapsible",
    });
    self.dataset.path = folder.path;
    self.setAttr("tabindex", "-1");
    self.setAttribute("draggable", "true");
    const collapse = self.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(collapse, "right-triangle");
    // 折叠态要同时标在条目和箭头上：app.css 的旋转动画认的是 .collapse-icon.is-collapsed
    if (isCollapsed) {
      item.addClass("is-collapsed");
      collapse.addClass("is-collapsed");
    }
    self.createDiv({ cls: "tree-item-inner nav-folder-title-content", text: folder.name });
    this.mountPin(self, folder.path);

    self.onclick = () => {
      if (isCollapsed) this.collapsed.delete(folder.path);
      else this.collapsed.add(folder.path);
      this.render();
    };

    // 右键菜单
    self.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showFolderMenu(e as MouseEvent, folder);
    });

    if (!isCollapsed) {
      const sub = item.createDiv({ cls: "tree-item-children nav-folder-children" });
      this.renderChildren(sub, folder);
    }
  }

  /** 文件行：与原生一致，只有文件名，不加图标 */
  private renderFile(parent: HTMLElement, file: TFile): void {
    const item = parent.createDiv({ cls: "tree-item nav-file" });
    item.dataset.kind = "file";
    item.setAttribute("draggable", "true");
    if (this.plugin.isHiddenByRule(file.path)) item.addClass("kb-hidden");

    const self = item.createDiv({
      cls: "tree-item-self nav-file-title tappable is-clickable",
    });
    self.dataset.path = file.path;
    self.setAttr("tabindex", "-1");
    self.setAttribute("draggable", "true");
    self.createDiv({ cls: "tree-item-inner nav-file-title-content", text: file.basename });
    this.mountPin(self, file.path);

    const active = this.app.workspace.getActiveFile();
    if (active && active.path === file.path) self.addClass("is-active");

    // 单击打开；按住 Ctrl/Cmd 或中键时与原生一样开到新标签页
    self.addEventListener("click", (e) => {
      // 只响应左键单击
      if (e.button !== 0) return;
      const f = this.app.vault.getAbstractFileByPath(file.path);
      if (!(f instanceof TFile)) return;
      if (e.ctrlKey || e.metaKey) {
        void this.app.workspace.getLeaf("tab").openFile(f);
        return;
      }
      void this.plugin.openNote(f);
    });
    self.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      const f = this.app.vault.getAbstractFileByPath(file.path);
      if (f instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(f);
    });

    // 右键菜单
    self.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showFileMenu(e as MouseEvent, file);
    });
  }

  // ============================================================
  // 拖拽排序
  // ============================================================

  /**
   * 在整个树主体上挂一次拖拽监听（事件委托，重绘后无需重挂）。
   * 指示属性与原生树共用同一套词汇（data-kb-drop-sibling / data-kb-drop-folder /
   * is-being-dragged），所以两棵树的拖拽反馈长得一样，CSS 也只有一份。
   */
  private attachTreeDrag(host: HTMLElement): void {
    host.addEventListener("dragstart", (e) => {
      const hit = this.findDropTarget(e.target);
      if (!hit) return;

      this.dragPath = hit.path;
      hit.self.addClass("is-being-dragged");
      document.body.addClass("kb-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", hit.path);
      }
    });

    host.addEventListener("dragover", (e) => {
      if (!this.dragPath) return;
      const hit = this.findDropTarget(e.target);
      // 拖到空白处不处理（交给 drop 做无操作）
      if (!hit) return;

      const path = hit.path;
      if (path === this.dragPath) return;
      // 不允许拖进自己的子孙文件夹
      if (path.startsWith(this.dragPath + "/")) return;

      // 阻止原生行为，才能触发 drop
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

      const side = this.resolveDropSide(e, hit);
      this.markDropTarget(hit.item, side);
      this.scheduleExpand(hit, side);
    });

    host.addEventListener("dragleave", (e) => {
      // 只在真正离开树主体时清干净
      if (!host.contains(e.relatedTarget as Node)) this.clearDropMarks();
    });

    host.addEventListener("drop", (e) => {
      const hit = this.findDropTarget(e.target);
      const from = this.dragPath;
      this.clearDropMarks();
      this.cancelExpand();
      if (!from || !hit) return;

      const toPath = hit.path;
      if (toPath === from) return;
      if (toPath.startsWith(from + "/")) return;

      e.preventDefault();
      void this.handleDrop(from, toPath, this.resolveDropSide(e, hit));
    });

    host.addEventListener("dragend", () => {
      this.dragPath = null;
      this.cancelExpand();
      document.body.removeClass("kb-dragging");
      host.querySelectorAll<HTMLElement>(".is-being-dragged").forEach((el) =>
        el.removeClass("is-being-dragged")
      );
      this.clearDropMarks();
    });
  }

  /** 命中落点：item = 挂指示属性的 .tree-item，self = 量位置的行，path 在 self 上（与原生一致） */
  private findDropTarget(
    target: EventTarget | null
  ): { item: HTMLElement; self: HTMLElement; path: string; isRoot: boolean } | null {
    if (!(target instanceof HTMLElement)) return null;
    // 库根标题行也是一个放置目标：不然条目只能拖进子文件夹，拖不回来
    const rootRow = target.closest<HTMLElement>(".kb-tree-title");
    if (rootRow?.dataset.path)
      return { item: rootRow, self: rootRow, path: rootRow.dataset.path, isRoot: true };
    const self =
      target.closest<HTMLElement>(".tree-item-self") ??
      (target.matches(".tree-item")
        ? target.querySelector<HTMLElement>(":scope > .tree-item-self")
        : null);
    const item = self?.closest<HTMLElement>(".tree-item");
    if (!self?.dataset.path || !item) return null;
    return { item, self, path: self.dataset.path, isRoot: false };
  }

  /**
   * 判断落点类型（与原生一致）：
   * - 库根标题行 → 移入库根
   * - 落在文件夹行的上 1/4 / 下 1/4 → 排到该文件夹前 / 后
   * - 落在文件夹行中间 → 移入该文件夹
   * - 落在文件行的上/下半 → 排到该文件前 / 后
   */
  private resolveDropSide(
    e: DragEvent,
    hit: { item: HTMLElement; self: HTMLElement; isRoot: boolean }
  ): DropSide {
    if (hit.isRoot) return "inside";
    const rect = hit.self.getBoundingClientRect();
    const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    if (hit.item.dataset.kind !== "folder") return ratio < 0.5 ? "before" : "after";
    if (ratio < 0.25) return "before";
    if (ratio > 0.75) return "after";
    return "inside";
  }

  /** 给落点加视觉指示（原生树那套：放置线 / 移入底色） */
  private markDropTarget(item: HTMLElement, side: DropSide): void {
    if (this.lastDropEl === item && this.dropSide === side) return;
    this.clearDropMarks();
    this.lastDropEl = item;
    this.dropSide = side;
    if (side === "inside") item.dataset.kbDropFolder = "";
    else item.dataset.kbDropSibling = side;
  }

  private clearDropMarks(): void {
    this.containerEl
      .querySelectorAll<HTMLElement>("[data-kb-drop-sibling],[data-kb-drop-folder]")
      .forEach((el) => {
        delete el.dataset.kbDropSibling;
        delete el.dataset.kbDropFolder;
      });
    this.lastDropEl = null;
  }

  /** 悬停在折叠文件夹正中 → 停一会儿自动展开，好把条目拖进更深层（同原生） */
  private scheduleExpand(hit: { path: string; isRoot: boolean }, side: DropSide): void {
    const path = side === "inside" && !hit.isRoot ? hit.path : null;
    if (path === this.expandPath) return;
    this.cancelExpand();
    this.expandPath = path;
    if (!path || !this.collapsed.has(path)) return;
    this.expandTimer = window.setTimeout(() => {
      this.expandPath = null;
      this.expandInPlace(path);
    }, EXPAND_DELAY_MS);
  }

  private cancelExpand(): void {
    window.clearTimeout(this.expandTimer);
    this.expandTimer = 0;
    this.expandPath = null;
  }

  /**
   * 就地展开某个文件夹。
   * 拖拽进行中不能整棵树重绘：那会把正在拖的源节点连监听一起拆掉，这次拖拽就废了。
   */
  private expandInPlace(path: string): void {
    const self = this.containerEl.querySelector<HTMLElement>(
      `.kb-tree-body .nav-folder-title[data-path="${path}"]`
    );
    const item = self?.closest<HTMLElement>(".tree-item");
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!item || !(folder instanceof TFolder)) return;
    this.collapsed.delete(path);
    item.removeClass("is-collapsed");
    item.querySelector<HTMLElement>(":scope > .nav-folder-title > .collapse-icon")?.removeClass(
      "is-collapsed"
    );
    const sub = item.querySelector<HTMLElement>(":scope > .nav-folder-children") ??
      item.createDiv({ cls: "tree-item-children nav-folder-children" });
    sub.empty();
    this.renderChildren(sub, folder);
  }

  /**
   * 执行落点操作。语义与原生文件树一致：
   * - 落在文件夹行正中 → 移入该文件夹
   * - 落在别的条目上/下沿 → 移进「该条目所在的文件夹」并插到那个位置（这就是跨文件夹）
   * - 落在库根标题上 → 移回知识库根目录
   * 落在哪一层都只动「目标文件夹」的顺序：只要给出的是条目上/下沿（同层换位或跨文件夹），
   * 就把目标文件夹切成自定义顺序；落在文件夹行正中（单纯移入）不改任何排序方式。
   */
  private async handleDrop(from: string, toPath: string, side: DropSide): Promise<void> {
    const fromFile = this.app.vault.getAbstractFileByPath(from);
    const toFile = this.app.vault.getAbstractFileByPath(toPath);
    if (!fromFile || !toFile) return;

    // 落点归属的文件夹：正中＝该文件夹本身；上/下沿＝落点项的父目录
    const dest =
      side === "inside" ? (toFile instanceof TFolder ? toFile : null) : toFile.parent;
    if (!dest) return;

    const moving = dest.path !== (fromFile.parent?.path ?? "");
    if (side === "inside" && !moving) return; // 本来就在这个文件夹里

    // 改名会就地改掉 fromFile.path，旧路径要先留住给 OrderManager
    const oldPath = fromFile.path;
    let newPath = oldPath;
    if (moving) {
      newPath = this.availablePath(fromFile, dest);
      try {
        await this.app.fileManager.renameFile(fromFile, newPath);
      } catch (err) {
        new Notice("移动失败：" + String(err));
        return;
      }
      // 展开目标文件夹，让用户直接看到东西搬过去了
      this.collapsed.delete(dest.path);
    }

    // 顺序写进与原生树同一份存储：order.items[父].customOrder（OrderManager 顺手落盘并重排原生树）
    const engine = this.plugin.sortFeature;
    if (engine) {
      // OrderManager.move 对"还没有设置条目"的路径会直接跳过；启动静默期里新建的文件
      // 就可能没条目（原生树那边靠 syncItems 补，而它只在文件浏览器挂载时跑）。
      // 要按「移动之后」的路径补：跨文件夹时旧路径已经不存在了，按旧路径补出来的是死键上的裸条目。
      engine.ensureItemSettings(this.app.vault.getAbstractFileByPath(newPath) ?? fromFile);
      const destOrder = engine.ensureFolderSettings(dest.path);
      // 落在某条目的上/下沿就是手动排序的意图，跨文件夹也不例外：目标文件夹得切成自定义顺序，
      // 否则显示仍按名称/时间排，刚写进去的落点不会被认（实测就是「拖过去总排在最上面」）。
      // 翻转前先按「当前显示次序」把 customOrder 灌满——直接转会拿陈旧、残缺的顺序表去显示，整层跟着跳位。
      if (side !== "inside" && destOrder.sortOrder !== "custom") {
        destOrder.customOrder = engine.orderManager
          .getSortedItems(destOrder, dest.children.map((file) => ({ file })))
          .map((entry) => entry.file.name);
        destOrder.sortOrder = "custom";
      }
      engine.orderManager.move(
        oldPath,
        newPath,
        side === "inside" ? undefined : toFile.path,
        side === "inside" ? undefined : side
      );
    }
    this.render();
  }

  /** 目标处已有同名项时像原生一样自动避让改名（xx → xx 1），而不是拒绝这次移动 */
  private availablePath(item: TAbstractFile, destFolder: TFolder): string {
    const target = `${destFolder.path}/${item.name}`;
    const vault = this.app.vault as any;
    const clash =
      (typeof vault.getAbstractFileByPathInsensitive === "function"
        ? vault.getAbstractFileByPathInsensitive(target)
        : null) ?? vault.getAbstractFileByPath(target);
    if (!clash) return target;
    if (item instanceof TFile) {
      return vault.getAvailablePath(target.slice(0, -(item.extension.length + 1)), item.extension);
    }
    return vault.getAvailablePath(target, "");
  }

  // ============================================================
  // 右键菜单
  // ============================================================

  /** 文件夹右键菜单 */
  private showFolderMenu(e: MouseEvent, folder: TFolder): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("新建笔记")
        .setIcon("document")
        .onClick(() => void this.createNoteIn(folder))
    );

    menu.addItem((item) =>
      item
        .setTitle("新建文件夹")
        .setIcon("folder")
        .onClick(() => {
          this.plugin.showInputModal("新建文件夹", `在「${folder.name}」下新建文件夹`, "", async (name) => {
            if (!name?.trim()) return;
            const path = `${folder.path}/${name.trim()}`;
            if (this.app.vault.getAbstractFileByPath(path)) {
              new Notice(`已存在：${path}`);
              return;
            }
            await this.app.vault.createFolder(path);
          });
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("重命名")
        .setIcon("pencil")
        .onClick(async () => {
          const newName = await this.plugin.promptText("重命名文件夹", "输入新名称", folder.name);
          if (!newName?.trim() || newName.trim() === folder.name) return;
          const parentPath = folder.parent ? folder.parent.path : "";
          const newPath = parentPath ? `${parentPath}/${newName.trim()}` : newName.trim();
          if (this.app.vault.getAbstractFileByPath(newPath)) {
            new Notice(`已存在：${newPath}`);
            return;
          }
          // 路径同步由插件的 rename 事件统一处理（currentPath 也会跟着走）
          await this.app.fileManager.renameFile(folder, newPath);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("删除")
        .setIcon("trash")
        .onClick(() => {
          const count = this.countFiles(folder);
          this.plugin.confirmModal(
            "删除文件夹",
            `确定删除「${folder.name}」及其中的 ${count} 个文件吗？此操作不可撤销。`,
            async () => {
              await this.app.vault.delete(folder, true);
              if (this.currentPath === folder.path) {
                this.currentPath = null;
                this.render();
              }
            }
          );
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("在系统资源管理器中显示")
        .setIcon("folder-open")
        .onClick(() => this.revealInOS(folder))
    );

    menu.addItem((item) =>
      item
        .setTitle("复制路径")
        .setIcon("copy")
        .onClick(async () => {
          await navigator.clipboard.writeText(folder.path);
          new Notice("已复制路径");
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle(this.collapsed.has(folder.path) ? "展开此文件夹" : "折叠此文件夹")
        .setIcon("chevrons-up-down")
        .onClick(() => {
          // 折叠/展开当前文件夹下的所有层级
          const path = folder.path;
          if (this.collapsed.has(path)) {
            this.collapsed.delete(path);
          } else {
            this.collapsed.add(path);
          }
          this.render();
        })
    );

    // 置顶 / 隐藏 / 排序方式（与本插件的原生树同一套逻辑，直接调用不走全局广播）
    this.plugin.sortFeature?.addFileMenuItems(menu, folder);

    menu.showAtMouseEvent(e);
  }

  /** 文件右键菜单 */
  private showFileMenu(e: MouseEvent, file: TFile): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("打开")
        .setIcon("file-text")
        .onClick(() => this.plugin.openNote(file))
    );

    menu.addItem((item) =>
      item
        .setTitle("在新标签页打开")
        .setIcon("file-plus")
        .onClick(async () => {
          const leaf = this.app.workspace.getLeaf("tab");
          await leaf.openFile(file);
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("重命名")
        .setIcon("pencil")
        .onClick(async () => {
          const newName = await this.plugin.promptText("重命名笔记", "输入新名称", file.basename);
          if (!newName?.trim() || newName.trim() === file.basename) return;
          const parentPath = file.parent ? file.parent.path : "";
          const newPath = parentPath
            ? `${parentPath}/${newName.trim()}.md`
            : `${newName.trim()}.md`;
          if (this.app.vault.getAbstractFileByPath(newPath)) {
            new Notice(`已存在：${newPath}`);
            return;
          }
          await this.app.fileManager.renameFile(file, newPath);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("删除")
        .setIcon("trash")
        .onClick(() => {
          this.plugin.confirmModal(
            "删除笔记",
            `确定删除「${file.basename}」吗？此操作不可撤销。`,
            async () => {
              // 优先走系统回收站
              await this.app.fileManager.trashFile(file);
            }
          );
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("在系统资源管理器中显示")
        .setIcon("folder-open")
        .onClick(() => this.revealInOS(file))
    );

    menu.addItem((item) =>
      item
        .setTitle("复制路径")
        .setIcon("copy")
        .onClick(async () => {
          await navigator.clipboard.writeText(file.path);
          new Notice("已复制路径");
        })
    );

    // 置顶 / 隐藏（与原生树同一套逻辑，直接调用不走全局广播）
    this.plugin.sortFeature?.addFileMenuItems(menu, file);

    menu.showAtMouseEvent(e);
  }

  /** 在系统资源管理器中定位文件/文件夹 */
  private revealInOS(target: TAbstractFile): void {
    const adapter: any = this.app.vault.adapter;
    if (adapter && typeof adapter.getFullPath === "function") {
      const full: string = adapter.getFullPath(target.path);
      try {
        const electron = (window as any).require?.("electron");
        if (electron?.shell?.showItemInFolder) {
          electron.shell.showItemInFolder(full);
        } else if (electron?.shell?.openPath) {
          electron.shell.openPath(full);
        } else {
          new Notice("当前环境不支持在资源管理器中打开");
        }
      } catch (err) {
        new Notice("打开失败：" + String(err));
      }
    }
  }

  /** 统计文件夹内文件数 */
  private countFiles(folder: TFolder): number {
    let n = 0;
    const walk = (f: TFolder) => {
      for (const c of f.children) {
        if (c instanceof TFolder) walk(c);
        else n++;
      }
    };
    walk(folder);
    return n;
  }
}
