import { App, TAbstractFile, TFolder } from "obsidian";
import type {
  TreeChildRowRect,
  TreeDndSurface,
  TreeDropSide,
  TreeRowHit,
} from "./tree-types";

/**
 * 原生文件浏览器的拖拽 Surface。
 * 只读取原生 DOM / fileItems / selectedDoms / getSortedFolderItems，
 * 不在这里写任何落点规则。
 */
export class NativeTreeSurface implements TreeDndSurface {
  readonly scopeRootPath = "/";

  private container: HTMLElement | null = null;
  private markedSibling: HTMLElement | null = null;
  private markedFolder: HTMLElement | null = null;
  private pendingScroll: { el: HTMLElement; top: number } | null = null;

  constructor(private readonly app: App) {}

  get scrollEl(): HTMLElement | null {
    return this.container;
  }

  /** 拖拽开始时确认目标在原生文件浏览器里，并绑定该面板 */
  resolveDragSource(target: EventTarget | null): { surface: NativeTreeSurface; path: string } | null {
    const el = target instanceof Element ? target : null;
    if (!el) return null;

    const container = el.closest<HTMLElement>(".nav-files-container");
    if (!container || !container.closest('[data-type="file-explorer"]')) return null;

    const row = el.closest<HTMLElement>(".tree-item");
    const self = this.selfOf(row);
    const path = self?.dataset.path;
    if (!path) return null;
    if (!this.app.vault.getAbstractFileByPath(path)) return null;

    this.container = container;
    return { surface: this, path };
  }

  /** 指针移到另一个 Files 面板时重新绑定容器；不在原生树上则保持原容器 */
  resolveSurfaceAt(_active: TreeDndSurface, point: { x: number; y: number }): TreeDndSurface {
    const hit = activeDocument.elementFromPoint(point.x, point.y) as HTMLElement | null;
    const container = hit?.closest?.<HTMLElement>(".nav-files-container");
    if (container && container.closest('[data-type="file-explorer"]')) {
      this.container = container;
    }
    return this;
  }

  scrollRect(): DOMRect | null {
    return this.container?.getBoundingClientRect() ?? null;
  }

  containsPoint(x: number, y: number): boolean {
    const el = this.container;
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

    // 2px 行距命中的可能是文件夹行容器；指针仍在标题矩形内时按该行处理
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
    if (folderRow && this.container?.contains(folderRow)) {
      const titleEl = this.selfOf(folderRow);
      if (titleEl) {
        const rect = titleEl.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) return null;
      }
      return titleEl?.dataset.path ?? null;
    }

    const children = hit.closest<HTMLElement>(".nav-folder-children");
    if (children && this.container?.contains(children)) {
      const folder = children.parentElement?.closest<HTMLElement>(".tree-item.nav-folder") ?? null;
      return this.pathOfElement(folder) ?? this.scopeRootPath;
    }

    // 根目录空白、右侧留白、容器 padding
    return this.container?.firstElementChild ? this.scopeRootPath : null;
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
    const view = this.view();
    const selectedDoms = view?.tree?.selectedDoms;
    if (!selectedDoms) return [];

    const resolved = ([...selectedDoms] as { el?: HTMLElement; file?: TAbstractFile }[])
      .map((selected) => {
        const path = selected.el ? this.pathOfElement(selected.el) : selected.file?.path ?? null;
        return path ? { path, el: selected.el ?? null } : null;
      })
      .filter((entry): entry is { path: string; el: HTMLElement | null } => !!entry);

    const seen = new Set<string>();
    const unique = resolved.filter((entry) => {
      if (seen.has(entry.path)) return false;
      seen.add(entry.path);
      return true;
    });

    return unique
      .sort((a, b) => {
        if (!a.el || !b.el) return 0;
        if (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      })
      .map((entry) => entry.path);
  }

  isCollapsed(path: string): boolean {
    return this.rowElement(path)?.classList.contains("is-collapsed") ?? false;
  }

  expand(path: string): void {
    const view = this.view();
    void view?.fileItems?.[path]?.setCollapsed?.(false, true);
  }

  orderedChildPaths(folderPath: string): string[] {
    const folder =
      folderPath === "/"
        ? this.app.vault.getRoot()
        : this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return [];

    try {
      const sorted = this.view()?.getSortedFolderItems?.(folder);
      if (Array.isArray(sorted)) {
        return sorted
          .map((entry: { file?: TAbstractFile }) => entry?.file?.path)
          .filter((path: string | undefined): path is string => !!path);
      }
    } catch {
      // 原生 API 变动时退回 vault 子项顺序
    }
    return folder.children.map((file) => file.path);
  }

  captureScroll(): void {
    if (!this.container) return;
    this.pendingScroll = { el: this.container, top: this.container.scrollTop };
  }

  restoreScrollAfterMoves(): void {
    const pending = this.pendingScroll;
    if (!pending) return;
    this.pendingScroll = null;

    const restore = (): void => {
      if (pending.el.isConnected) pending.el.scrollTop = pending.top;
    };
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
    // 原生 sort() 有时会在下一拍才补滚动，再兜一次
    window.setTimeout(restore, 80);
  }

  isInScope(): boolean {
    return true;
  }

  markSibling(path: string, side: TreeDropSide): void {
    const el = this.rowElement(path);
    if (!el) return;
    this.markedSibling = el;
    el.dataset.kbDropSibling = side;
  }

  markFolder(path: string): void {
    const el =
      path === this.scopeRootPath
        ? ((this.container?.firstElementChild as HTMLElement | null) ?? null)
        : this.rowElement(path);
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

  onDragOver(): void {
    // 阻止 Obsidian 自动展开被拖拽/相邻的折叠文件夹
    const view = this.view();
    if (view) view.lastDropTargetEl = null;
  }

  /** t16 调试读取：落点线所在的原生行 */
  elementForSibling(path: string): HTMLElement | null {
    return this.rowElement(path);
  }

  /** t16 调试读取：移入高亮所在的文件夹行（根为树容器） */
  elementForFolder(path: string): HTMLElement | null {
    if (path === this.scopeRootPath) {
      return (this.container?.firstElementChild as HTMLElement | null) ?? null;
    }
    return this.rowElement(path);
  }

  private hitAt(x: number, y: number): HTMLElement | null {
    const container = this.container;
    if (!container) return null;
    const hit = activeDocument.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit || !container.contains(hit)) return null;
    return hit;
  }

  private childrenContainer(folderPath: string): HTMLElement | null {
    if (folderPath === this.scopeRootPath) {
      return (this.container?.firstElementChild as HTMLElement | null) ?? null;
    }
    const row = this.rowElement(folderPath);
    return row?.querySelector<HTMLElement>(":scope > .nav-folder-children") ?? null;
  }

  private rowElement(path: string): HTMLElement | null {
    const view = this.view();
    const item = view?.fileItems?.[path];
    const el = item?.el ?? item?.selfEl?.closest?.(".tree-item") ?? null;
    if (el instanceof HTMLElement && el.classList.contains("tree-item")) return el;

    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const self = this.container?.querySelector<HTMLElement>(`[data-path="${escaped}"]`);
    return self?.closest<HTMLElement>(".tree-item") ?? null;
  }

  private pathOfElement(el: HTMLElement | null): string | null {
    if (!el) return null;
    if (el === this.container?.firstElementChild) return this.scopeRootPath;

    const self = this.selfOf(el);
    const path = self?.dataset.path;
    if (path) return path;

    const row = el.matches(".tree-item") ? el : el.closest<HTMLElement>(".tree-item");
    return row ? this.view()?.files?.get(row)?.path ?? null : null;
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

  private view(): any {
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    if (this.container) {
      for (const leaf of leaves) {
        const view: any = leaf.view;
        if (view?.containerEl?.contains(this.container)) return view;
      }
    }
    return leaves[0]?.view ?? null;
  }
}
