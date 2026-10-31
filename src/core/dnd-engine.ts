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
 */
export class DndEngine {
  private readonly log = initLog("DND ENGINE", "#a6ff00");
  private readonly sparseLog = this.initSparseLog(500);

  private explorerEl: HTMLElement | null = null;
  private explorerRect: DOMRect | null = null;

  private draggedItem: TAbstractFile | null = null;
  /** 本次拖拽涉及的路径（被拖条目 + 多选中的其余条目），不参与落点候选 */
  private draggingPaths = new Set<string>();
  private dropSibling: HTMLElement | null = null;
  private dropFolder: HTMLElement | null = null;
  private insertSide: "before" | "after" = "before";
  private pointer = { x: 0, y: 0 };
  private readonly levelOffset = 5;

  private readonly autoscrollZoneHeight = 60;
  private readonly edgeScrollSpeed = 20;
  private autoscrollRaf = 0;

  private readonly expandDelay = 1000;
  private expandTarget: HTMLElement | null = null;
  private expandTimeout = 0;

  constructor(private readonly host: DndHost) {}

  attach(explorerEl: HTMLElement): void {
    if (explorerEl === this.explorerEl) return this.log("Already attached");

    // 文件浏览器重建后必须把监听从旧节点摘掉：旧节点已脱离文档，
    // 留着它会让 attach 把 this.explorerEl 指回死节点，新树的拖拽全部失效。
    this.unlistenExplorer();
    this.explorerEl = explorerEl;

    explorerEl.addEventListener("dragstart", this.onDragStart);
    document.addEventListener("dragover", this.onDragOver);
    explorerEl.addEventListener("scroll", this.onScroll);
    document.addEventListener("drop", this.onDrop, { capture: true });
    explorerEl.addEventListener("dragend", this.onDragEnd);

    this.log("Attached to explorer");
  }

  detach(): void {
    document.removeEventListener("dragover", this.onDragOver);
    document.removeEventListener("drop", this.onDrop, { capture: true });
    this.unlistenExplorer();
    this.log("Detached");
  }

  private unlistenExplorer(): void {
    if (!this.explorerEl) return;
    this.explorerEl.removeEventListener("dragstart", this.onDragStart);
    this.explorerEl.removeEventListener("scroll", this.onScroll);
    this.explorerEl.removeEventListener("dragend", this.onDragEnd);
    this.explorerEl = null;
    this.explorerRect = null;
  }

  private readonly onDragStart = (event: DragEvent): void => {
    const closestTreeItem = (event.target as HTMLElement).closest<HTMLElement>(".tree-item");
    if (!closestTreeItem) return;

    const view = this.host.getExplorerView();
    this.draggedItem = view?.files?.get(closestTreeItem) ?? null;
    if (!this.draggedItem) return;

    this.draggingPaths = new Set(this.getSelectedItems().map((item) => item.file.path));
    this.draggingPaths.add(this.draggedItem.path);

    this.explorerRect = this.explorerEl!.getBoundingClientRect();
    document.body.classList.add("kb-dragging");
    this.log(`Started dragging '${this.draggedItem.path}'`);
  };

  private readonly onDragOver = (event: DragEvent): void => {
    if (!this.draggedItem) return;

    // 阻止 Obsidian 自动展开被拖拽/相邻的折叠文件夹
    const view = this.host.getExplorerView();
    if (view) view.lastDropTargetEl = null;

    this.pointer = { x: event.clientX, y: event.clientY };
    this.startAutoscroll();

    if (this.isPointerInsideExplorer()) {
      this.updateDragState();
    } else {
      if (this.dropSibling || this.dropFolder)
        this.log("Cursor left explorer, clearing indicators");
      this.updateDragState.cancel();
      this.clearDropIndicators();
      this.dropSibling = null;
      this.dropFolder = null;
    }
  };

  private readonly onScroll = (): void => {
    if (!this.draggedItem || !this.isPointerInsideExplorer()) return;
    this.sparseLog("Scrolled during dragging, updating drag state");
    this.updateDragState();
  };

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

  private readonly onDrop = (event: DragEvent): void => {
    if (!this.draggedItem) return;
    this.log(`Dropped '${this.draggedItem.path}'`);

    if (this.explorerEl?.contains(event.target as Node)) {
      event.preventDefault();
      this.commitDrop();
    } else {
      this.log("Dropped outside explorer, skipping move");
    }
    this.onDragEnd();
  };

  private commitDrop(): void {
    if (!this.draggedItem) return;

    let dropSiblingPath = this.resolveItemPath(this.dropSibling);
    const dropFolderPath = this.resolveItemPath(this.dropFolder);
    if (!dropFolderPath) return this.log("Drop folder not found, skipping");

    const selectedItems = this.getSelectedItems();
    const isDraggedSelected = selectedItems.some((item) => item.file === this.draggedItem);

    if (isDraggedSelected && selectedItems.length > 0) {
      const pinnedStates = new Set(
        selectedItems.map((item) => this.host.getItemSettings(item.file.path).isPinned)
      );
      if (pinnedStates.size > 1) return this.log("Selection mixes pinned/unpinned, skipping");

      if (pinnedStates.has(true)) {
        const parentPaths = new Set(selectedItems.map((item) => item.file.parent?.path));
        if (parentPaths.size > 1) return this.log("Pinned selection spans folders, skipping");
      }

      selectedItems.forEach((item, idx) => {
        const insertSide = idx === 0 ? this.insertSide : "after";
        const newPath = this.resolveNewPath(item.file, dropFolderPath);
        this.moveItem(item.file, newPath, dropFolderPath, dropSiblingPath, insertSide);
        dropSiblingPath = newPath;
      });
    } else {
      const newPath = this.resolveNewPath(this.draggedItem, dropFolderPath);
      this.moveItem(this.draggedItem, newPath, dropFolderPath, dropSiblingPath, this.insertSide);
    }
  }

  private readonly onDragEnd = (): void => {
    if (!this.draggedItem) return;
    this.log(`Ended dragging '${this.draggedItem.path}'`);

    this.updateDragState.cancel();
    this.stopAutoscroll();
    this.clearPendingExpand();
    this.clearDropIndicators();

    this.draggedItem = null;
    this.draggingPaths.clear();
    this.dropSibling = null;
    this.dropFolder = null;
    this.explorerRect = null;
    document.body.classList.remove("kb-dragging");
  };

  private readonly updateDragState: (() => void) & { cancel: () => void } = this.rafThrottle(() => {
    if (!this.draggedItem) return;
    this.clearDropIndicators();
    this.resolveDropTarget();
    this.applyDropIndicators();
    this.sparseLog(
      `Dragging '${this.draggedItem.path}' ${this.insertSide} '${
        this.resolveItemPath(this.dropSibling) ?? ""
      }' in '${this.resolveItemPath(this.dropFolder) ?? ""}'`
    );
    this.sparseLog.flush();
  });

  private clearDropIndicators(): void {
    if (this.dropSibling) delete this.dropSibling.dataset.kbDropSibling;
    if (this.dropFolder) delete this.dropFolder.dataset.kbDropFolder;
  }

  private resolveDropTarget(): void {
    const isDraggedPinned = this.host.getItemSettings(this.draggedItem!.path).isPinned;

    this.resolveDropSibling(isDraggedPinned);
    if (this.dropSibling) {
      this.dropFolder = this.dropSibling.parentElement!.closest<HTMLElement>(
        '[data-type="file-explorer"] > .nav-files-container > div, .nav-folder'
      )!;
    }

    this.resolveHoveredFolder(isDraggedPinned);

    const dropFolderPath = this.resolveItemPath(this.dropFolder);
    if (!dropFolderPath) return;
    const dropFolderSettings = this.host.getSettings().items[dropFolderPath] as
      | FolderSettings
      | undefined;
    if (dropFolderSettings && dropFolderSettings.sortOrder !== "custom") {
      this.dropSibling = null;
    }
  }

  private resolveDropSibling(isDraggedPinned: boolean): void {
    const siblingCandidates = Array.from(
      this.explorerEl!.querySelectorAll<HTMLElement>(
        ".tree-item:not(.nav-folder:has(> .tree-item-self:is(.is-being-dragged, .is-selected)) .tree-item)"
      )
    );
    let shortestDist = Infinity;

    const view = this.host.getExplorerView();

    for (const candidate of siblingCandidates) {
      const candidateItem = view?.files?.get(candidate);
      if (!candidateItem) continue;
      // 被拖行/其它选中行本身就是移动对象：拿它当落点，线会画在自己身上看不见
      if (this.draggingPaths.has(candidateItem.path)) continue;

      const isCandidatePinned = this.host.getItemSettings(candidateItem.path).isPinned;
      if (isDraggedPinned !== isCandidatePinned) continue;
      const areInSameFolder = this.draggedItem!.parent?.path === candidateItem.parent?.path;
      if (isDraggedPinned && !areInSameFolder) continue;

      const candidateRect = candidate.getBoundingClientRect();
      const distToBottom = Math.abs(this.pointer.y - this.virtualBottom(candidate, candidateRect));
      const distToTop = Math.abs(this.pointer.y - candidateRect.top);
      const dist = Math.min(distToBottom, distToTop);

      if (dist < shortestDist) {
        shortestDist = dist;
        this.dropSibling = candidate;
        this.insertSide = distToBottom < distToTop ? "after" : "before";
      }
    }
  }

  private virtualBottom(el: HTMLElement, rect: DOMRect): number {
    let bottom = rect.bottom;
    let folder = el.matches(".nav-folder:not(.is-collapsed)") ? el : null;
    while (folder) {
      bottom += this.levelOffset;
      folder = folder.querySelector<HTMLElement>(
        ":scope > .nav-folder-children > .tree-item:nth-last-child(1 of .tree-item)" +
          ".nav-folder:not(.is-collapsed)"
      );
    }
    return bottom;
  }

  private resolveHoveredFolder(isDraggedPinned: boolean): void {
    const hoveredEl = activeDocument.elementFromPoint(this.pointer.x, this.pointer.y) as
      | HTMLElement
      | null;
    if (!hoveredEl) return;
    const closestFolderTitle = hoveredEl.closest(".nav-folder-title");
    let shouldClearExpand = true;

    if (closestFolderTitle && !isDraggedPinned) {
      const folderEl = closestFolderTitle.parentElement!;
      const view = this.host.getExplorerView();
      const draggedEl = view?.fileItems?.[this.draggedItem!.path]?.el as HTMLElement | undefined;
      const isDraggedFolder = draggedEl ? draggedEl.contains(folderEl) : false;
      const titleRect = closestFolderTitle.getBoundingClientRect();
      const ratio =
        titleRect.height > 0 ? (this.pointer.y - titleRect.top) / titleRect.height : 0.5;
      const isTitleCenterHovered = ratio > FOLDER_INSIDE_TOP && ratio < FOLDER_INSIDE_BOTTOM;

      if (isDraggedFolder) {
        this.sparseLog("Hovering over dragged folder or descendant, ignoring");
      } else if (isTitleCenterHovered) {
        this.dropFolder = folderEl;
        this.dropSibling = null;

        if (this.dropFolder.classList.contains("is-collapsed")) {
          if (folderEl !== this.expandTarget) this.scheduleFolderExpand(folderEl);
          shouldClearExpand = false;
        }
      }
    }

    if (shouldClearExpand) this.clearPendingExpand();
  }

  private applyDropIndicators(): void {
    if (this.dropSibling) this.dropSibling.dataset.kbDropSibling = this.insertSide;
    // 已在两行之间给出插入线时，不再给父文件夹刷「移入」高亮：
    // 只有悬停文件夹正中（没有同层落点）才表示要移入。
    if (this.dropFolder && !this.dropSibling) this.dropFolder.dataset.kbDropFolder = "";
  }

  private scheduleFolderExpand(folderEl: HTMLElement): void {
    this.clearPendingExpand();
    this.expandTarget = folderEl;
    this.expandTimeout = window.setTimeout(() => {
      const folderPath = this.resolveItemPath(folderEl);
      if (!folderPath) return;
      const view = this.host.getExplorerView();
      const folderItem = view?.fileItems?.[folderPath];
      void folderItem?.setCollapsed?.(false, true);
      this.log(`Folder '${folderPath}' expanded after timeout`);
    }, this.expandDelay);
  }

  private clearPendingExpand(): void {
    window.clearTimeout(this.expandTimeout);
    this.expandTarget = null;
  }

  private getSelectedItems(): { el: HTMLElement; file: TAbstractFile }[] {
    const view = this.host.getExplorerView();
    const selectedDoms = view?.tree?.selectedDoms;
    if (!selectedDoms) return [];

    const selectedItems = [...selectedDoms] as { el: HTMLElement; file: TAbstractFile }[];
    const nonNestedItems = selectedItems.filter(
      (selected) =>
        !selectedItems.some(
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

  private resolveItemPath(el: HTMLElement | null): string | null {
    if (!el) return null;
    if (el === this.explorerEl?.firstElementChild) return "/";
    const view = this.host.getExplorerView();
    return view?.files?.get(el)?.path ?? null;
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

    const distToTop = this.pointer.y - this.explorerRect.top;
    const distToBottom = this.explorerRect.bottom - this.pointer.y;

    let speed = 0;
    if (distToTop < this.autoscrollZoneHeight) speed = -this.resolveScrollSpeed(distToTop);
    else if (distToBottom < this.autoscrollZoneHeight) speed = this.resolveScrollSpeed(distToBottom);

    if (!speed) {
      this.autoscrollRaf = 0;
      return;
    }

    this.explorerEl.scrollTop += speed;
    this.autoscrollRaf = window.requestAnimationFrame(this.handleAutoscroll);
  };

  private resolveScrollSpeed(distToEdge: number): number {
    return (1 - distToEdge / this.autoscrollZoneHeight) ** 2 * this.edgeScrollSpeed;
  }

  private rafThrottle<T extends (...args: unknown[]) => void>(
    fn: T
  ): ((...args: Parameters<T>) => void) & { cancel: () => void } {
    let raf = 0;
    let latestArgs: Parameters<T>;

    const throttled = (...args: Parameters<T>) => {
      latestArgs = args;
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        fn(...latestArgs);
      });
    };

    throttled.cancel = () => {
      window.cancelAnimationFrame(raf);
      raf = 0;
    };

    return throttled;
  }

  private initSparseLog(delay: number): ((...args: unknown[]) => void) & { flush: () => void } {
    let lastFlush = 0;
    let buffer: unknown[] = [];

    const sparse = (...args: unknown[]) =>
      buffer.push(...(buffer.length ? ["\n", ...args] : args));

    sparse.flush = () => {
      if (!buffer.length) return;
      const now = Date.now();
      if (now - lastFlush >= delay) {
        lastFlush = now;
        this.log(...buffer);
      }
      buffer = [];
    };
    return sparse;
  }
}
