import { TAbstractFile, TFile, TFolder, App } from "obsidian";
import { initLog } from "./log";
import type { OrderSettings, FolderSettings } from "./order-types";
import { OrderManager } from "./order-manager";

/** 文件夹行上/下沿各 30% 用于「排到前/后」，中间 40% 才判定为「移入」 */
const FOLDER_INSIDE_TOP = 0.3;
const FOLDER_INSIDE_BOTTOM = 0.7;

/** 供 DnD 引擎回调宿主（插件）能力的接口 */
export interface DndHost {
  app: App;
  orderManager: OrderManager;
  /** 取当前设置 */
  getSettings: () => OrderSettings;
  /** 取文件浏览器视图（私有 API，用 any） */
  getExplorerView: () => any;
  /** 让文件浏览器重新排序 */
  sortExplorer: () => void;
  /** 重挂指示器 */
  syncIndicators: () => void;
  /** 读取某路径的设置 */
  getItemSettings: (path: string) => { isPinned: boolean };
}

/**
 * 拖拽排序引擎：接管原生文件浏览器里的拖放，实现自定义顺序。
 * 移植自 flexplorer（MIT License, kh4f）。
 *
 * 关键设计：落点只由指针命中的那一行决定（elementFromPoint + DOM 局部结构），
 * 不再每帧扫描整棵树。仓库有上万条目时，全量扫描会让 dragover 直接卡死，
 * 而且容易把落点算到别的文件夹里。
 */
export class DndEngine {
  private readonly log = initLog("DND ENGINE", "#a6ff00");

  private attached = false;
  private explorerEl: HTMLElement | null = null;
  private explorerRect: DOMRect | null = null;

  private draggedItem: TAbstractFile | null = null;
  private draggedRow: HTMLElement | null = null;
  private draggedPinned = false;
  /** 本次拖拽涉及的路径（被拖条目 + 多选中的其余条目），不参与落点 */
  private draggingPaths = new Set<string>();
  private dropSibling: HTMLElement | null = null;
  private dropFolder: HTMLElement | null = null;
  private insertSide: "before" | "after" = "before";
  private pointer = { x: 0, y: 0 };
  /** 手动排序后要恢复的原生树滚动位置；用于顶掉 Obsidian 自动定位当前文件的滚动 */
  private pendingScrollTop: { container: HTMLElement; top: number } | null = null;

  private readonly autoscrollZoneHeight = 60;
  private readonly edgeScrollSpeed = 20;
  private autoscrollRaf = 0;

  private readonly expandDelay = 1000;
  private expandTarget: HTMLElement | null = null;
  private expandTimeout = 0;

  constructor(private readonly host: DndHost) {}

  /** 挂在 document 上：文件浏览器重建、多个 Files 面板都不影响监听 */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    document.addEventListener("dragstart", this.onDragStart, true);
    document.addEventListener("dragover", this.onDragOver, true);
    document.addEventListener("drop", this.onDrop, true);
    document.addEventListener("dragend", this.onDragEnd, true);
    this.log("Attached to document");
  }

  detach(): void {
    document.removeEventListener("dragstart", this.onDragStart, true);
    document.removeEventListener("dragover", this.onDragOver, true);
    document.removeEventListener("drop", this.onDrop, true);
    document.removeEventListener("dragend", this.onDragEnd, true);
    this.attached = false;
    this.resetDrag();
    this.log("Detached");
  }

  private readonly onDragStart = (event: DragEvent): void => {
    const target = event.target as HTMLElement | null;
    const container = target?.closest?.<HTMLElement>(".nav-files-container");
    if (!container || !container.closest('[data-type="file-explorer"]')) return;

    const row = target?.closest?.<HTMLElement>(".tree-item");
    if (!row) return;
    const self = this.selfOf(row);
    const path = self?.dataset.path;
    if (!path) return;

    const file = this.host.app.vault.getAbstractFileByPath(path);
    if (!file) return;

    this.explorerEl = container;
    this.explorerRect = container.getBoundingClientRect();
    this.draggedItem = file;
    this.draggedRow = row;
    this.draggedPinned = this.host.getItemSettings(file.path).isPinned;
    this.draggingPaths = new Set(this.getSelectedItems().map((item) => item.file.path));
    this.draggingPaths.add(file.path);

    document.body.classList.add("kb-dragging");
    this.log(`Started dragging '${file.path}'`);
  };

  private readonly onDragOver = (event: DragEvent): void => {
    if (!this.draggedItem) return;

    const target = event.target as HTMLElement | null;
    const container = target?.closest?.<HTMLElement>(".nav-files-container");
    if (container && container.closest('[data-type="file-explorer"]')) {
      if (container !== this.explorerEl) {
        this.explorerEl = container;
        this.explorerRect = container.getBoundingClientRect();
      }
    }

    // 阻止 Obsidian 自动展开被拖拽/相邻的折叠文件夹
    const view = this.getExplorerViewFor(this.explorerEl);
    if (view) view.lastDropTargetEl = null;

    this.pointer = { x: event.clientX, y: event.clientY };
    this.startAutoscroll();

    if (!this.isPointerInsideExplorer()) {
      this.clearDropIndicators();
      this.dropSibling = null;
      this.dropFolder = null;
      this.clearPendingExpand();
      return;
    }

    if (this.resolveAndApplyDropTarget()) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
  };

  private readonly onScroll = (): void => {
    if (!this.draggedItem || !this.isPointerInsideExplorer()) return;
    this.resolveAndApplyDropTarget();
  };

  private readonly onDrop = (event: DragEvent): void => {
    if (!this.draggedItem) return;

    const target = event.target as HTMLElement | null;
    const container = target?.closest?.<HTMLElement>(".nav-files-container");
    if (container && container.closest('[data-type="file-explorer"]') && container !== this.explorerEl) {
      this.explorerEl = container;
      this.explorerRect = container.getBoundingClientRect();
    }

    this.pointer = { x: event.clientX, y: event.clientY };
    if (!this.isPointerInsideExplorer()) {
      this.log("Dropped outside native explorer, skipping move");
      this.resetDrag();
      return;
    }

    event.preventDefault();
    // 用最后一次 dragover 已经显示给用户的落点，不在 drop 时重新判定：
    // 重新命中可能因为 1px 抖动/滚动把 before/after 翻面，出现「线在上、落在下」。
    if (!this.dropSibling && !this.dropFolder) this.resolveAndApplyDropTarget();
    this.commitDrop();
    this.resetDrag();
  };

  private readonly onDragEnd = (): void => {
    if (!this.draggedItem) return;
    this.log(`Ended dragging '${this.draggedItem.path}'`);
    this.resetDrag();
  };

  private resolveAndApplyDropTarget(): boolean {
    this.clearDropIndicators();
    this.resolveDropTarget();
    this.applyDropIndicators();
    return !!(this.dropSibling || this.dropFolder);
  }

  private resolveDropTarget(): void {
    if (!this.explorerEl || !this.draggedItem || !this.draggedRow) return;

    const hit = activeDocument.elementFromPoint(this.pointer.x, this.pointer.y) as HTMLElement | null;
    if (!hit || !this.explorerEl.contains(hit)) return;

    const title = hit.closest<HTMLElement>(".nav-folder-title, .nav-file-title");
    if (title && this.explorerEl.contains(title)) {
      this.resolveTitleTarget(title);
      return;
    }

    // 2px 行距属于标题的 margin-bottom，命中的是文件夹行/子项容器，
    // 这里按指针 y 找回最近的标题行，而不是把整个容器当“末尾”。
    const folderRow = hit.closest<HTMLElement>(".tree-item.nav-folder");
    if (folderRow && this.explorerEl.contains(folderRow)) {
      const folderTitle = this.selfOf(folderRow);
      if (folderTitle) {
        const rect = folderTitle.getBoundingClientRect();
        if (this.pointer.y >= rect.top && this.pointer.y <= rect.bottom) {
          this.resolveTitleTarget(folderTitle);
          return;
        }
      }
      const children = folderRow.querySelector<HTMLElement>(
        ":scope > .nav-folder-children"
      );
      this.resolveBlankTarget(children, folderRow);
      return;
    }

    const children = hit.closest<HTMLElement>(".nav-folder-children");
    if (children && this.explorerEl.contains(children)) {
      const folder = children.parentElement?.closest<HTMLElement>(".nav-folder") ?? null;
      this.resolveBlankTarget(children, folder);
      return;
    }

    // 根目录空白、右侧留白、容器 padding
    const rootContainer = this.explorerEl.firstElementChild as HTMLElement | null;
    this.resolveBlankTarget(rootContainer, null);
  }

  /** 空白/行距区域：按方向感知找最近的标题行；没有行才退化成移入容器 */
  private resolveBlankTarget(
    container: HTMLElement | null,
    folderRow: HTMLElement | null
  ): void {
    this.clearPendingExpand();

    let folderPath = "/";
    if (folderRow) {
      folderPath = this.resolveItemPath(folderRow) ?? "";
      if (!folderPath || this.isSelfOrDescendant(folderRow)) return;
      if (this.draggingPaths.has(folderPath)) return;
      if (this.draggedPinned && this.draggedItem?.parent?.path !== folderPath) return;
    } else if (this.draggedPinned && this.draggedItem?.parent?.path !== "/") {
      return;
    }

    const near = container ? this.nearestSiblingRow(container, folderPath) : null;
    if (near) {
      this.setSiblingTarget(near.row, near.side);
      if (this.dropSibling) return;
    }

    if (this.draggedPinned) return;
    if (folderRow) this.dropFolder = folderRow;
    else if (!this.draggedPinned) this.dropFolder = container;
  }

  /** 在容器的直接子行里找离指针最近的一行，并给出「前/后」方向 */
  private nearestSiblingRow(
    container: HTMLElement,
    folderPath: string
  ): { row: HTMLElement; side: "before" | "after" } | null {
    const rows = Array.from(container.children).filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && el.classList.contains("tree-item")
    );

    let best: { row: HTMLElement; side: "before" | "after"; dist: number } | null = null;
    for (const row of rows) {
      if (this.isSelfOrDescendant(row)) continue;
      const path = this.resolveItemPath(row);
      if (!path || this.draggingPaths.has(path)) continue;

      const pinned = this.host.getItemSettings(path).isPinned;
      if (pinned !== this.draggedPinned) continue;
      if (this.draggedPinned && this.draggedItem?.parent?.path !== folderPath) continue;

      const self = this.selfOf(row);
      if (!self) continue;
      const rect = self.getBoundingClientRect();

      let side: "before" | "after";
      let dist: number;
      if (this.pointer.y < rect.top) {
        dist = rect.top - this.pointer.y;
        side = "before";
      } else if (this.pointer.y > rect.bottom) {
        dist = this.pointer.y - rect.bottom;
        side = "after";
      } else {
        dist = 0;
        side = this.pointer.y < rect.top + rect.height / 2 ? "before" : "after";
      }

      // 同一个缝隙里「上一行之后」和「下一行之前」落点等价；优先选下一行之前，
      // 让指示线画在下一行上沿，用户能看到线从哪一行开始。
      if (
        !best ||
        dist < best.dist - 0.01 ||
        (Math.abs(dist - best.dist) <= 0.01 && side === "before" && best.side === "after")
      ) {
        best = { row, side, dist };
      }
    }
    return best ? { row: best.row, side: best.side } : null;
  }

  /** 目标文件夹当前显示顺序里的最后一个非拖拽子项，用于「移入文件夹」落到末尾 */
  private lastChildPath(folderPath: string): string | null {
    if (!this.draggedItem) return null;
    const folder =
      folderPath === "/"
        ? this.host.app.vault.getRoot()
        : this.host.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return null;

    const view = this.getExplorerViewFor(this.explorerEl);
    let sorted: { file: TAbstractFile }[];
    try {
      sorted =
        view?.getSortedFolderItems?.(folder) ?? folder.children.map((file) => ({ file }));
    } catch {
      sorted = folder.children.map((file) => ({ file }));
    }

    for (let i = sorted.length - 1; i >= 0; i--) {
      const file = sorted[i].file;
      if (file.path === this.draggedItem.path || this.draggingPaths.has(file.path)) continue;
      return file.path;
    }
    return null;
  }

  private resolveTitleTarget(title: HTMLElement): void {
    const row = title.closest<HTMLElement>(".tree-item");
    if (!row) return;
    const rect = title.getBoundingClientRect();
    const isFolder = title.classList.contains("nav-folder-title");

    if (isFolder) {
      const ratio = rect.height > 0 ? (this.pointer.y - rect.top) / rect.height : 0.5;
      if (ratio > FOLDER_INSIDE_TOP && ratio < FOLDER_INSIDE_BOTTOM) {
        if (this.draggedPinned || this.isSelfOrDescendant(row)) {
          this.clearPendingExpand();
          return;
        }
        const folderPath = this.resolveItemPath(row);
        if (!folderPath || this.draggingPaths.has(folderPath)) {
          this.clearPendingExpand();
          return;
        }
        this.dropFolder = row;
        if (row.classList.contains("is-collapsed")) this.scheduleFolderExpand(row);
        else this.clearPendingExpand();
        return;
      }
      this.clearPendingExpand();
      this.setSiblingTarget(row, ratio < 0.5 ? "before" : "after");
      return;
    }

    this.clearPendingExpand();
    this.setSiblingTarget(row, this.pointer.y < rect.top + rect.height / 2 ? "before" : "after");
  }

  private setSiblingTarget(row: HTMLElement, side: "before" | "after"): void {
    if (this.isSelfOrDescendant(row)) return;
    const rowPath = this.resolveItemPath(row);
    if (!rowPath || this.draggingPaths.has(rowPath)) return;

    const folderEl = this.parentFolderOf(row);
    const folderPath = this.resolveItemPath(folderEl);
    if (!folderPath) return;

    const rowPinned = this.host.getItemSettings(rowPath).isPinned;
    if (rowPinned !== this.draggedPinned) return;
    if (this.draggedPinned && this.draggedItem?.parent?.path !== folderPath) return;

    // 落在条目上/下沿就是「手动排序」意图。与单库树同一套语义：
    // 目标文件夹当前不是自定义顺序时，在真正落点时先固化为自定义，
    // 否则界面仍按名称/时间排，落点会被无视（用户看到的就是「拖了没反应」）。
    this.dropSibling = row;
    this.insertSide = side;
    this.dropFolder = folderEl;
  }

  /** 把目标文件夹当前显示顺序固化成 customOrder，再切到自定义顺序 */
  private ensureCustomSortMode(folderPath: string): void {
    const items = this.host.getSettings().items;
    let folderSettings = items[folderPath] as FolderSettings | undefined;
    if (folderSettings?.sortOrder === "custom") return;

    const folder =
      folderPath === "/"
        ? this.host.app.vault.getRoot()
        : this.host.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return;

    const view = this.getExplorerViewFor(this.explorerEl);
    let sorted: { file: TAbstractFile }[];
    try {
      sorted =
        view?.getSortedFolderItems?.(folder) ?? folder.children.map((file) => ({ file }));
    } catch {
      sorted = folder.children.map((file) => ({ file }));
    }

    if (!folderSettings) {
      folderSettings = {
        isPinned: false,
        isHidden: false,
        sortOrder: "custom",
        customOrder: [],
      };
      items[folderPath] = folderSettings;
    }
    folderSettings.customOrder = sorted.map((entry) => entry.file.name);
    folderSettings.sortOrder = "custom";
  }

  private parentFolderOf(row: HTMLElement): HTMLElement | null {
    const container = row.parentElement;
    if (container?.classList.contains("nav-folder-children")) {
      return container.parentElement?.closest<HTMLElement>(".nav-folder") ?? null;
    }
    return (this.explorerEl?.firstElementChild as HTMLElement | null) ?? null;
  }

  /** 被拖行本身或它的后代（拖文件夹时不能落进自己里面） */
  private isSelfOrDescendant(row: HTMLElement): boolean {
    return !!this.draggedRow && (row === this.draggedRow || this.draggedRow.contains(row));
  }

  private applyDropIndicators(): void {
    if (this.dropSibling) this.dropSibling.dataset.kbDropSibling = this.insertSide;
    if (this.dropFolder && !this.dropSibling) this.dropFolder.dataset.kbDropFolder = "";
  }

  /** 只清上一次的两个落点，不做全文档查询——上万行时 querySelectorAll 会在每一帧拖垮界面 */
  private clearDropIndicators(): void {
    if (this.dropSibling) delete this.dropSibling.dataset.kbDropSibling;
    if (this.dropFolder) delete this.dropFolder.dataset.kbDropFolder;
    this.dropSibling = null;
    this.dropFolder = null;
  }

  private commitDrop(): void {
    if (!this.draggedItem) return;

    const dropFolderPath = this.resolveItemPath(this.dropFolder);
    if (!dropFolderPath) return this.log("Drop folder not found, skipping");
    let dropSiblingPath = this.resolveItemPath(this.dropSibling);
    const droppedOnSibling = !!dropSiblingPath;

    // 只有落在条目上/下沿才代表手动排序；「移入文件夹」不动排序模式
    if (droppedOnSibling) this.ensureCustomSortMode(dropFolderPath);
    else {
      // 没有画线＝移入文件夹：落到该文件夹末尾，而不是悄悄插到最前面
      dropSiblingPath = this.lastChildPath(dropFolderPath);
    }

    const selectedItems = this.getSelectedItems();
    const isDraggedSelected = selectedItems.some((item) => item.file === this.draggedItem);
    this.pendingScrollTop = this.explorerEl
      ? { container: this.explorerEl, top: this.explorerEl.scrollTop }
      : null;

    if (isDraggedSelected && selectedItems.length > 0) {
      const pinnedStates = new Set(
        selectedItems.map((item) => this.host.getItemSettings(item.file.path).isPinned)
      );
      if (pinnedStates.size > 1) return this.log("Selection mixes pinned/unpinned, skipping");

      if (pinnedStates.has(true)) {
        const parentPaths = new Set(selectedItems.map((item) => item.file.parent?.path));
        if (parentPaths.size > 1) return this.log("Pinned selection spans folders, skipping");
      }

      const firstSide = droppedOnSibling ? this.insertSide : "after";
      selectedItems.forEach((item, idx) => {
        const insertSide = idx === 0 ? firstSide : "after";
        const newPath = this.resolveNewPath(item.file, dropFolderPath);
        this.moveItem(item.file, newPath, dropFolderPath, dropSiblingPath, insertSide);
        dropSiblingPath = newPath;
      });
    } else {
      const newPath = this.resolveNewPath(this.draggedItem, dropFolderPath);
      this.moveItem(
        this.draggedItem,
        newPath,
        dropFolderPath,
        dropSiblingPath,
        droppedOnSibling ? this.insertSide : "after"
      );
    }

    this.scheduleScrollRestore();
  }

  /**
   * 排序后把滚动位置拉回用户拖动时所在的位置。
   * Obsidian 开启「自动显示当前文件」时会在重排后把活动文件滚回视野，
   * 用户刚排好的位置就被抢走；这里覆盖这次滚动，活动文件切换时的自动定位不受影响。
   */
  private scheduleScrollRestore(): void {
    const pending = this.pendingScrollTop;
    if (!pending) return;
    this.pendingScrollTop = null;

    const restore = (): void => {
      if (pending.container.isConnected) pending.container.scrollTop = pending.top;
    };
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
    // 原生 sort() 有时会在下一拍才补滚动，再兜一次
    window.setTimeout(restore, 80);
  }

  private resetDrag(): void {
    this.clearDropIndicators();
    this.clearPendingExpand();
    this.stopAutoscroll();

    this.draggedItem = null;
    this.draggedRow = null;
    this.draggedPinned = false;
    this.draggingPaths.clear();
    this.explorerEl = null;
    this.explorerRect = null;
    document.body.classList.remove("kb-dragging");
  }

  private isPointerInsideExplorer(): boolean {
    const rect = this.explorerRect;
    if (!rect) return false;
    return (
      this.pointer.x >= rect.left &&
      this.pointer.x <= rect.right &&
      this.pointer.y >= rect.top &&
      this.pointer.y <= rect.bottom
    );
  }

  private selfOf(el: HTMLElement | null): HTMLElement | null {
    if (!el) return null;
    if (el.matches(".tree-item-self")) return el;
    const direct = el.querySelector<HTMLElement>(":scope > .tree-item-self");
    if (direct) return direct;
    return el.closest<HTMLElement>(".tree-item")?.querySelector<HTMLElement>(
      ":scope > .tree-item-self"
    ) ?? null;
  }

  private resolveItemPath(el: HTMLElement | null): string | null {
    if (!el) return null;
    if (el === this.explorerEl?.firstElementChild) return "/";
    const self = this.selfOf(el);
    const path = self?.dataset.path;
    if (path) return path;
    const row = el.matches(".tree-item") ? el : el.closest<HTMLElement>(".tree-item");
    return this.getExplorerViewFor(this.explorerEl)?.files?.get(row)?.path ?? null;
  }

  private getExplorerViewFor(el: HTMLElement | null): any {
    const leaves = this.host.app.workspace.getLeavesOfType("file-explorer");
    if (el) {
      for (const leaf of leaves) {
        const view: any = leaf.view;
        if (view?.containerEl?.contains(el)) return view;
      }
    }
    return leaves[0]?.view ?? null;
  }

  private getSelectedItems(): { el: HTMLElement; file: TAbstractFile }[] {
    const view = this.getExplorerViewFor(this.explorerEl);
    const selectedDoms = view?.tree?.selectedDoms;
    if (!selectedDoms) return [];

    const selectedItems = [...selectedDoms] as { el: HTMLElement; file: TAbstractFile }[];
    const resolved = selectedItems
      .map((selected) => {
        const path = selected.el ? this.resolveItemPath(selected.el) : selected.file?.path;
        const file = path ? this.host.app.vault.getAbstractFileByPath(path) : selected.file;
        return file ? { el: selected.el, file } : null;
      })
      .filter((item): item is { el: HTMLElement; file: TAbstractFile } => !!item);

    const nonNestedItems = resolved.filter(
      (selected) =>
        !resolved.some(
          (selectedFolder) =>
            selectedFolder.file instanceof TFolder &&
            selectedFolder.file.path !== selected.file.path &&
            selected.file.path.startsWith(selectedFolder.file.path + "/")
        )
    );

    return nonNestedItems.sort((a, b) => {
      if (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  private resolveNewPath(item: TAbstractFile, newParentPath: string): string {
    const prefix = newParentPath === "/" ? "" : `${newParentPath}/`;
    let newPath = `${prefix}${item.name}`;

    const isPathChanged = item.path !== newPath;
    const vault: any = this.host.app?.vault;
    const duplicate = vault?.getAbstractFileByPathInsensitive?.(newPath) ?? null;

    if (isPathChanged && duplicate) {
      if (item instanceof TFile) {
        const basePath = newPath.slice(0, -(item.extension.length + 1));
        newPath = vault.getAvailablePath(basePath, item.extension);
      } else if (item instanceof TFolder) {
        newPath = vault.getAvailablePath(newPath, "");
      }
    }
    return newPath;
  }

  private moveItem(
    draggedItem: TAbstractFile,
    newPath: string,
    folderPath: string,
    siblingPath: string | null,
    insertSide: typeof this.insertSide
  ): void {
    const folderSettings = this.host.getSettings().items[folderPath] as
      | FolderSettings
      | undefined;
    if (draggedItem.path === newPath && folderSettings?.sortOrder !== "custom") {
      return this.log("Already in drop folder with non-custom order, skipping");
    }

    this.host.orderManager.move(draggedItem.path, newPath, siblingPath ?? undefined, insertSide);
    void this.host.app?.fileManager?.renameFile(draggedItem, newPath);
  }

  private startAutoscroll(): void {
    if (!this.autoscrollRaf)
      this.autoscrollRaf = window.requestAnimationFrame(this.handleAutoscroll);
  }

  private stopAutoscroll(): void {
    window.cancelAnimationFrame(this.autoscrollRaf);
    this.autoscrollRaf = 0;
  }

  private readonly handleAutoscroll = (): void => {
    if (!this.explorerEl || !this.explorerRect || !this.draggedItem) {
      this.autoscrollRaf = 0;
      return;
    }

    if (this.pointer.x < this.explorerRect.left || this.pointer.x > this.explorerRect.right) {
      this.autoscrollRaf = 0;
      return;
    }

    const distToTop = this.pointer.y - this.explorerRect.top;
    const distToBottom = this.explorerRect.bottom - this.pointer.y;

    let speed = 0;
    if (distToTop < this.autoscrollZoneHeight) speed = -this.resolveScrollSpeed(distToTop);
    else if (distToBottom < this.autoscrollZoneHeight) speed = this.resolveScrollSpeed(distToBottom);

    if (!speed) {
      this.autoscrollRaf = 0;
      return;
    }

    const before = this.explorerEl.scrollTop;
    this.explorerEl.scrollTop += speed;
    if (this.explorerEl.scrollTop === before) {
      this.autoscrollRaf = 0;
      return;
    }
    this.resolveAndApplyDropTarget();
    this.autoscrollRaf = window.requestAnimationFrame(this.handleAutoscroll);
  };

  private resolveScrollSpeed(distToEdge: number): number {
    return (1 - distToEdge / this.autoscrollZoneHeight) ** 2 * this.edgeScrollSpeed;
  }

  private scheduleFolderExpand(folderEl: HTMLElement): void {
    this.clearPendingExpand();
    this.expandTarget = folderEl;
    this.expandTimeout = window.setTimeout(() => {
      const folderPath = this.resolveItemPath(folderEl);
      if (!folderPath) return;
      const view = this.getExplorerViewFor(this.explorerEl);
      const folderItem = view?.fileItems?.[folderPath];
      void folderItem?.setCollapsed?.(false, true);
      this.log(`Folder '${folderPath}' expanded after timeout`);
    }, this.expandDelay);
  }

  private clearPendingExpand(): void {
    window.clearTimeout(this.expandTimeout);
    this.expandTarget = null;
  }

}
