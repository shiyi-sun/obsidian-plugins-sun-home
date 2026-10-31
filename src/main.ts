import {
  Plugin,
  WorkspaceLeaf,
  TFile,
  TFolder,
  TAbstractFile,
  Modal,
  App,
  Setting,
  Notice,
  PluginSettingTab,
} from "obsidian";
import { KbHomeView, VIEW_TYPE_KB_HOME } from "./view-home";
import { KbTreeView, VIEW_TYPE_KB_TREE } from "./view-tree";
import {
  KbSettings,
  CardStyle,
  DEFAULT_SETTINGS,
  KnowledgeBase,
  KnowledgeGroup,
  scanKnowledgeBases,
  findGroupOf,
  reconcileGroupOrders,
  migrateSettingsPaths,
  dissolveGroup as dissolveGroupOnDisk,
  DissolveResult,
  createGroupFolder,
  getFolder,
  pathExists,
  safeFolderName,
  uniquePath,
  genGroupId,
  joinPath,
  baseNameOf,
} from "./data";
import { SortFeature } from "./core/sort-feature";
import { FeatureRegistry, featureContext } from "./framework/feature";
import { AdmonitionFeature, DEFAULT_ADMONITION } from "./features/admonition";
import { SortOrderFeature } from "./features/sort-order";
import { revealInSystem } from "./system";

export default class KbHomePlugin extends Plugin {
  settings: KbSettings;
  /** 附加功能底座：装配期钩子 + 逐个故障隔离 */
  features: FeatureRegistry;
  /** 工作区就绪后要跑的装配期回调（功能用 ctx.onLayoutReady 排进来） */
  private layoutReadyQueue: (() => void)[] = [];
  /** 设置面板实例，供功能改完设置后重绘自己那一节 */
  private settingTab?: PluginSettingTab;

  /**
   * 排序 / 置顶 / 隐藏 引擎。它现在是 Feature（SortOrderFeature），
   * 这里只留一个类型化出口：知识库树的右键菜单要借它往菜单里注入排序项。
   * 核心视图依赖一个功能是可以的，反过来（功能伸进核心视图内部）才要避免。
   */
  get sortFeature(): SortFeature | undefined {
    return (this.features?.get("sort") as SortOrderFeature | undefined)?.engine ?? undefined;
  }

  /** 是否应从列表里彻底不出现（卡片墙用；与原生树共用同一套隐藏规则与开关） */
  isHiddenForList = (path: string): boolean =>
    this.sortFeature?.isHiddenForList(path) ?? false;

  /** 隐藏规则是否命中（树里的条目据此挂 .kb-hidden，淡化还是隐藏交给 CSS） */
  isHiddenByRule(path: string): boolean {
    return this.sortFeature?.isHiddenByRule(path) ?? false;
  }

  /** 隐藏 / 取消隐藏一个条目：改的就是原生树那个 isHidden，两边同步生效 */
  async setItemHidden(path: string, hidden: boolean): Promise<void> {
    const item = this.settings.order.items[path];
    if (item) item.isHidden = hidden;
    else this.settings.order.items[path] = { isPinned: false, isHidden: hidden };
    await this.saveSettingsNow();
    this.sortFeature?.syncIndicators();
    this.refreshViews();
  }

  // ============ 分组（真实文件夹） ============

  /** 新建分组：在 vault 根目录创建真实文件夹 */
  async createGroup(name: string): Promise<KnowledgeGroup> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("名称不能为空");
    const settings = this.settings;

    const path = await createGroupFolder(this.app, trimmed);
    const group: KnowledgeGroup = {
      id: genGroupId(),
      name: baseNameOf(path),
      path,
      order: [],
    };
    settings.groups.push(group);
    reconcileGroupOrders(this.app, settings);
    await this.saveSettingsNow();
    this.refreshViews();
    return group;
  }

  /** 重命名分组：文件夹一起改名 */
  async renameGroup(group: KnowledgeGroup, rawName: string): Promise<void> {
    const name = rawName.trim();
    if (!name) throw new Error("名称不能为空");
    const settings = this.settings;

    const folder = getFolder(this.app, group.path);
    if (!folder) throw new Error("分组文件夹不存在");
    const oldPath = folder.path;
    const target = joinPath("/", safeFolderName(name));
    if (target === oldPath) return;
    if (pathExists(this.app, target)) throw new Error(`已存在同名文件夹：${target}`);

    await this.app.fileManager.renameFile(folder, target);
    migrateSettingsPaths(settings, oldPath, target);
    reconcileGroupOrders(this.app, settings);
    this.notifyTreePathRenamed(oldPath, target);
    await this.saveSettingsNow();
    this.refreshViews();
  }

  /** 删除分组：组内知识库移回根目录，再删除空文件夹 */
  async dissolveGroup(group: KnowledgeGroup): Promise<DissolveResult> {
    const settings = this.settings;
    const result = await dissolveGroupOnDisk(this.app, settings, group);
    await this.saveSettingsNow();
    this.refreshViews();
    this.settingTab?.display();
    return result;
  }

  /**
   * 把知识库移入某个分组（groupId=null 表示移回根目录，即未分组）。
   * 分组都是真实文件夹，操作会真实移动文件夹；返回移动后的路径。
   */
  async moveKbToGroup(kbPath: string, groupId: string | null): Promise<string> {
    const settings = this.settings;
    const currentId = findGroupOf(settings, kbPath);
    if (currentId === groupId) return kbPath;

    const target = groupId ? settings.groups.find((g) => g.id === groupId) : null;
    if (groupId && !target) return kbPath;

    const source = getFolder(this.app, kbPath);
    if (!source) {
      new Notice("知识库文件夹不存在");
      return kbPath;
    }

    let parentPath = "/";
    if (target) {
      const targetFolder = getFolder(this.app, target.path);
      if (!targetFolder) {
        new Notice("目标分组文件夹不存在");
        return kbPath;
      }
      parentPath = targetFolder.path;
    }
    if ((source.parent?.path ?? "/") === parentPath) return kbPath;

    const newPath = uniquePath(this.app, parentPath, source.name);
    try {
      await this.app.fileManager.renameFile(source, newPath);
    } catch (err) {
      new Notice("移动失败：" + String(err));
      return kbPath;
    }

    migrateSettingsPaths(settings, kbPath, newPath);
    reconcileGroupOrders(this.app, settings);
    this.notifyTreePathRenamed(kbPath, newPath);
    await this.saveSettingsNow();
    this.refreshViews();
    return newPath;
  }

  /** 文件夹改名 / 移动后，单库树当前路径跟着走 */
  private notifyTreePathRenamed(oldPath: string, newPath: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KB_TREE)) {
      (leaf.view as KbTreeView).handlePathRenamed?.(oldPath, newPath);
    }
  }

  private handleVaultRename(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFolder) {
      const changed = migrateSettingsPaths(this.settings, oldPath, file.path);
      const reconciled = reconcileGroupOrders(this.app, this.settings);
      if (changed || reconciled) this.saveSettingsDebounced();
      this.notifyTreePathRenamed(oldPath, file.path);
    }
    this.refreshViews();
  }

  private handleStructureChange(): void {
    if (reconcileGroupOrders(this.app, this.settings)) this.saveSettingsDebounced();
    this.refreshViews();
  }

  async onload() {
    await this.loadSettings();
    // 外部新增/移动/删除文件夹后，组内与未分组排序跟文件系统对齐
    if (reconcileGroupOrders(this.app, this.settings)) void this.persist();

    this.features = new FeatureRegistry(
      [new SortOrderFeature(), new AdmonitionFeature()],
      featureContext(this, {
        app: this.app,
        settings: () => this.settings,
        save: () => this.saveSettingsNow(),
        saveDebounced: () => this.saveSettingsDebounced(),
        refreshViews: () => this.refreshViews(),
        rerenderSettings: () => this.settingTab?.display(),
        onLayoutReady: (cb) => this.layoutReadyQueue.push(cb),
      })
    );
    // 必须在 onload 期间装配：register* 只有这时候调用，Obsidian 才会在卸载时回收
    this.features.attachAll();

    // 注册两个视图
    this.registerView(VIEW_TYPE_KB_HOME, (leaf) => new KbHomeView(leaf, this));
    this.registerView(VIEW_TYPE_KB_TREE, (leaf) => new KbTreeView(leaf, this));

    // 左侧 ribbon 图标：打开知识库列表
    this.addRibbonIcon("library", "打开知识库列表", () => {
      void this.openKbHome();
    });
    this.addRibbonIcon("folder-tree", "打开当前知识库目录", () => {
      void this.openTreeForActive();
    });

    // 命令
    this.addCommand({
      id: "open-kb-home",
      name: "打开知识库列表",
      callback: () => void this.openKbHome(),
    });
    this.addCommand({
      id: "open-kb-tree-active",
      name: "打开当前笔记所在知识库的目录",
      callback: () => void this.openTreeForActive(),
    });
    // 「显示 / 隐藏被隐藏的文件」命令属于排序功能，由 SortOrderFeature 自己注册

    // 设置面板
    this.settingTab = new KbSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // vault 结构变化时刷新；文件夹改名/移动还要把按路径存的状态一起搬走
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFolder) this.handleStructureChange();
        else this.refreshViews();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFolder) this.handleStructureChange();
        else this.refreshViews();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.handleVaultRename(file, oldPath))
    );

    // 启动时自动打开卡片页；功能排在 layout-ready 之后的装配也在这里跑
    // （文件浏览器要到 workspace 就绪才挂载，patch 才有对象可打）
    this.app.workspace.onLayoutReady(() => {
      const pending = this.layoutReadyQueue;
      this.layoutReadyQueue = [];
      for (const cb of pending) {
        try {
          cb();
        } catch (err) {
          console.error("[sun-home] 功能的 layout-ready 装配失败：", err);
        }
      }
      try {
        if (this.settings.openOnStartup) {
          void this.openKbHome();
        }
      } catch (err) {
        console.error("[sun-home] 启动时打开知识库列表失败：", err);
      }
    });
  }

  onunload(): void {
    // 卸载时把我们的视图从工作区摘除。
    // 视图由 registerView 注册，正常情况下 Obsidian 会自动处理；
    // 这里保留 detach 是为了「用户手动禁用插件」时立刻清掉面板。
    // 注意：全部包在 try/catch 内，且不在 app 关闭流程里抛错。
    try {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_KB_HOME);
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_KB_TREE);
    } catch (err) {
      console.error("[sun-home] 卸载时清理视图失败：", err);
    }

    // 各功能的显式清理（排序引擎的 patch/监听/残留 DOM 在 SortOrderFeature.detach 里；
    // register* 登记的东西由 Obsidian 回收）
    try {
      this.features?.detachAll();
    } catch (err) {
      console.error("[sun-home] 卸载附加功能失败：", err);
    }

    // 冲刷挂起的防抖保存，避免丢数据
    try {
      this.flushPendingSave();
    } catch (err) {
      console.error("[sun-home] 卸载时保存设置失败：", err);
    }
  }

  // ============ 视图控制 ============

  /** 在主区域打开知识库列表页（若已存在则切回） */
  async openKbHome(): Promise<void> {
    try {
      const { workspace } = this.app;

      // 已经开过卡片页 → 直接把它切到前台（不能只 reveal，否则要点两次）
      const leaves = workspace.getLeavesOfType(VIEW_TYPE_KB_HOME);
      if (leaves.length > 0) {
        const leaf = leaves[0];
        workspace.setActiveLeaf(leaf, { focus: true });
        void workspace.revealLeaf(leaf);
        (leaf.view as KbHomeView)?.refresh?.();
        return;
      }

      // 复用当前空白的中心 leaf，避免堆积新标签页
      let leaf: WorkspaceLeaf | null = null;
      const recent = workspace.getMostRecentLeaf
        ? (workspace.getMostRecentLeaf() as WorkspaceLeaf | null)
        : null;
      if (recent && recent.getViewState().type === "empty") {
        leaf = recent;
      } else {
        leaf = workspace.getLeaf(true);
      }
      if (!leaf) return;

      await leaf.setViewState({ type: VIEW_TYPE_KB_HOME, active: true });
      workspace.setActiveLeaf(leaf, { focus: true });
      void workspace.revealLeaf(leaf);
    } catch (err) {
      console.error("[sun-home] 打开知识库列表失败：", err);
    }
  }

  /** 点卡片：左侧栏显示该库的单库树 */
  async openKbTree(kb: KnowledgeBase): Promise<void> {
    try {
      const { workspace } = this.app;

      let leaf: WorkspaceLeaf | null = null;
      const leaves = workspace.getLeavesOfType(VIEW_TYPE_KB_TREE);
      if (leaves.length > 0) {
        leaf = leaves[0];
      } else {
        leaf = workspace.getLeftLeaf(false);
      }
      if (!leaf) return;

      await leaf.setViewState({ type: VIEW_TYPE_KB_TREE, active: true });
      const view = leaf.view as KbTreeView;
      if (view instanceof KbTreeView) {
        view.showKb(kb.path);
      }
      void workspace.revealLeaf(leaf);
    } catch (err) {
      console.error("[sun-home] 打开知识库目录失败：", err);
    }
  }

  /** 打开某篇笔记 */
  async openNote(file: TFile): Promise<void> {
    // 用 Obsidian 标准 API 打开，行为与点击原生文件树条目一致（单击即开、复用当前标签页）。
    // 不走 getLeaf(false)+openFile()，避免在某些焦点状态下需要点两次才生效。
    await this.app.workspace.openLinkText(file.path, "", false);
    // 更新树内高亮（只切 class，不重建 DOM，避免打断点击事件）
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KB_TREE)) {
      (leaf.view as KbTreeView).updateActiveHighlight?.();
    }
  }

  /** 根据当前活动文件推断所属知识库并打开树 */
  async openTreeForActive(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (!active) {
      new Notice("当前没有打开的笔记");
      return;
    }
    const kbs = scanKnowledgeBases(this.app, this.settings, this.isHiddenForList);
    // 知识库现在可能是二级文件夹；取最长的匹配路径
    const matched = kbs
      .filter((k) => active.path === k.path || active.path.startsWith(k.path + "/"))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (matched) {
      await this.openKbTree(matched);
      return;
    }

    // 笔记不在任何知识库里（例如直接放在分组文件夹下）：退回顶层文件夹
    const top = active.path.split("/")[0];
    if (!top) return;
    await this.openKbTree({
      path: top,
      name: top,
      docCount: 0,
      groupId: findGroupOf(this.settings, top),
    });
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KB_HOME)) {
      (leaf.view as KbHomeView).refresh?.();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KB_TREE)) {
      (leaf.view as KbTreeView).refresh?.();
    }
  }

  // ============ 设置读写 ============

  async loadSettings() {
    const loaded = (await this.loadData()) as Record<string, unknown> | null;

    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    // 兼容旧数据
    if (!["border", "gray", "divider"].includes(this.settings.cardStyle)) {
      this.settings.cardStyle = DEFAULT_SETTINGS.cardStyle;
    }
    if (!Array.isArray(this.settings.groups)) this.settings.groups = [];
    if (!this.settings.overrides) this.settings.overrides = {};
    if (!Array.isArray(this.settings.ungroupedOrder)) this.settings.ungroupedOrder = [];
    const groupCount = this.settings.groups.length;
    this.settings.groups = this.settings.groups.filter((group) => {
      if (!group || typeof group !== "object") return false;
      if (!group.id) group.id = genGroupId();
      if (typeof group.name !== "string" || !group.name) group.name = "未命名分组";
      if (!Array.isArray(group.order)) group.order = [];
      return typeof group.path === "string" && group.path.length > 0;
    });
    if (this.settings.groups.length !== groupCount) {
      console.warn("[sun-home] 已忽略没有真实文件夹路径的旧分组定义");
    }
    // 合并排序特性默认值（旧版本没有 order 字段）
    // ⚠️ 深拷贝 items / hidePatterns：避免与 DEFAULT_SETTINGS.order 共享同一对象，
    // 否则写入会污染全局默认值，导致下次加载带上残留数据。
    const persistedOrder = this.settings.order || {};
    this.settings.order = {
      ...DEFAULT_SETTINGS.order,
      ...persistedOrder,
      items: { ...(this.settings.order?.items || {}) },
      hidePatterns: [...(this.settings.order?.hidePatterns || [])],
    } as typeof DEFAULT_SETTINGS.order;
    if (!this.settings.order.items) this.settings.order.items = {};
    if (!Array.isArray(this.settings.order.hidePatterns)) this.settings.order.hidePatterns = [];
    // 提示块开关（新增字段，data.json 里可能还没有）
    this.settings.admonition = {
      ...DEFAULT_ADMONITION,
      ...(this.settings.admonition || {}),
    };
  }

  /**
   * 统一的落盘入口。所有写盘都从这里走，便于集中处理（如过滤挂起的防抖保存）。
   */
  private async persist(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveSettings() {
    await this.persist();
    this.refreshViews();
  }

  /**
   * 轻量保存：只落盘，不刷新视图。
   * 用于 vault 事件（新增/重命名/删除）等高频场景 —— 这些场景下视图会由事件自身
   * 或后续操作刷新，没必要每次都重建 DOM；且连续事件会触发大量整份 JSON 写盘，
   * 是启动缓慢的主因之一。这里做 300ms 防抖合并，把连续写入压成一次。
   */
  private pendingSave: number | null = null;

  saveSettingsDebounced(): void {
    if (this.pendingSave !== null) window.clearTimeout(this.pendingSave);
    this.pendingSave = window.setTimeout(() => {
      this.pendingSave = null;
      void this.persist();
    }, 300);
  }

  /** 立即冲刷挂起的保存（卸载/退出前调用，避免丢数据） */
  flushPendingSave(): void {
    if (this.pendingSave !== null) {
      window.clearTimeout(this.pendingSave);
      this.pendingSave = null;
      void this.persist();
    }
  }

  /**
   * 立即写盘（无防抖）。用于用户显式操作：右键隐藏/置顶、切换排序方式等。
   * 这类操作后用户可能立刻退出，必须马上落盘，否则会像「隐藏状态重启后丢失」。
   */
  async saveSettingsNow(): Promise<void> {
    if (this.pendingSave !== null) {
      window.clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    await this.persist();
  }

  // ============ 通用弹窗 ============

  showInputModal(title: string, desc: string, def: string, onSubmit: (v: string) => void): void {
    new InputModal(this.app, title, desc, def, onSubmit).open();
  }

  /** Promise 版输入框：确认返回文本，取消返回 null */
  promptText(title: string, desc: string, def: string): Promise<string | null> {
    return new Promise((resolve) => {
      new InputModal(this.app, title, desc, def, (v) => resolve(v), () => resolve(null)).open();
    });
  }

  /** 确认弹窗 */
  confirmModal(title: string, desc: string, onConfirm: () => void): void {
    new ConfirmModal(this.app, title, desc, onConfirm).open();
  }

  notice(msg: string): void {
    new Notice(msg);
  }

  showKbEditModal(kb: KnowledgeBase, onDone: () => void): void {
    new KbEditModal(this.app, this, kb, onDone).open();
  }
}

// ============================================================
// 输入弹窗
// ============================================================
class InputModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private desc: string,
    private def: string,
    private onSubmit: (v: string) => void,
    private onCancel?: () => void
  ) {
    super(app);
  }

  private submitted = false;

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    if (this.desc) contentEl.createEl("p", { text: this.desc, cls: "kb-modal-desc" });

    const input = contentEl.createEl("input", {
      type: "text",
      value: this.def,
      cls: "kb-modal-input",
    });
    input.focus();
    input.select();

    const submit = () => {
      if (this.submitted) return;
      this.submitted = true;
      this.onSubmit(input.value);
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    const btns = contentEl.createDiv({ cls: "kb-modal-buttons" });
    const ok = btns.createEl("button", { text: "确定", cls: "mod-cta" });
    ok.onclick = submit;
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
  }

  onClose() {
    // 未提交且关闭（Esc / 取消 / 点遮罩）→ 触发取消
    if (!this.submitted && this.onCancel) this.onCancel();
    this.contentEl.empty();
  }
}

// ============================================================
// 确认弹窗
// ============================================================
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private desc: string,
    private onConfirm: () => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    if (this.desc) contentEl.createEl("p", { text: this.desc, cls: "kb-modal-desc" });

    const btns = contentEl.createDiv({ cls: "kb-modal-buttons" });
    const ok = btns.createEl("button", { text: "确定", cls: "mod-warning" });
    ok.onclick = () => {
      this.close();
      this.onConfirm();
    };
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ============================================================
// 知识库编辑弹窗：改名 / 改图标 / 移入分组
// ============================================================
class KbEditModal extends Modal {
  constructor(
    app: App,
    private plugin: KbHomePlugin,
    private kb: KnowledgeBase,
    private onDone: () => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `编辑知识库：${this.kb.name}` });
    const s = this.plugin.settings;

    let name = s.overrides[this.kb.path]?.name || this.kb.name;
    let icon = s.overrides[this.kb.path]?.icon || this.kb.icon || "";
    let groupId = this.kb.groupId || "";

    new Setting(contentEl).setName("显示名称").addText((t) =>
      t.setValue(name).onChange((v) => (name = v))
    );
    new Setting(contentEl)
      .setName("图标（emoji）")
      .setDesc("留空使用默认的线性书本图标")
      .addText((t) =>
        t
          .setPlaceholder("留空 = 默认图标")
          .setValue(icon)
          .onChange((v) => (icon = v))
      );
    new Setting(contentEl).setName("所属分组").addDropdown((d) => {
      d.addOption("", "（未分组）");
      for (const g of s.groups) d.addOption(g.id, g.name);
      d.setValue(groupId).onChange((v) => (groupId = v));
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("保存").setCta().onClick(async () => {
        try {
          // 先移分组（可能是真实移动文件夹），覆盖信息写到移动后的路径
          let path = this.kb.path;
          const currentGroup = findGroupOf(this.plugin.settings, path) ?? "";
          if (groupId !== currentGroup) {
            path = await this.plugin.moveKbToGroup(path, groupId || null);
          }
          this.plugin.settings.overrides[path] = {
            name,
            icon: icon.trim() || undefined,
          };
          await this.plugin.saveSettingsNow();
          this.onDone();
          this.close();
        } catch (err) {
          new Notice("保存失败：" + String(err));
        }
      })
    );

    // 打开所在文件夹
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("在系统资源管理器中打开").onClick(() => {
        if (!revealInSystem(this.app, this.kb.path, "open")) {
          new Notice("当前环境不支持打开文件夹");
        }
        this.close();
      })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ============================================================
// 设置面板
// ============================================================
class KbSettingTab extends PluginSettingTab {
  plugin: KbHomePlugin;

  constructor(app: App, plugin: KbHomePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("知识库管理设置").setHeading();

    new Setting(containerEl)
      .setName("启动时自动打开知识库列表")
      .setDesc("打开 Obsidian 时，自动在主区域展示知识库卡片墙")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.openOnStartup).onChange(async (v) => {
          this.plugin.settings.openOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("卡片样式")
      .setDesc(
        "线框：纸面底色 + 细边框；浅灰：实心灰底，库少时更成块；分隔线：去掉卡片框，只留行间细线，库多时最安静。"
      )
      .addDropdown((d) =>
        d
          .addOption("border", "线框")
          .addOption("gray", "浅灰背景")
          .addOption("divider", "分隔线")
          .setValue(this.plugin.settings.cardStyle)
          .onChange(async (v) => {
            this.plugin.settings.cardStyle = v as CardStyle;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("重新扫描知识库")
      .setDesc(
        "分组文件夹的直接子文件夹、以及根目录下未登记为分组的文件夹，都会识别为知识库；被「隐藏」规则挡掉的文件夹不计入。"
      )
      .addButton((b) =>
        b.setButtonText("刷新").onClick(async () => {
          reconcileGroupOrders(this.app, this.plugin.settings);
          const kbs = scanKnowledgeBases(this.app, this.plugin.settings, this.plugin.isHiddenForList);
          new Notice(`识别到 ${kbs.length} 个知识库`);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("分组管理").setHeading();
    containerEl.createEl("p", {
      cls: "kb-setting-hint",
      text: "分组就是 vault 根目录下的一层真实文件夹，组内知识库是它的直接子文件夹。重命名/删除分组会直接操作这个文件夹。",
    });
    if (this.plugin.settings.groups.length === 0) {
      containerEl.createEl("p", {
        cls: "kb-setting-hint",
        text: "还没有分组。在知识库列表中点「＋ 新建分组」会创建真实文件夹；在卡片上用「⋯」可以把知识库移进去。",
      });
    } else {
      for (const g of this.plugin.settings.groups) {
        const exists = !!getFolder(this.app, g.path);
        const desc = `${exists ? "文件夹" : "文件夹不存在"}：${g.path} · 包含 ${g.order.length} 个知识库`;
        new Setting(containerEl)
          .setName(g.name)
          .setDesc(desc)
          .addButton((b) =>
            b.setButtonText("删除").setWarning().onClick(() => {
              this.plugin.confirmModal(
                "删除分组",
                `确定删除分组「${g.name}」吗？组内 ${g.order.length} 个知识库会移回 vault 根目录（变成未分组），然后删除空的分组文件夹；不会删除任何笔记。`,
                async () => {
                  const result = await this.plugin.dissolveGroup(g);
                  if (result.errors.length > 0) {
                    new Notice("删除分组时出错：" + result.errors[0]);
                  }
                  this.display();
                }
              );
            })
          );
      }
    }

    // 把已有根目录文件夹登记为分组
    const groupPaths = new Set(this.plugin.settings.groups.map((g) => g.path));
    const candidates = this.app.vault
      .getRoot()
      .children.filter(
        (c): c is TFolder =>
          c instanceof TFolder && !c.name.startsWith(".") && !groupPaths.has(c.path)
      );
    if (candidates.length > 0) {
      let chosen = candidates[0].path;
      new Setting(containerEl)
        .setName("把现有文件夹设为分组")
        .setDesc("该文件夹的直接子文件夹会成为知识库；直接放在它里面的笔记不会出现在卡片墙。")
        .addDropdown((d) => {
          for (const folder of candidates) d.addOption(folder.path, folder.path);
          d.setValue(chosen).onChange((v) => (chosen = v));
        })
        .addButton((b) =>
          b.setButtonText("设为分组").onClick(() => {
            const folder = this.app.vault.getAbstractFileByPath(chosen);
            if (!(folder instanceof TFolder)) return;
            this.plugin.confirmModal(
              "设为分组",
              `把「${folder.name}」作为分组文件夹？它的直接子文件夹会变成知识库卡片，知识库内部层级不受影响。`,
              async () => {
                this.plugin.settings.groups.push({
                  id: genGroupId(),
                  name: folder.name,
                  path: folder.path,
                  order: [],
                });
                reconcileGroupOrders(this.app, this.plugin.settings);
                await this.plugin.saveSettingsNow();
                this.display();
              }
            );
          })
        );
    }

    // ============ 各功能自己的设置小节（排序与隐藏 = 第一个）============
    this.plugin.features.renderSettings(containerEl);

    // 调试日志是插件级的（logger 全局），所以留在主体而不在某个功能里
    new Setting(containerEl).setName("调试").setHeading();
    new Setting(containerEl)
      .setName("开启调试日志")
      .setDesc("在开发者控制台输出详细日志，排查问题时使用")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.order.debugMode).onChange(async (v) => {
          this.plugin.settings.order.debugMode = v;
          this.plugin.sortFeature?.setDebug(v);
          await this.plugin.saveSettings();
        })
      );
  }
}
