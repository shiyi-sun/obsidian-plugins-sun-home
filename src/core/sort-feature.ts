import { App, TAbstractFile, TFile, TFolder, Menu, EventRef } from "obsidian";
import { OrderManager } from "./order-manager";
import { HideManager } from "./hide-manager";
import { Patcher } from "./patcher";
import { DndEngine } from "./dnd-engine";
import { NativeTreeSurface } from "../tree/native-surface";
import { TreeDndController } from "../tree/tree-dnd";
import { ExplorerManager } from "./explorer-manager";
import { populateFileMenu, populateSortMenu, MenuHost } from "./menu";
import {
  OrderSettings,
  DEFAULT_ORDER_SETTINGS,
  BaseItemSettings,
  FolderSettings,
  ItemSettings,
  isFolderSettings,
} from "./order-types";
import { initLog, logger } from "./log";

/**
 * 排序 / 置顶 / 隐藏 特性的总入口。
 * 整合自 flexplorer（MIT License, kh4f）。
 */
export class SortFeature {
  readonly log = initLog("SORT FEATURE", "#00ccff");

  readonly orderManager: OrderManager;
  readonly hideManager = new HideManager();
  readonly patcher: Patcher;
  readonly nativeSurface: NativeTreeSurface;
  readonly dndController: TreeDndController;
  readonly dndEngine: DndEngine;
  readonly explorerManager: ExplorerManager;

  /** vault / workspace 事件引用，便于在 destroy() 时兜底摘除 */
  private vaultEventRefs: EventRef[] = [];

  /**
   * 静默标志：启动阶段（首次 syncItems / 索引扫描）会有大量 vault 事件涌入，
   * 此时不响应 create/rename/delete/modify，避免「事件风暴 × 每次写盘」拖慢启动。
   * 由 init() 在首次同步期间置位，同步完成后解除。
   */
  private suspended = false;

  /** 暂停/恢复事件处理 */
  setSuspended(v: boolean): void {
    this.suspended = v;
  }

  /** 立即写盘（用户显式操作使用，保证不丢） */
  saveNow(): void | Promise<void> {
    return this.persistNow();
  }

  constructor(
    private readonly app: App,
    /** 拿当前设置（延迟读取，保证总是最新） */
    private readonly getSettings: () => OrderSettings,
    /** 持久化设置（防抖，用于高频 vault 事件） */
    private readonly persist: () => void | Promise<void>,
    /**
     * 立即持久化（无防抖）。用于「用户显式操作」——右键隐藏/置顶/切换排序方式等。
     * 这些操作后用户可能立刻退出 Obsidian，若走防抖可能来不及写盘导致丢失。
     * 缺省时回退到 persist。
     */
    private readonly persistNow: () => void | Promise<void> = persist
  ) {
    this.orderManager = new OrderManager(
      () => this.getSettings(),
      (folder: TFolder) =>
        this.getExplorerView()?.getSortedFolderItems?.(folder) ??
        folder.children.map((f) => ({ file: f })),
      () => this.persist(),
      // 顺序变化后立刻重排原生文件浏览器
      () => this.sortExplorer()
    );

    this.patcher = new Patcher(
      () => this.getSettings(),
      this.orderManager,
      () => this.getExplorerViews(),
      () => this.syncIndicators()
    );

    this.nativeSurface = new NativeTreeSurface(this.app);
    this.dndController = new TreeDndController({
      app: this.app,
      orderManager: this.orderManager,
      getSettings: () => this.getSettings(),
      getItemSettings: (path: string) => this.getItemSettings(path),
      resolveSource: (target) => this.nativeSurface.resolveDragSource(target),
      resolveTargetSurface: (active, point) => this.nativeSurface.resolveSurfaceAt(active, point),
    });
    this.dndEngine = new DndEngine(this.dndController, this.nativeSurface);

    this.explorerManager = new ExplorerManager(
      () => this.getSettings(),
      () => this.getExplorerViews(),
      (path) => this.hideManager.isPatternHidden(path)
    );
  }

  /** 初始化（须在 workspace 就绪后调用） */
  init(): void {
    this.syncRuntimeSettings();

    this.patcher.patchVaultCopy();
    // 拖拽监听挂在 document 上：不依赖文件浏览器何时挂载/重建
    this.dndEngine.attach();
    this.observeExplorer();
  }

  /**
   * 启动静默：在 onload 期间（事件注册后）立即调用，覆盖「onload → onLayoutReady → 首次同步完成」
   * 这一整段启动窗口。此期间 Obsidian 的索引扫描会对已存在文件反复触发 create 事件，
   * 若逐条响应会造成事件风暴与无谓写盘。
   */
  suspend(): void {
    this.suspended = true;
  }

  /** 解除启动静默（首次同步完成后调用） */
  resume(): void {
    this.suspended = false;
  }

  private observeExplorer(): void {
    // 兜底：若因故文件浏览器一直未挂载，10 秒后也要解除静默，避免永久不响应事件
    window.setTimeout(() => {
      if (this.suspended) {
        this.log("Explorer not mounted within 10s, force-resuming events");
        this.suspended = false;
      }
    }, 10000);

    this.explorerManager.observeExplorerMount(
      (el) => {
        this.log("Explorer mounted");
        try {
          // 顺序：sync（需要原始排序）→ patch → 重排 → 挂拖拽 → 挂指示器
          this.orderManager.syncItems(
            (p) => !!this.app.vault.getAbstractFileByPath(p),
            this.app.vault.getRoot()
          );

          this.patcher.patchExplorerSorting();
          this.sortExplorer();
          this.syncIndicators();
          // 原生树懒渲染：持续观察内容变化，条目渲染出来时补上隐藏态
          this.explorerManager.observeIndicatorSync(el);
        } finally {
          // 首次同步完成 → 解除启动静默（放 finally 确保异常时也能恢复）
          this.suspended = false;
        }
      },
      { checkExisting: true, watch: true }
    );
  }

  /** 卸载清理 */
  destroy(): void {
    this.explorerManager.disconnectObservers();
    this.dndEngine.detach();
    this.patcher.unpatch();
    this.sortExplorer();
    document.body.removeClass("kb-show-hidden");
    this.stripRowMarks();

    // 兜底：显式摘除 vault 监听。
    // 正常路径下这些已由 Plugin.registerEvent 自动清理，重复 offref 无害。
    for (const ref of this.vaultEventRefs) {
      try {
        this.app.vault.offref(ref);
      } catch {
        // 忽略：可能已被自动清理
      }
    }
    this.vaultEventRefs = [];
  }

  /**
   * 撕掉插件在文件树行上留下的痕迹：隐藏标记类与图钉节点。
   * 插件的 CSS 会随卸载被移除，光留类名不会隐藏任何东西，
   * 但别家插件/主题若用了同名类就会把它「接管」，成为无从排查的幽灵隐藏。
   */
  private stripRowMarks(): void {
    const root = this.app.workspace.containerEl;
    root.querySelectorAll<HTMLElement>(".kb-hidden").forEach((el) => el.removeClass("kb-hidden"));
    root.querySelectorAll<HTMLElement>(".kb-indicator").forEach((el) => el.remove());
  }

  /**
   * 注册 workspace / vault 级事件。必须在 Plugin.onload 期间调用，
   * 由调用方用 this.registerEvent() 包装，确保卸载时被自动摘除。
   *
   * @param register 由 Plugin 提供的注册函数，通常是 (ref) => this.registerEvent(ref)
   * @param onMenuChanged 菜单里的置顶/隐藏/排序变化后的刷新回调
   */
  registerVaultEvents(
    register: (ref: EventRef) => void,
    onMenuChanged?: () => void
  ): void {
    // 先创建 EventRef，交由 Plugin 注册（自动清理），同时自己也留一份用于兜底 offref。
    const track = (ref: EventRef): void => {
      this.vaultEventRefs.push(ref);
      register(ref);
    };

    track(
      this.app.vault.on("create", (item) => {
        if (this.suspended) return;
        this.orderManager.add(item);
        this.syncIndicators();
      })
    );
    track(
      this.app.vault.on("rename", (item, oldPath) => {
        if (this.suspended) return;
        this.orderManager.move(oldPath, item.path);
        this.syncIndicators();
      })
    );
    track(
      this.app.vault.on("delete", (item) => {
        if (this.suspended) return;
        this.orderManager.remove(item.path);
      })
    );
    track(
      this.app.vault.on("modify", (item) => {
        if (this.suspended) return;
        const s = this.getSettings().items[item.path] as ItemSettings | undefined;
        if (s) s.mtime = Date.now();

        const parentPath = item.parent?.path;
        if (!parentPath) return;
        const folderSettings = this.getSettings().items[parentPath] as
          | FolderSettings
          | undefined;
        if (folderSettings?.sortOrder?.startsWith("byModifiedTime")) {
          this.sortExplorer();
        }
      })
    );
    // 右键菜单：往原生树注入置顶 / 隐藏 / 排序
    track(
      this.app.workspace.on("file-menu", (menu: Menu, file: any) => {
        this.addFileMenuItems(menu, file, onMenuChanged);
      })
    );
  }

  /**
   * 加「置顶 / 取消置顶 / 隐藏 / 取消隐藏 / 排序方式」到某个右键菜单。
   * 原生树靠上面的 file-menu 事件复用；插件自己的树直接调用，
   * 不再走全局广播 —— 广播里 Obsidian 注入的那几条在本插件菜单中并不生效。
   */
  addFileMenuItems(menu: Menu, file: any, onChanged?: () => void): void {
    if (!file || file.path === "/") return;
    populateFileMenu(menu, file, this.menuHost(onChanged));
  }

  /** 只注入「排序方式」，用于库根空白右键（不显示根文件夹的置顶/隐藏） */
  addSortOnly(menu: Menu, folder: TFolder, onChanged?: () => void): void {
    const settings = this.ensureFolderSettings(folder.path);
    menu.addItem((entry) => {
      entry.setTitle("排序方式").setIcon("sort-asc");
      const submenu: Menu = (entry as any).setSubmenu?.() ?? menu;
      populateSortMenu(submenu, settings.sortOrder, this.menuHost(onChanged), folder.path, settings);
    });
  }

  private menuHost(onChanged?: () => void): MenuHost {
    return {
      settings: this.getSettings(),
      ensureItemSettings: (f: TAbstractFile) => this.ensureItemSettings(f),
      app: this.app,
      orderManager: this.orderManager,
      sortExplorer: () => this.sortExplorer(),
      syncIndicators: () => this.syncIndicators(),
      saveSettingsNow: () => this.saveNow(),
      onChanged,
    };
  }

  /**
   * 隐藏规则（手动隐藏 或 glob 命中）是否命中该路径。
   * 只看规则本身，不考虑「显示被隐藏的文件」开关 —— 树里的条目据此挂上 .kb-hidden，
   * 由 CSS 决定是彻底不显示还是淡化显示，与原生树同一套做法。
   */
  isHiddenByRule(path: string): boolean {
    if (this.getSettings().items[path]?.isHidden) return true;
    return this.hideManager.isPatternHidden(path);
  }

  /**
   * 该路径当前是否应当从列表里彻底不出现。
   * 打开「显示被隐藏的文件」时算作可见 —— 与原生树的那个开关保持一致。
   */
  isHiddenForList(path: string): boolean {
    return !this.getSettings().showHidden && this.isHiddenByRule(path);
  }

  /**
   * 取文件夹设置，缺失时补一份**完整**的。
   * 不能用 getItemSettings 兜底：它补出来的是文件形状（没有 customOrder / sortOrder），
   * 而排序器会直接 customOrder.forEach() —— 缺了就崩，排序菜单也会显示不出当前项。
   */
  ensureFolderSettings(path: string): FolderSettings {
    const items = this.getSettings().items;
    const cur = items[path];
    if (cur && isFolderSettings(cur)) return cur;
    const created: FolderSettings = {
      isPinned: cur?.isPinned ?? false,
      isHidden: cur?.isHidden ?? false,
      customOrder: [],
      sortOrder: "custom",
    };
    items[path] = created;
    return created;
  }

  /**
   * 按条目类型补出设置。右键菜单注入前三项靠它保证"永远有得显示"。
   * 文件必须带上 ctime/mtime：按创建/修改时间排序读的就是这两个字段，
   * 补成裸条目会让该文件永远排在末尾（实测把用户一篇笔记排到了最后）。
   */
  ensureItemSettings(file: TAbstractFile): ItemSettings {
    if (file instanceof TFolder) return this.ensureFolderSettings(file.path);
    const items = this.getSettings().items;
    const cur = items[file.path];
    if (cur) return cur;
    const stat = file instanceof TFile ? file.stat : null;
    const created: BaseItemSettings = {
      isPinned: false,
      isHidden: false,
      ctime: stat?.ctime ?? Date.now(),
      mtime: stat?.mtime ?? Date.now(),
    };
    items[file.path] = created;
    return created;
  }

  /** 同步运行时设置（显示隐藏、日志级别、规则编译） */
  syncRuntimeSettings(): void {
    const s = this.getSettings();
    logger.level = s.debugMode ? "debug" : "silent";
    document.body.toggleClass("kb-show-hidden", s.showHidden);
    this.hideManager.syncRegexes(s.hidePatterns);
  }

  setDebug(enabled: boolean): void {
    logger.level = enabled ? "debug" : "silent";
  }

  getExplorerView(): any {
    return this.getExplorerViews()[0] ?? null;
  }

  /** 侧栏/主区域可能同时存在多个 Files 面板，全部返回 */
  getExplorerViews(): any[] {
    return this.app.workspace.getLeavesOfType("file-explorer").map((leaf) => leaf.view);
  }

  sortExplorer(): void {
    this.patcher.sortExplorer();
  }

  syncIndicators(): void {
    this.explorerManager.syncIndicators();
  }

  getItemSettings(path: string): ItemSettings {
    const items = this.getSettings().items;
    if (!items[path]) items[path] = { isPinned: false, isHidden: false };
    return items[path];
  }
}

export { DEFAULT_ORDER_SETTINGS };
