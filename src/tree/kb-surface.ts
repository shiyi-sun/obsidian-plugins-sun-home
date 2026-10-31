import { App, TFolder } from "obsidian";
import type { OrderManager } from "../core/order-manager";
import type { FolderSettings } from "../core/order-types";
import type {
  TreeChildRowRect,
  TreeDndSurface,
  TreeDragSource,
  TreeDropSide,
  TreeRowHit,
} from "./tree-types";

export interface KbTreeSurfaceHost {
  getScopePath(): string | null;
  getScrollEl(): HTMLElement | null;
  isCollapsed(path: string): boolean;
  expandInPlace(path: string): void;
  selectedPaths(): string[];
  captureScroll(): void;
  refreshAfterDrop(): void;
  restoreScroll(): void;
}

// 1×1 透明画布：拖拽时用它替换浏览器默认的半透明行快照。
// 原生文件树也会调用 setDragImage 做同样的事；少了这一步，紫色拖拽源后面会再跟一层紫色残影。
const blankDragImage = document.createElement("canvas");
blankDragImage.width = 1;
blankDragImage.height = 1;

/**
 * 单库树的拖拽 Surface：读取当前单库树 DOM 与视图状态。
 * 落点规则不在这里，全部由 TreeDndController 决定。
 */
export class KbTreeSurface implements TreeDndSurface {
  private markedSibling: HTMLElement | null = null;
  private markedFolder: HTMLElement | null = null;

  constructor(
    private readonly host: KbTreeSurfaceHost,
    private readonly app: App,
    private readonly orderManager: OrderManager,
    private readonly getFolderSettings: (path: string) => FolderSettings
  ) {}

  get scopeRootPath(): string {
    return this.host.getScopePath() ?? "";
  }

  get scrollEl(): HTMLElement | null {
    return this.host.getScrollEl();
  }

  resolveDragSource(target: EventTarget | null): TreeDragSource | null {
    const el = target instanceof Element ? target : null;
    const scroll = this.scrollEl;
    if (!el || !scroll || !scroll.contains(el)) return null;

    const row = el.closest<HTMLElement>(".tree-item");
    const self = this.selfOf(row);
    const path = self?.dataset.path;
    if (!path || !this.isInScope(path)) return null;
    if (!this.app.vault.getAbstractFileByPath(path)) return null;

    return { surface: this, path };
  }

  scrollRect(): DOMRect | null {
    return this.scrollEl?.getBoundingClientRect() ?? null;
  }

  containsPoint(x: number, y: number): boolean {
    const el = this.scrollEl;
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  resolveRowAtPoint(x: number, y: number): TreeRowHit | null {
    const hit = this.hitAt(x, y);
    if (!hit) return null;

    const title = hit.closest<HTMLElement>(".nav-folder-title, .nav-file-title");
    if (title) {
      const path = title.dataset.path;
      if (!path) return null;
      return {
        path,
        kind: title.classList.contains("nav-folder-title") ? "folder" : "file",
        rect: title.getBoundingClientRect(),
      };
    }

    const folderRow = hit.closest<HTMLElement>(".tree-item.nav-folder");
    if (folderRow) {
      const titleEl = this.selfOf(folderRow);
      const path = titleEl?.dataset.path;
      if (!titleEl || !path) return null;
      const rect = titleEl.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) {
        return { path, kind: "folder", rect };
      }
    }

    return null;
  }

  blankFolderAt(x: number, y: number): string | null {
    const hit = this.hitAt(x, y);
    if (!hit) return null;

    if (hit.closest(".nav-folder-title, .nav-file-title")) return null;

    const folderRow = hit.closest<HTMLElement>(".tree-item.nav-folder");
    if (folderRow) {
      const titleEl = this.selfOf(folderRow);
      if (titleEl) {
        const rect = titleEl.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) return null;
      }
      return titleEl?.dataset.path ?? null;
    }

    const children = hit.closest<HTMLElement>(".nav-folder-children");
    if (children) {
      const folder = children.parentElement?.closest<HTMLElement>(".tree-item.nav-folder") ?? null;
      const path = this.pathOfElement(folder);
      return path ?? (this.scopeRootPath || null);
    }

    return this.scopeRootPath || null;
  }

  childRowRects(folderPath: string): TreeChildRowRect[] {
    const container = this.childrenContainer(folderPath);
    if (!container) return [];

    const rows: TreeChildRowRect[] = [];
    for (const child of Array.from(container.children)) {
      if (!(child instanceof HTMLElement) || !child.classList.contains("tree-item")) continue;
      const titleEl = this.selfOf(child);
      const path = titleEl?.dataset.path ?? this.pathOfElement(child);
      if (!titleEl || !path) continue;
      rows.push({ path, rect: titleEl.getBoundingClientRect() });
    }
    return rows;
  }

  selectedPaths(): string[] {
    return this.host.selectedPaths();
  }

  isCollapsed(path: string): boolean {
    return this.host.isCollapsed(path);
  }

  expand(path: string): void {
    this.host.expandInPlace(path);
  }

  orderedChildPaths(folderPath: string): string[] {
    const folder =
      folderPath === "/"
        ? this.app.vault.getRoot()
        : this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return [];

    try {
      return this.orderManager
        .getSortedItems(
          this.getFolderSettings(folder.path),
          folder.children.map((file) => ({ file }))
        )
        .map((entry) => entry.file.path);
    } catch {
      return folder.children.map((file) => file.path);
    }
  }

  captureScroll(): void {
    this.host.captureScroll();
  }

  restoreScrollAfterMoves(): void {
    this.host.refreshAfterDrop();
    this.host.restoreScroll();
  }

  isInScope(path: string): boolean {
    const scope = this.scopeRootPath;
    if (!scope) return false;
    return path === scope || path.startsWith(scope + "/");
  }

  markSibling(path: string, side: TreeDropSide): void {
    const row = this.rowItem(path);
    if (!row) return;
    this.markedSibling = row;
    row.dataset.kbDropSibling = side;
  }

  markFolder(path: string): void {
    const el = path === this.scopeRootPath ? this.scrollEl : this.rowItem(path);
    if (!el) return;
    this.markedFolder = el;
    el.dataset.kbDropFolder = "";
  }

  clearMarks(): void {
    if (this.markedSibling) {
      delete this.markedSibling.dataset.kbDropSibling;
      this.markedSibling = null;
    }
    if (this.markedFolder) {
      delete this.markedFolder.dataset.kbDropFolder;
      this.markedFolder = null;
    }
  }

  markDragSource(path: string, active: boolean): void {
    this.rowSelf(path)?.classList.toggle("is-being-dragged", active);
  }

  onDragStart(event: DragEvent, path: string): void {
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", path);
      event.dataTransfer.setDragImage(blankDragImage, 0, 0);
    }
  }

  private hitAt(x: number, y: number): HTMLElement | null {
    const scroll = this.scrollEl;
    if (!scroll) return null;
    const hit = activeDocument.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit || !scroll.contains(hit)) return null;
    return hit;
  }

  private childrenContainer(folderPath: string): HTMLElement | null {
    if (folderPath === this.scopeRootPath) return this.scrollEl;
    return (
      this.rowItem(folderPath)?.querySelector<HTMLElement>(
        ":scope > .nav-folder-children"
      ) ?? null
    );
  }

  private rowItem(path: string): HTMLElement | null {
    return this.rowSelf(path)?.closest<HTMLElement>(".tree-item") ?? null;
  }

  private rowSelf(path: string): HTMLElement | null {
    const scroll = this.scrollEl;
    if (!scroll) return null;
    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return scroll.querySelector<HTMLElement>(`.tree-item-self[data-path="${escaped}"]`);
  }

  private pathOfElement(el: HTMLElement | null): string | null {
    if (!el) return null;
    const self = this.selfOf(el);
    return self?.dataset.path ?? null;
  }

  private selfOf(el: HTMLElement | null): HTMLElement | null {
    if (!el) return null;
    if (el.matches(".tree-item-self")) return el;
    const direct = el.querySelector<HTMLElement>(":scope > .tree-item-self");
    if (direct) return direct;
    return (
      el.closest<HTMLElement>(".tree-item")?.querySelector<HTMLElement>(
        ":scope > .tree-item-self"
      ) ?? null
    );
  }
}
