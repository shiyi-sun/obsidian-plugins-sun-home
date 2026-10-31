import {
  ItemView,
  WorkspaceLeaf,
  TFolder,
  TFile,
  TAbstractFile,
  Notice,
  Scope,
  setIcon,
  type ViewStateResult,
} from "obsidian";
import type KbHomePlugin from "./main";
import { KbTreeSurface } from "./tree/kb-surface";
import { TreeDndController } from "./tree/tree-dnd";
import { TreeModel } from "./tree/tree-model";
import { KbTreeRenderer } from "./tree/tree-renderer";
import { TreeSelection, startInlineRename } from "./tree/tree-interactions";
import {
  showBlankContextMenu,
  showFileContextMenu,
  showFolderContextMenu,
  showMultiContextMenu,
  type KbTreeMenuHost,
} from "./tree/tree-menu";

export const VIEW_TYPE_KB_TREE = "kb-tree-view";

const INVALID_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * 单库树视图：点卡片后，左侧栏只显示这一个知识库的内部树。
 * 结构：知识库根 → 子文件夹 → 笔记。
 *
 * 行 DOM 直接复用原生文件浏览器的类名与嵌套（.tree-item.nav-folder/.nav-file
 * > .tree-item-self > .tree-item-inner，缩进靠行内 padding），
 * 外观交给 app.css 与主题；点击/选中/菜单/重命名/键盘与拖拽规则都对齐原生：
 * - 单击打开、Ctrl/Cmd/中键开新标签，Alt 切换选中，Shift 范围选中
 * - 右键菜单按原生分组；「移动到…」只列当前库内的文件夹
 * - F2 / 右键重命名走行内 contenteditable；新建文件夹后同样进入行内命名
 * - 拖拽落点与原生共用 TreeDndController；多选时整组移动
 * - 隐藏与置顶沿用原生树那一份 order.items 标记
 */
export class KbTreeView extends ItemView {
  plugin: KbHomePlugin;
  private currentPath: string | null = null;
  private collapsed: Set<string> = new Set();
  /** 是否自动展开并高亮当前打开的笔记 */
  private autoReveal = true;
  /** 「自动定位」按钮的 DOM 引用，用于同步激活态 */
  private autoRevealBtn: HTMLElement | null = null;
  /** 拖拽落盘后短时间内的滚动锚点：让后续几次重绘都停在用户拖拽时的位置 */
  private scrollHoldTop: number | null = null;
  private scrollHoldUntil = 0;

  private surface: KbTreeSurface | null = null;
  private dndController: TreeDndController | null = null;
  private model: TreeModel | null = null;
  private renderer: KbTreeRenderer | null = null;
  /** 拖拽悬停展开了文件夹：dragend 后要整窗重绘，修正占位条 */
  private dragExpanded = false;
  /** 切换知识库时下一次渲染回到顶部；普通刷新保留当前视口 */
  private resetScrollOnNextRender = false;

  // ---------- 选中、焦点与行内编辑 ----------
  private readonly selection = new TreeSelection();
  private focusedPath: string | null = null;
  /** 正在行内重命名的路径；此期间不重绘整棵树 */
  private editingPath: string | null = null;
  /** 单库树获得焦点时激活的 keymap scope（F2 等被 Obsidian 全局键位先截获） */
  private keyScope: Scope | null = null;
  private keyScopePushed = false;

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

  async setState(state: Record<string, unknown>, _result: ViewStateResult): Promise<void> {
    if (state) {
      if (typeof state.currentPath === "string") this.currentPath = state.currentPath;
      if (typeof state.autoReveal === "boolean") this.autoReveal = state.autoReveal;
      const collapsed = state.collapsed;
      if (Array.isArray(collapsed)) {
        this.collapsed = new Set(collapsed.filter((p): p is string => typeof p === "string"));
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

    this.registerDomEvent(this.containerEl, "pointerdown", (event) =>
      this.handleTreePointerDown(event as MouseEvent)
    );
    this.registerDomEvent(this.containerEl, "click", (event) =>
      this.handleTreeBackgroundClick(event as MouseEvent)
    );
    this.setupKeyScope();

    // 活动文件变化时：先同步高亮（轻量，只切 class），
    // 若开启自动定位再展开父级（可能被手势保护推迟）。
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateActiveHighlight();
        if (this.autoReveal && this.currentPath) this.revealActive();
      })
    );

    this.setupDnd();
  }

  async onClose(): Promise<void> {
    this.editingPath = null;
    this.selection.clear();
    this.popTreeScope();
    this.keyScope = null;
    this.dndController?.detach();
    this.dndController = null;
    this.surface = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.model = null;
  }

  /** 装配与原生树同一套拖拽控制器；作用域/折叠/滚动差异由 Surface 提供 */
  private setupDnd(): void {
    if (this.dndController) return;
    const feature = this.plugin.sortFeature;
    if (!feature) return;

    this.surface = new KbTreeSurface(
      {
        getScopePath: () => this.currentPath,
        getScrollEl: () => this.getTreeBody(),
        isCollapsed: (path) => this.collapsed.has(path),
        expandInPlace: (path) => this.expandInPlace(path),
        selectedPaths: () => this.selectedVisiblePaths(),
        captureScroll: () => this.captureScrollHold(),
        refreshAfterDrop: () => this.refresh(),
        restoreScroll: () => this.restoreScrollHold(),
      },
      this.app,
      feature.orderManager,
      (path) => feature.ensureFolderSettings(path)
    );

    this.dndController = new TreeDndController({
      app: this.app,
      orderManager: feature.orderManager,
      getSettings: () => this.plugin.settings.order,
      getItemSettings: (path) => feature.getItemSettings(path),
      resolveSource: (target) => this.surface?.resolveDragSource(target) ?? null,
      resolveTargetSurface: (active) => active,
    });
    this.dndController.attach();
  }

  /**
   * 只更新高亮态，不重建 DOM。
   * 打开笔记后调用，保证树里当前笔记立即高亮，且不因 DOM 重建打断点击。
   */
  updateActiveHighlight(): void {
    this.renderer?.updateActive(this.app.workspace.getActiveFile()?.path ?? null);
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
    mk("folder-plus", "新建文件夹", () => void this.actionNewFolder());

    this.autoRevealBtn = mk("crosshair", "自动定位当前笔记", () => this.toggleAutoReveal());
    this.autoRevealBtn.toggleClass("is-active", this.autoReveal);

    mk("chevrons-down-up", "折叠全部 / 展开全部", () => this.toggleCollapseAll());
    mk("refresh-cw", "刷新", () => this.refresh());
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
    this.selection.clear();
    this.focusedPath = null;
    this.editingPath = null;
    this.scrollHoldTop = null;
    this.scrollHoldUntil = 0;
    this.resetScrollOnNextRender = true;
    this.render();
  }

  /** 文件夹改名 / 移动后跟随新路径；当前库在旧路径之下时同步更新 */
  public handlePathRenamed(oldPath: string, newPath: string): void {
    if (!this.currentPath) return;

    const remap = (path: string): string =>
      path === oldPath
        ? newPath
        : path.startsWith(oldPath + "/")
          ? newPath + path.slice(oldPath.length)
          : path;

    this.selection.remapPrefix(oldPath, newPath);
    if (this.focusedPath) this.focusedPath = remap(this.focusedPath);

    if (this.currentPath !== oldPath && !this.currentPath.startsWith(oldPath + "/")) {
      return;
    }

    this.currentPath = remap(this.currentPath);
    // 折叠状态按旧路径存，改名后直接清掉，避免整棵树错位折叠
    this.collapsed.clear();
    if (this.editingPath) {
      this.pendingRender = true;
      return;
    }
    this.render();
  }

  public refresh(): void {
    if (this.editingPath || this.inGesture) {
      this.pendingRender = true;
      return;
    }
    this.pruneSelection();
    if (this.tryFastRefresh()) return;
    this.render();
  }

  /**
   * 排序/置顶/隐藏/文件增删只让模型缓存失效并重绘当前窗口，
   * 不重建 header 和整棵树，视口停在用户当前的位置。
   */
  private tryFastRefresh(): boolean {
    if (!this.renderer || !this.model || !this.currentPath) return false;
    if (!this.plugin.sortFeature) return false;
    const folder = this.app.vault.getAbstractFileByPath(this.currentPath);
    if (!(folder instanceof TFolder)) return false;
    this.model.invalidateAll();
    this.renderer.render();
    this.renderer.updateSelection((path) => this.selection.has(path));
    this.renderer.updateFocus(this.focusedPath);
    return true;
  }

  private pruneSelection(): void {
    this.selection.prune((path) => !!this.app.vault.getAbstractFileByPath(path));
    if (this.focusedPath && !this.app.vault.getAbstractFileByPath(this.focusedPath)) {
      this.focusedPath = null;
    }
  }

  // ============================================================
  // 头部快捷操作
  // ============================================================

  /** 新建笔记/文件夹的落点：原生工具条按当前活动笔记所在文件夹，库外则回库根 */
  private activeFolderForNew(): TFolder | null {
    const root = this.requireRootFolder();
    if (!root) return null;
    const active = this.app.workspace.getActiveFile();
    const parent = active?.parent;
    if (
      active &&
      parent &&
      (active.path === root.path || active.path.startsWith(root.path + "/")) &&
      this.app.vault.getAbstractFileByPath(parent.path) instanceof TFolder
    ) {
      return parent;
    }
    return root;
  }

  private untitledPath(folder: TFolder, extension: "md" | ""): string {
    const prefix = folder.path === "/" ? "" : folder.path + "/";
    const available = (this.app.vault as any).getAvailablePath;
    if (typeof available === "function") {
      return available.call(this.app.vault, `${prefix}未命名`, extension);
    }
    const suffix = extension ? `.${extension}` : "";
    let suffixIndex = 0;
    let name = "未命名";
    while (this.app.vault.getAbstractFileByPath(`${prefix}${name}${suffix}`)) {
      suffixIndex++;
      name = `未命名 ${suffixIndex}`;
    }
    return `${prefix}${name}${suffix}`;
  }

  /** 在指定文件夹下按原生做法建笔记：默认「未命名」，随后直接打开 */
  private async createNoteIn(folder: TFolder): Promise<void> {
    let file: TFile | null = null;
    const fileManager = this.app.fileManager as any;
    try {
      if (typeof fileManager.createNewMarkdownFile === "function") {
        const created = await fileManager.createNewMarkdownFile(folder);
        if (created instanceof TFile) file = created;
      }
    } catch {
      // 私有 API 不可用时走下面的兜底
    }

    if (!file) {
      try {
        const created = await this.app.vault.create(this.untitledPath(folder, "md"), "");
        if (created instanceof TFile) file = created;
      } catch (err) {
        new Notice(`新建笔记失败：${String((err as Error)?.message ?? err)}`);
        return;
      }
    }
    if (!file) return;

    this.expandChainTo(folder.path);
    this.refresh();
    await this.plugin.openNote(file);
  }

  /** 新建文件夹：默认「未命名」，随后进入行内重命名 */
  private async createFolderIn(
    folder: TFolder,
    startRename = true
  ): Promise<TFolder | null> {
    let created: TFolder | null = null;
    const fileManager = this.app.fileManager as any;
    try {
      if (typeof fileManager.createNewFolder === "function") {
        const result = await fileManager.createNewFolder(folder);
        if (result instanceof TFolder) created = result;
      }
    } catch {
      // 私有 API 不可用时走下面的兜底
    }

    if (!created) {
      try {
        created = await this.app.vault.createFolder(this.untitledPath(folder, ""));
      } catch (err) {
        new Notice(`新建文件夹失败：${String((err as Error)?.message ?? err)}`);
        return null;
      }
    }
    if (!created) return null;

    this.expandChainTo(folder.path);
    this.refresh();
    if (startRename) this.beginRenameByPath(created.path);
    return created;
  }

  private actionNewNote(): void {
    const folder = this.activeFolderForNew();
    if (folder) void this.createNoteIn(folder);
  }

  private async actionNewFolder(): Promise<void> {
    const folder = this.activeFolderForNew();
    if (folder) await this.createFolderIn(folder);
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
    if (changed) this.refresh();
    this.renderer?.updateActive(active.path);
    this.renderer?.scrollToPath(active.path);
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

  private getTreeBody(): HTMLElement | null {
    return this.containerEl.querySelector<HTMLElement>(".kb-tree-body");
  }

  /** 拖拽落点前记住视口；重绘后由 rebuild() 反复套用，避免自动定位把视口抢走 */
  private captureScrollHold(): void {
    const body = this.getTreeBody();
    if (!body) return;
    this.scrollHoldTop = body.scrollTop;
    this.scrollHoldUntil = Date.now() + 800;
  }

  private restoreScrollHold(): void {
    const apply = (): void => {
      const body = this.getTreeBody();
      if (body && this.scrollHoldTop !== null) body.scrollTop = this.scrollHoldTop;
    };
    apply();
    window.requestAnimationFrame(apply);
    window.setTimeout(apply, 80);
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
    if (this.dragExpanded) {
      this.dragExpanded = false;
      this.pendingRender = false;
      this.rebuild();
      return;
    }
    if (!this.pendingRender) return;
    this.pendingRender = false;
    this.rebuild();
  }

  private rebuild(): void {
    const previousTop = this.getTreeBody()?.scrollTop ?? 0;
    this.renderer?.destroy();
    this.renderer = null;
    this.model = null;
    this.editingPath = null;

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

    const feature = this.plugin.sortFeature;
    if (!feature) {
      container.createDiv({ cls: "kb-tree-empty", text: "排序功能未就绪" });
      return;
    }

    // 每次重绘新建的宿主：拖拽监听挂在它上面，重绘后随旧 DOM 一起消失，不会叠监听
    const host = container.createDiv({ cls: "kb-tree-host" });

    // 顶部：返回 + 库名 + 工具按钮
    const header = host.createDiv({ cls: "kb-tree-header nav-header" });

    const back = header.createEl("span", { cls: "kb-tree-back", text: "← 全部知识库" });
    back.onclick = () => void this.plugin.openKbHome();

    const titleRow = header.createDiv({ cls: "kb-tree-title-row" });
    titleRow.createEl("div", { cls: "kb-tree-title", text: folder.name });
    // 工具按钮排在标题行右侧（与原生文件浏览器一致）
    this.renderToolbar(titleRow);

    // 树主体：带上原生的 nav-files-container，滚动条与内边距走原生那一套
    const tree = host.createDiv({ cls: "kb-tree-body nav-files-container" });
    tree.tabIndex = 0;

    const model = new TreeModel({
      app: this.app,
      orderManager: feature.orderManager,
      getSettings: () => this.plugin.settings.order,
      getFolderSettings: (path) => feature.ensureFolderSettings(path),
      isHiddenByRule: (path) => this.plugin.isHiddenByRule(path),
      isCollapsed: (path) => this.collapsed.has(path),
      getActivePath: () => this.app.workspace.getActiveFile()?.path ?? null,
    });
    model.setRootPath(this.currentPath);

    const renderer = new KbTreeRenderer(tree, model, {
      getActivePath: () => this.app.workspace.getActiveFile()?.path ?? null,
      getDraggingPath: () => this.dndController?.draggedItem?.path ?? null,
      getFocusedPath: () => this.focusedPath,
      isSelected: (path) => this.selection.has(path),
      isCollapsed: (path) => this.collapsed.has(path),
      onFileClick: (file, event) => this.handleFileClick(file, event),
      onFileAuxClick: (file, event) => {
        event.preventDefault();
        void this.app.workspace.getLeaf("tab").openFile(file);
      },
      onFolderClick: (target, event) => this.handleFolderClick(target, event),
      onFileContextMenu: (file, event) => this.handleFileContextMenu(file, event),
      onFolderContextMenu: (target, event) => this.handleFolderContextMenu(target, event),
    });

    this.model = model;
    this.renderer = renderer;

    // 拖拽落盘后的重绘从拖拽时的位置开窗；普通刷新沿用旧视口；切库才回顶部
    const holdActive = this.scrollHoldTop !== null && Date.now() < this.scrollHoldUntil;
    const top = this.resetScrollOnNextRender
      ? 0
      : holdActive
        ? (this.scrollHoldTop as number)
        : previousTop;
    this.resetScrollOnNextRender = false;
    renderer.render(top);
    renderer.updateSelection((path) => this.selection.has(path));
    renderer.updateFocus(this.focusedPath);

    // 空白区域右键：针对知识库根目录
    tree.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.closest(".tree-item-self")) return;
      e.preventDefault();
      const menuHost = this.menuHost();
      if (menuHost) showBlankContextMenu(menuHost, folder, e);
    });
  }

  // ============================================================
  // 点击、选中与键盘
  // ============================================================

  /** 文件行单击：与原生一致，Alt 选中、Shift 范围、Ctrl/Cmd 开新标签 */
  private handleFileClick(file: TFile, event: MouseEvent): void {
    this.setFocusedPath(file.path);

    if (event.altKey) {
      this.selection.toggle(file.path);
      this.updateSelectionView();
      return;
    }
    if (event.shiftKey) {
      this.extendSelection(file.path);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      this.selection.setAnchorOnly(file.path);
      this.updateSelectionView();
      void this.app.workspace.getLeaf("tab").openFile(file);
      return;
    }

    this.selection.setAnchorOnly(file.path);
    this.updateSelectionView();
    if (this.app.workspace.getActiveFile()?.path === file.path) return;
    void this.plugin.openNote(file);
  }

  /** 文件夹行单击：Alt/Shift 只选中，不折叠；普通点击切换折叠 */
  private handleFolderClick(folder: TFolder, event: MouseEvent): void {
    this.setFocusedPath(folder.path);

    if (event.altKey) {
      this.selection.toggle(folder.path);
      this.updateSelectionView();
      return;
    }
    if (event.shiftKey) {
      this.extendSelection(folder.path);
      return;
    }

    this.selection.setAnchorOnly(folder.path);
    this.updateSelectionView();
    this.toggleFolder(folder.path);
  }

  private handleFileContextMenu(file: TFile, event: MouseEvent): void {
    this.setFocusedPath(file.path);
    const menuHost = this.menuHost();
    if (!menuHost) return;
    if (this.selection.size > 1 && this.selection.has(file.path)) {
      showMultiContextMenu(menuHost, file, event);
    } else {
      showFileContextMenu(menuHost, file, event);
    }
  }

  private handleFolderContextMenu(folder: TFolder, event: MouseEvent): void {
    this.setFocusedPath(folder.path);
    const menuHost = this.menuHost();
    if (!menuHost) return;
    if (this.selection.size > 1 && this.selection.has(folder.path)) {
      showMultiContextMenu(menuHost, folder, event);
    } else {
      showFolderContextMenu(menuHost, folder, event);
    }
  }

  private extendSelection(path: string): void {
    const anchor = this.selection.anchor;
    if (!anchor) {
      this.selection.selectOnly(path);
      this.updateSelectionView();
      return;
    }
    const range = this.renderer?.pathsInRange(anchor, path);
    if (range) this.selection.selectRange(range);
    else this.selection.selectOnly(path);
    this.updateSelectionView();
  }

  private clearSelection(): void {
    this.selection.clear();
    this.updateSelectionView();
  }

  private updateSelectionView(): void {
    this.renderer?.updateSelection((path) => this.selection.has(path));
  }

  private selectedVisiblePaths(): string[] {
    const renderer = this.renderer;
    if (!renderer) return this.selection.values();
    const out: string[] = [];
    for (let i = 0; i < renderer.visibleCount; i++) {
      const path = renderer.pathAt(i);
      if (path && this.selection.has(path)) out.push(path);
    }
    return out;
  }

  /** 选中的文件/文件夹，去掉已被选中文件夹包含的子项 */
  private resolveSelectedFiles(): TAbstractFile[] {
    const vault = this.app.vault;
    const files = this.selection
      .values()
      .map((path) => vault.getAbstractFileByPath(path))
      .filter((file): file is TAbstractFile => !!file);

    return files.filter(
      (file) =>
        !files.some(
          (candidate) =>
            candidate instanceof TFolder &&
            candidate.path !== file.path &&
            file.path.startsWith(candidate.path + "/")
        )
    );
  }

  private setFocusedPath(path: string | null, scroll = false): void {
    this.focusedPath = path;
    if (path && scroll) this.renderer?.scrollToPath(path);
    this.renderer?.updateFocus(path);
    if (path) this.renderer?.rowSelf(path)?.focus({ preventScroll: true });
  }

  private handleTreePointerDown(event: MouseEvent): void {
    const body = this.getTreeBody();
    const target = event.target as HTMLElement | null;
    if (!body || !target || !body.contains(target)) return;
    if (this.editingPath) return;
    if (target.closest(".tree-item-self")) return;
    body.focus({ preventScroll: true });
  }

  private handleTreeBackgroundClick(event: MouseEvent): void {
    const body = this.getTreeBody();
    const target = event.target as HTMLElement | null;
    if (!body || !target || !body.contains(target)) return;
    if (target.closest(".tree-item-self")) return;
    if (this.editingPath) return;
    this.clearSelection();
    body.focus({ preventScroll: true });
  }

  /**
   * F2 / 方向键等会先被 Obsidian 的全局 keymap 截获，不会冒泡到 DOM。
   * 和原生文件浏览器一样：树获得焦点时压入自己的 scope，失焦时弹出。
   */
  private setupKeyScope(): void {
    const keymap = (this.app as any).keymap;
    if (typeof keymap?.pushScope === "function") {
      const scope = new Scope();
      for (const key of [
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Enter",
        "F2",
        "Delete",
        "Escape",
      ]) {
        scope.register(null, key, (event) => this.handleTreeKey(event));
      }
      this.keyScope = scope;
      this.registerDomEvent(this.containerEl, "focusin", (event) =>
        this.handleTreeFocusIn(event as FocusEvent)
      );
      this.registerDomEvent(this.containerEl, "focusout", (event) =>
        this.handleTreeFocusOut(event as FocusEvent)
      );
      return;
    }

    // 没有 keymap 的环境退回 DOM 监听
    this.registerDomEvent(this.containerEl, "keydown", (event) => {
      this.handleTreeKey(event as KeyboardEvent);
    });
  }

  private handleTreeFocusIn(event: FocusEvent): void {
    const body = this.getTreeBody();
    const target = event.target as Node | null;
    if (!body || !target || !body.contains(target)) return;
    if (this.editingPath) return;
    this.pushTreeScope();
  }

  private handleTreeFocusOut(event: FocusEvent): void {
    if (this.editingPath) return;
    const body = this.getTreeBody();
    const next = event.relatedTarget as Node | null;
    if (body && next && body.contains(next)) return;
    this.popTreeScope();
  }

  private pushTreeScope(): void {
    if (!this.keyScope || this.keyScopePushed) return;
    (this.app as any).keymap?.pushScope(this.keyScope);
    this.keyScopePushed = true;
  }

  private popTreeScope(): void {
    if (!this.keyScope || !this.keyScopePushed) return;
    (this.app as any).keymap?.popScope(this.keyScope);
    this.keyScopePushed = false;
  }

  private handleTreeKey(event: KeyboardEvent): boolean {
    if (this.editingPath) return false;
    const body = this.getTreeBody();
    const renderer = this.renderer;
    if (!body || !renderer) return false;

    const target = event.target as Node | null;
    if (!target || (!body.contains(target) && target !== body)) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;

    const activeRow =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>(".tree-item-self[data-path]")
        : null;
    const activePath = activeRow?.dataset.path ?? null;
    let current =
      activePath && renderer.indexOfPath(activePath) >= 0 ? activePath : this.focusedPath;
    if (current && renderer.indexOfPath(current) < 0) current = null;

    const index = current ? renderer.indexOfPath(current) : -1;
    const focusAt = (i: number): void => {
      const path = renderer.pathAt(i);
      if (path) this.setFocusedPath(path, true);
    };

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index < 0 ? 0 : index + 1);
        return true;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index < 0 ? 0 : index - 1);
        return true;
      case "Home":
        event.preventDefault();
        focusAt(0);
        return true;
      case "End":
        event.preventDefault();
        focusAt(renderer.visibleCount - 1);
        return true;
      case "ArrowLeft": {
        if (!current) return false;
        event.preventDefault();
        const entry = this.app.vault.getAbstractFileByPath(current);
        if (entry instanceof TFolder) {
          if (!this.collapsed.has(current)) {
            this.toggleFolder(current);
            this.setFocusedPath(current);
            return true;
          }
          const parent = entry.parent;
          if (parent && parent.path !== this.currentPath && renderer.indexOfPath(parent.path) >= 0) {
            this.setFocusedPath(parent.path, true);
          }
        } else if (entry?.parent && entry.parent.path !== this.currentPath) {
          this.setFocusedPath(entry.parent.path, true);
        }
        return true;
      }
      case "ArrowRight": {
        if (!current) return false;
        event.preventDefault();
        const entry = this.app.vault.getAbstractFileByPath(current);
        if (!(entry instanceof TFolder)) return true;
        if (this.collapsed.has(current)) {
          this.toggleFolder(current);
          this.setFocusedPath(current);
          return true;
        }
        const nextPath = renderer.pathAt(index + 1);
        if (nextPath && nextPath.startsWith(current + "/")) {
          this.setFocusedPath(nextPath, true);
        }
        return true;
      }
      case "Enter": {
        if (!current) return false;
        event.preventDefault();
        const entry = this.app.vault.getAbstractFileByPath(current);
        if (entry instanceof TFolder) this.toggleFolder(current);
        else if (entry instanceof TFile) {
          if (this.app.workspace.getActiveFile()?.path !== entry.path) {
            void this.plugin.openNote(entry);
          }
        }
        return true;
      }
      case "F2":
        if (!current) return false;
        event.preventDefault();
        this.beginRenameByPath(current);
        return true;
      case "Delete": {
        const files =
          this.selection.size > 0 ? this.resolveSelectedFiles() : current
            ? [this.app.vault.getAbstractFileByPath(current)].filter(
                (file): file is TAbstractFile => !!file
              )
            : [];
        if (!files.length) return false;
        event.preventDefault();
        void this.deleteFiles(files);
        return true;
      }
      case "Escape":
        if (this.selection.size === 0) return false;
        event.preventDefault();
        this.clearSelection();
        return true;
      default:
        return false;
    }
  }

  private menuHost(): KbTreeMenuHost | null {
    const feature = this.plugin.sortFeature;
    if (!feature || !this.currentPath) return null;
    return {
      app: this.app,
      scopeRootPath: this.currentPath,
      addPluginItems: (menu, file) =>
        feature.addFileMenuItems(menu, file, () => this.refresh()),
      addSortOnly: (menu, folder) =>
        feature.addSortOnly(menu, folder, () => this.refresh()),
      refresh: () => this.refresh(),
      beginRename: (file) => this.beginRenameByPath(file.path),
      createNote: (folder) => void this.createNoteIn(folder),
      createFolder: (folder) => void this.createFolderIn(folder),
      createFolderWithSelection: (files) => void this.createFolderWithSelection(files),
      deleteFiles: (files) => void this.deleteFiles(files),
      selectedFiles: () => this.resolveSelectedFiles(),
      clearSelection: () => this.clearSelection(),
    };
  }

  private toggleFolder(path: string): void {
    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);
    this.renderer?.render();
    this.renderer?.updateSelection((p) => this.selection.has(p));
    this.renderer?.updateFocus(this.focusedPath);
  }

  // ============================================================
  // 行内重命名 / 新建 / 删除
  // ============================================================

  private beginRenameByPath(path: string): void {
    if (this.editingPath) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return;

    this.renderer?.scrollToPath(path);
    const row = this.renderer?.rowSelf(path);
    if (!row) return;

    this.setFocusedPath(path);
    this.editingPath = path;
    // 编辑期间让 contenteditable 自己处理 Enter/Esc/方向键
    this.popTreeScope();
    const initial = file instanceof TFile ? file.basename : file.name;
    startInlineRename(row, {
      initialText: initial,
      commit: (text) => this.commitRename(file, text),
      finish: (keepFocus) => this.finishEditing(keepFocus),
    });
  }

  private async commitRename(file: TAbstractFile, text: string): Promise<boolean> {
    const name = text.trim();
    if (!name) {
      new Notice("名称不能为空");
      return false;
    }
    if (INVALID_NAME.test(name)) {
      new Notice('名称不能包含 \\ / : * ? " < > | 等字符');
      return false;
    }

    const parent = file.parent;
    if (!parent) return false;

    const oldPath = file.path;
    const oldName = file instanceof TFile ? file.basename : file.name;
    if (name === oldName) return true;

    let targetName = name;
    if (file instanceof TFile && file.extension) {
      const suffix = "." + file.extension;
      const base = name.toLowerCase().endsWith(suffix.toLowerCase())
        ? name.slice(0, -suffix.length)
        : name;
      if (!base) {
        new Notice("名称不能为空");
        return false;
      }
      targetName = `${base}.${file.extension}`;
    }

    const newPath = parent.path === "/" ? targetName : `${parent.path}/${targetName}`;
    const existing = this.app.vault.getAbstractFileByPath(newPath);
    if (existing && existing !== file) {
      new Notice(`已存在：${newPath}`);
      return false;
    }

    try {
      await this.app.fileManager.renameFile(file, newPath);
    } catch (err) {
      new Notice(`重命名失败：${String((err as Error)?.message ?? err)}`);
      return false;
    }

    this.selection.remapPrefix(oldPath, newPath);
    if (this.focusedPath === oldPath) this.focusedPath = newPath;
    return true;
  }

  private finishEditing(keepFocus: boolean): void {
    const pending = this.pendingRender;
    this.editingPath = null;
    this.pendingRender = false;

    if (pending) this.render();
    else this.refresh();

    // Enter/Esc 完成重命名后把焦点还给该行，F2/方向键可以继续用；失焦提交不抢回焦点
    if (keepFocus) this.setFocusedPath(this.focusedPath, true);
  }

  private expandChainTo(path: string): void {
    const root = this.currentPath;
    if (!root) return;
    this.collapsed.delete(root);
    if (path === root) return;
    if (!path.startsWith(root + "/")) return;

    let acc = root;
    for (const part of path.slice(root.length + 1).split("/")) {
      acc = `${acc}/${part}`;
      this.collapsed.delete(acc);
    }
  }

  private async createFolderWithSelection(files: TAbstractFile[]): Promise<void> {
    if (!files.length) return;
    const parent = files[0].parent;
    if (!parent || !files.every((file) => file.parent?.path === parent.path)) {
      new Notice("只能把同一文件夹内的对象放进新文件夹");
      return;
    }

    const folder = await this.createFolderIn(parent, false);
    if (!folder) return;

    for (const file of files) {
      if (!this.app.vault.getAbstractFileByPath(file.path)) continue;
      const target = `${folder.path}/${file.name}`;
      try {
        await this.app.fileManager.renameFile(file, target);
      } catch (err) {
        new Notice(`移动失败：${String((err as Error)?.message ?? err)}`);
      }
    }

    this.clearSelection();
    this.refresh();
    this.beginRenameByPath(folder.path);
  }

  private async deleteFiles(files: TAbstractFile[]): Promise<void> {
    for (const file of files) {
      if (!this.app.vault.getAbstractFileByPath(file.path)) continue;
      try {
        const prompt = (this.app.fileManager as any).promptForDeletion;
        if (typeof prompt === "function") {
          await prompt.call(this.app.fileManager, file);
        } else {
          await this.app.fileManager.trashFile(file);
        }
      } catch (err) {
        new Notice(`删除失败：${String((err as Error)?.message ?? err)}`);
      }
    }

    const rootStill = this.currentPath
      ? this.app.vault.getAbstractFileByPath(this.currentPath)
      : null;
    if (!rootStill) {
      this.currentPath = null;
      this.selection.clear();
      this.focusedPath = null;
      this.render();
      return;
    }

    this.selection.prune((path) => !!this.app.vault.getAbstractFileByPath(path));
    this.updateSelectionView();
    this.refresh();
  }

  // ============================================================
  // 拖拽辅助（落点规则在 src/tree/tree-dnd.ts）
  // ============================================================

  /**
   * 就地展开某个文件夹。
   * 拖拽进行中不能整棵树重绘：那会把正在拖的源节点连监听一起拆掉，这次拖拽就废了。
   */
  private expandInPlace(path: string): void {
    if (!this.collapsed.delete(path)) return;
    this.dragExpanded = true;
    this.renderer?.expandInPlace(path);
  }
}
