import { TAbstractFile, TFile, TFolder } from "obsidian";
import type { FolderSettings } from "../core/order-types";
import { initLog } from "../core/log";
import type {
  TreeChildRowRect,
  TreeDndHost,
  TreeDndSurface,
  TreeDropSide,
  TreeDropTarget,
  TreeRowHit,
} from "./tree-types";

/** 文件夹行上/下沿各 30% 用于「排到前/后」，中间 40% 才判定为「移入」 */
const FOLDER_INSIDE_TOP = 0.3;
const FOLDER_INSIDE_BOTTOM = 0.7;

const AUTOSCROLL_ZONE = 60;
const AUTOSCROLL_SPEED = 20;
const EXPAND_DELAY = 1000;

type VaultCompat = {
  getAbstractFileByPathInsensitive?: (path: string) => TAbstractFile | null;
  getAvailablePath: (path: string, extension: string) => string;
};

interface ActiveDrag {
  surface: TreeDndSurface;
  file: TAbstractFile;
  pinned: boolean;
}

/**
 * 原生树与单库树共用的拖拽规则。
 * 只负责「怎么判定落点、怎么落、拖拽辅助行为」，DOM/模型细节全部交给 Surface。
 */
export class TreeDndController {
  private readonly log = initLog("TREE DND", "#a6ff00");

  private attached = false;
  private drag: ActiveDrag | null = null;
  private draggingPaths = new Set<string>();
  private dropTarget: TreeDropTarget | null = null;
  private pointer = { x: 0, y: 0 };

  private autoscrollRaf = 0;
  private expandPath: string | null = null;
  private expandTimeout = 0;

  constructor(private readonly host: TreeDndHost) {}

  /** 挂在 document 上：文件浏览器重建、多个 Files 面板都不影响监听 */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    document.addEventListener("dragstart", this.onDragStart, true);
    document.addEventListener("dragover", this.onDragOver, true);
    document.addEventListener("drop", this.onDrop, true);
    document.addEventListener("dragend", this.onDragEnd, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("mousemove", this.onMouseMove, true);
    window.addEventListener("blur", this.onWindowBlur);
    this.log("Attached");
  }

  detach(): void {
    document.removeEventListener("dragstart", this.onDragStart, true);
    document.removeEventListener("dragover", this.onDragOver, true);
    document.removeEventListener("drop", this.onDrop, true);
    document.removeEventListener("dragend", this.onDragEnd, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("mousemove", this.onMouseMove, true);
    window.removeEventListener("blur", this.onWindowBlur);
    this.attached = false;
    this.resetDrag();
    this.log("Detached");
  }

  get draggedItem(): TAbstractFile | null {
    return this.drag?.file ?? null;
  }

  get activeSurface(): TreeDndSurface | null {
    return this.drag?.surface ?? null;
  }

  get dropSiblingPath(): string | null {
    return this.dropTarget?.kind === "sibling" ? this.dropTarget.siblingPath : null;
  }

  get dropFolderPath(): string | null {
    return this.dropTarget?.folderPath ?? null;
  }

  private readonly onDragStart = (event: DragEvent): void => {
    if (this.drag) return;
    const source = this.host.resolveSource(event.target);
    if (!source) return;

    const file = this.host.app.vault.getAbstractFileByPath(source.path);
    if (!file) return;

    this.drag = {
      surface: source.surface,
      file,
      pinned: this.isPinned(file.path),
    };
    this.draggingPaths = new Set(source.surface.selectedPaths());
    this.draggingPaths.add(file.path);

    document.body.classList.add("kb-dragging");
    source.surface.markDragSource?.(file.path, true);
    source.surface.onDragStart?.(event, file.path);
    this.log(`Started dragging '${file.path}'`);
  };

  private readonly onDragOver = (event: DragEvent): void => {
    if (!this.drag) return;

    this.pointer = { x: event.clientX, y: event.clientY };
    this.drag.surface = this.host.resolveTargetSurface(this.drag.surface, this.pointer);
    this.drag.surface.onDragOver?.();
    this.startAutoscroll();

    if (!this.drag.surface.containsPoint(this.pointer.x, this.pointer.y)) {
      this.clearDropIndicators();
      this.clearPendingExpand();
      return;
    }

    if (this.resolveAndApplyDropTarget()) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
  };

  private readonly onDrop = (event: DragEvent): void => {
    if (!this.drag) return;

    this.pointer = { x: event.clientX, y: event.clientY };
    this.drag.surface = this.host.resolveTargetSurface(this.drag.surface, this.pointer);

    if (!this.drag.surface.containsPoint(this.pointer.x, this.pointer.y)) {
      this.log("Dropped outside tree, skipping move");
      this.resetDrag();
      return;
    }

    event.preventDefault();
    // 用最后一次 dragover 已经显示给用户的落点，不在 drop 时重新判定：
    // 重新命中可能因为 1px 抖动/滚动把 before/after 翻面，出现「线在上、落在下」。
    if (!this.dropTarget) this.resolveAndApplyDropTarget();
    this.commitDrop();
    this.resetDrag();
  };

  private readonly onDragEnd = (): void => {
    if (!this.drag) return;
    this.log(`Ended dragging '${this.drag.file.path}'`);
    this.resetDrag();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.drag && event.key === "Escape") this.resetDrag();
  };

  /** 新指针手势意味着上一次拖拽已结束但没收尾（拖拽源被重绘替换时 Chrome 可能不发 dragend） */
  private readonly onPointerDown = (): void => {
    if (this.drag) this.resetDrag();
  };

  /** 拖拽期间浏览器会吞掉 mousemove；重新出现 buttons=0 的移动说明拖拽已结束 */
  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.drag && event.buttons === 0) this.resetDrag();
  };

  private readonly onWindowBlur = (): void => {
    if (this.drag) this.resetDrag();
  };

  private resolveAndApplyDropTarget(): boolean {
    this.clearDropIndicators();
    this.resolveDropTarget();
    this.applyDropIndicators();
    return !!this.dropTarget;
  }

  private resolveDropTarget(): void {
    const drag = this.drag;
    if (!drag) return;

    const hit = drag.surface.resolveRowAtPoint(this.pointer.x, this.pointer.y);
    if (hit) {
      this.resolveRowTarget(hit);
      return;
    }

    const folderPath = drag.surface.blankFolderAt(this.pointer.x, this.pointer.y);
    if (folderPath === null) return;
    this.resolveBlankTarget(folderPath);
  }

  private resolveRowTarget(hit: TreeRowHit): void {
    const drag = this.drag;
    if (!drag || !drag.surface.isInScope(hit.path)) return;

    if (hit.kind === "file") {
      this.clearPendingExpand();
      const ratio =
        hit.rect.height > 0 ? (this.pointer.y - hit.rect.top) / hit.rect.height : 0.5;
      this.setSiblingTarget(hit.path, ratio < 0.5 ? "before" : "after");
      return;
    }

    const ratio = hit.rect.height > 0 ? (this.pointer.y - hit.rect.top) / hit.rect.height : 0.5;
    if (ratio > FOLDER_INSIDE_TOP && ratio < FOLDER_INSIDE_BOTTOM) {
      if (drag.pinned || this.isSelfOrDescendant(hit.path) || this.draggingPaths.has(hit.path)) {
        this.clearPendingExpand();
        return;
      }
      this.dropTarget = { kind: "folder", folderPath: hit.path };
      if (drag.surface.isCollapsed(hit.path)) this.scheduleFolderExpand(hit.path);
      else this.clearPendingExpand();
      return;
    }

    this.clearPendingExpand();
    this.setSiblingTarget(hit.path, ratio < 0.5 ? "before" : "after");
  }

  /** 空白/行距/右侧留白：按方向感知找最近的同级行；没有行才退化成移入文件夹 */
  private resolveBlankTarget(folderPath: string): void {
    const drag = this.drag;
    if (!drag || !folderPath) return;

    this.clearPendingExpand();

    if (!drag.surface.isInScope(folderPath)) return;
    if (this.isSelfOrDescendant(folderPath)) return;
    if (this.draggingPaths.has(folderPath)) return;
    if (drag.pinned && drag.file.parent?.path !== folderPath) return;

    const near = this.nearestSiblingRow(folderPath);
    if (near) {
      this.setSiblingTarget(near.path, near.side);
      if (this.dropTarget?.kind === "sibling") return;
    }

    if (drag.pinned) return;
    this.dropTarget = { kind: "folder", folderPath };
  }

  /** 在文件夹的直接子行里找离指针最近的一行，并给出「前/后」方向 */
  private nearestSiblingRow(
    folderPath: string
  ): { path: string; side: TreeDropSide } | null {
    const drag = this.drag;
    if (!drag) return null;

    const rows: TreeChildRowRect[] = drag.surface.childRowRects(folderPath);
    let best: { path: string; side: TreeDropSide; dist: number } | null = null;

    for (const row of rows) {
      if (this.isSelfOrDescendant(row.path)) continue;
      if (this.draggingPaths.has(row.path)) continue;

      const pinned = this.isPinned(row.path);
      if (pinned !== drag.pinned) continue;
      if (drag.pinned && drag.file.parent?.path !== folderPath) continue;

      const rect = row.rect;
      let side: TreeDropSide;
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
        best = { path: row.path, side, dist };
      }
    }

    return best ? { path: best.path, side: best.side } : null;
  }

  private setSiblingTarget(rowPath: string, side: TreeDropSide): void {
    const drag = this.drag;
    if (!drag) return;
    if (this.isSelfOrDescendant(rowPath)) return;
    if (this.draggingPaths.has(rowPath)) return;

    const folderPath = this.parentPathOf(rowPath);
    if (!folderPath || !drag.surface.isInScope(folderPath)) return;

    if (this.isPinned(rowPath) !== drag.pinned) return;
    if (drag.pinned && drag.file.parent?.path !== folderPath) return;

    // 落在条目上/下沿就是「手动排序」意图：目标文件夹不是自定义顺序时，
    // 在真正落点时先固化为自定义，否则界面仍按名称/时间排，落点会被无视。
    this.dropTarget = { kind: "sibling", folderPath, siblingPath: rowPath, side };
  }

  private applyDropIndicators(): void {
    const target = this.dropTarget;
    const drag = this.drag;
    if (!target || !drag) return;
    if (target.kind === "sibling") drag.surface.markSibling(target.siblingPath, target.side);
    else drag.surface.markFolder(target.folderPath);
  }

  private clearDropIndicators(): void {
    this.drag?.surface.clearMarks();
    this.dropTarget = null;
  }

  private commitDrop(): void {
    const drag = this.drag;
    const target = this.dropTarget;
    if (!drag || !target) return;

    const surface = drag.surface;
    const dropFolderPath = target.folderPath;
    if (!surface.isInScope(dropFolderPath)) {
      this.log("Drop target outside scope, skipping");
      return;
    }

    const dropFolder = this.folderAt(dropFolderPath);
    if (!dropFolder) {
      this.log("Drop folder not found, skipping");
      return;
    }

    let dropSiblingPath = target.kind === "sibling" ? target.siblingPath : null;
    const droppedOnSibling = target.kind === "sibling";

    // 只有落在条目上/下沿才代表手动排序；「移入文件夹」不动排序模式
    if (droppedOnSibling) {
      this.ensureCustomSortMode(dropFolderPath);
    } else {
      // 没有画线＝移入文件夹：落到该文件夹末尾，而不是悄悄插到最前面
      dropSiblingPath = this.lastChildPath(dropFolderPath);
    }

    const selectedItems = this.resolveSelectedFiles();
    const isDraggedSelected = selectedItems.some((item) => item.path === drag.file.path);

    if (isDraggedSelected && selectedItems.length > 0) {
      const pinnedStates = new Set(selectedItems.map((item) => this.isPinned(item.path)));
      if (pinnedStates.size > 1) {
        this.log("Selection mixes pinned/unpinned, skipping");
        return;
      }
      if (pinnedStates.has(true)) {
        const parentPaths = new Set(selectedItems.map((item) => item.parent?.path));
        if (parentPaths.size > 1) {
          this.log("Pinned selection spans folders, skipping");
          return;
        }
      }

      surface.captureScroll();
      const firstSide: TreeDropSide = droppedOnSibling ? target.side : "after";
      selectedItems.forEach((item, idx) => {
        const insertSide: TreeDropSide = idx === 0 ? firstSide : "after";
        const newPath = this.resolveNewPath(item, dropFolderPath);
        this.moveItem(item, newPath, dropFolderPath, dropSiblingPath, insertSide);
        dropSiblingPath = newPath;
      });
    } else {
      surface.captureScroll();
      const newPath = this.resolveNewPath(drag.file, dropFolderPath);
      this.moveItem(
        drag.file,
        newPath,
        dropFolderPath,
        dropSiblingPath,
        droppedOnSibling ? target.side : "after"
      );
    }

    surface.restoreScrollAfterMoves();
  }

  /** 把目标文件夹当前显示顺序固化成 customOrder，再切到自定义顺序 */
  private ensureCustomSortMode(folderPath: string): void {
    const items = this.host.getSettings().items;
    let folderSettings = items[folderPath] as FolderSettings | undefined;
    if (folderSettings?.sortOrder === "custom") return;

    const folder = this.folderAt(folderPath);
    const surface = this.drag?.surface;
    if (!folder || !surface) return;

    if (!folderSettings) {
      folderSettings = {
        isPinned: false,
        isHidden: false,
        sortOrder: "custom",
        customOrder: [],
      };
      items[folderPath] = folderSettings;
    }
    folderSettings.customOrder = surface
      .orderedChildPaths(folderPath)
      .map((path) => this.nameOf(path));
    folderSettings.sortOrder = "custom";
  }

  /** 目标文件夹当前显示顺序里的最后一个非拖拽子项，用于「移入文件夹」落到末尾 */
  private lastChildPath(folderPath: string): string | null {
    const drag = this.drag;
    if (!drag) return null;
    const ordered = drag.surface.orderedChildPaths(folderPath);
    for (let i = ordered.length - 1; i >= 0; i--) {
      const path = ordered[i];
      if (path === drag.file.path || this.draggingPaths.has(path)) continue;
      return path;
    }
    return null;
  }

  private resolveSelectedFiles(): TAbstractFile[] {
    const drag = this.drag;
    if (!drag) return [];

    const vault = this.host.app.vault;
    const files = drag.surface
      .selectedPaths()
      .map((path) => vault.getAbstractFileByPath(path))
      .filter((file): file is TAbstractFile => !!file);

    return files.filter(
      (file) =>
        !files.some(
          (folderCandidate) =>
            folderCandidate instanceof TFolder &&
            folderCandidate.path !== file.path &&
            file.path.startsWith(folderCandidate.path + "/")
        )
    );
  }

  private resolveNewPath(item: TAbstractFile, newParentPath: string): string {
    const prefix = newParentPath === "/" ? "" : `${newParentPath}/`;
    let newPath = `${prefix}${item.name}`;

    const isPathChanged = item.path !== newPath;
    const vault = this.host.app.vault as typeof this.host.app.vault & VaultCompat;
    const duplicate = vault.getAbstractFileByPathInsensitive?.(newPath) ?? null;

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
    item: TAbstractFile,
    newPath: string,
    folderPath: string,
    siblingPath: string | null,
    insertSide: TreeDropSide
  ): void {
    const folderSettings = this.host.getSettings().items[folderPath] as
      | FolderSettings
      | undefined;
    if (item.path === newPath && folderSettings?.sortOrder !== "custom") {
      this.log("Already in drop folder with non-custom order, skipping");
      return;
    }

    this.host.orderManager.move(item.path, newPath, siblingPath ?? undefined, insertSide);
    void this.host.app.fileManager?.renameFile(item, newPath);
  }

  private startAutoscroll(): void {
    if (!this.autoscrollRaf) {
      this.autoscrollRaf = window.requestAnimationFrame(this.handleAutoscroll);
    }
  }

  private stopAutoscroll(): void {
    window.cancelAnimationFrame(this.autoscrollRaf);
    this.autoscrollRaf = 0;
  }

  private readonly handleAutoscroll = (): void => {
    const drag = this.drag;
    const el = drag?.surface.scrollEl ?? null;
    const rect = drag?.surface.scrollRect() ?? null;
    if (!drag || !el || !rect) {
      this.autoscrollRaf = 0;
      return;
    }

    if (this.pointer.x < rect.left || this.pointer.x > rect.right) {
      this.autoscrollRaf = 0;
      return;
    }

    const distToTop = this.pointer.y - rect.top;
    const distToBottom = rect.bottom - this.pointer.y;

    let speed = 0;
    if (distToTop < AUTOSCROLL_ZONE) speed = -this.resolveScrollSpeed(distToTop);
    else if (distToBottom < AUTOSCROLL_ZONE) speed = this.resolveScrollSpeed(distToBottom);

    if (!speed) {
      this.autoscrollRaf = 0;
      return;
    }

    const before = el.scrollTop;
    el.scrollTop += speed;
    if (el.scrollTop === before) {
      this.autoscrollRaf = 0;
      return;
    }

    this.resolveAndApplyDropTarget();
    this.autoscrollRaf = window.requestAnimationFrame(this.handleAutoscroll);
  };

  private resolveScrollSpeed(distToEdge: number): number {
    return (1 - distToEdge / AUTOSCROLL_ZONE) ** 2 * AUTOSCROLL_SPEED;
  }

  private scheduleFolderExpand(folderPath: string): void {
    this.clearPendingExpand();
    this.expandPath = folderPath;
    this.expandTimeout = window.setTimeout(() => {
      const surface = this.drag?.surface;
      if (!surface) return;
      surface.expand(folderPath);
      this.log(`Folder '${folderPath}' expanded after timeout`);
    }, EXPAND_DELAY);
  }

  private clearPendingExpand(): void {
    window.clearTimeout(this.expandTimeout);
    this.expandTimeout = 0;
    this.expandPath = null;
  }

  private resetDrag(): void {
    const drag = this.drag;
    if (drag) {
      drag.surface.clearMarks();
      drag.surface.markDragSource?.(drag.file.path, false);
    }

    this.clearPendingExpand();
    this.stopAutoscroll();

    this.drag = null;
    this.dropTarget = null;
    this.draggingPaths.clear();
    this.pointer = { x: 0, y: 0 };
    document.body.classList.remove("kb-dragging");
  }

  private isSelfOrDescendant(path: string): boolean {
    const drag = this.drag;
    if (!drag) return false;
    return path === drag.file.path || path.startsWith(drag.file.path + "/");
  }

  private isPinned(path: string): boolean {
    return this.host.getItemSettings(path).isPinned;
  }

  private folderAt(path: string): TFolder | null {
    const folder =
      path === "/"
        ? this.host.app.vault.getRoot()
        : this.host.app.vault.getAbstractFileByPath(path);
    return folder instanceof TFolder ? folder : null;
  }

  private parentPathOf(path: string): string | null {
    const parent = this.host.app.vault.getAbstractFileByPath(path)?.parent;
    if (parent) return parent.path;
    const cut = path.lastIndexOf("/");
    return cut <= 0 ? "/" : path.slice(0, cut);
  }

  private nameOf(path: string): string {
    return path.substring(path.lastIndexOf("/") + 1);
  }
}
