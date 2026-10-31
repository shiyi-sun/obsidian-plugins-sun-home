import { TFile, TFolder, setIcon } from "obsidian";
import type { TreeModel } from "./tree-model";
import type { TreeRow } from "./tree-types";

// 拖拽期间不重绘窗口（重绘源节点后 Chrome 会吞掉后续鼠标事件），
// 所以多挂一段 overscan 覆盖正常的边缘自动滚动距离。
const OVERSCAN = 60;
const DEFAULT_PITCH = 26.9;

export interface KbTreeRendererHost {
  getActivePath(): string | null;
  getDraggingPath(): string | null;
  getFocusedPath(): string | null;
  isSelected(path: string): boolean;
  isCollapsed(path: string): boolean;
  onFileClick(file: TFile, event: MouseEvent): void;
  onFileAuxClick(file: TFile, event: MouseEvent): void;
  onFolderClick(folder: TFolder, event: MouseEvent): void;
  onFileContextMenu(file: TFile, event: MouseEvent): void;
  onFolderContextMenu(folder: TFolder, event: MouseEvent): void;
}

interface Snapshot {
  rows: TreeRow[];
  index: Map<string, number>;
  /** 每个行索引对应的可见子树行数（含自身），用于虚拟占位条 */
  subtree: number[];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 单库树的原生 DOM 契约 + 虚拟窗口渲染。
 * 只创建视口附近的行，用占位条撑住总高度；行高从实际 DOM 测量。
 */
export class KbTreeRenderer {
  private snapshot: Snapshot = { rows: [], index: new Map(), subtree: [] };
  private pitch = DEFAULT_PITCH;
  private paddingTop = 0;
  private lastStart = -1;
  private lastEnd = -1;
  private scrollRaf = 0;
  private layoutRaf = 0;
  private measureRaf = 0;
  private activePath: string | null;
  private destroyed = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly body: HTMLElement,
    private readonly model: TreeModel,
    private readonly host: KbTreeRendererHost
  ) {
    this.activePath = host.getActivePath();
    this.body.addEventListener("scroll", this.onScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.scheduleLayout());
    this.resizeObserver.observe(this.body);
  }

  render(scrollTop = this.body.scrollTop): void {
    if (this.destroyed) return;

    this.snapshot = this.buildSnapshot(this.model.rows());
    this.measure();

    const { start, end } = this.computeRange(scrollTop);
    this.renderWindow(start, end);
    this.lastStart = start;
    this.lastEnd = end;
    this.body.scrollTop = Math.max(0, scrollTop);

    // 首次渲染前没有样例行，行高只能先用默认值；渲染后补测一次并重排占位条
    if (!this.measureRaf && this.snapshot.rows.length > 0) {
      this.measureRaf = window.requestAnimationFrame(() => {
        this.measureRaf = 0;
        if (this.destroyed || !this.body.isConnected) return;
        const before = this.pitch;
        this.measure();
        if (Math.abs(before - this.pitch) > 0.05) this.render(this.body.scrollTop);
      });
    }
  }

  updateActive(path: string | null): void {
    this.activePath = path;
    if (this.destroyed) return;
    for (const self of Array.from(
      this.body.querySelectorAll<HTMLElement>(".tree-item-self[data-path]")
    )) {
      self.classList.toggle("is-active", !!path && self.dataset.path === path);
    }
  }

  /** 只切换已挂载行的选中态，不重建窗口 */
  updateSelection(isSelected: (path: string) => boolean): void {
    if (this.destroyed) return;
    for (const self of Array.from(
      this.body.querySelectorAll<HTMLElement>(".tree-item-self[data-path]")
    )) {
      const path = self.dataset.path;
      if (!path) continue;
      self.classList.toggle("is-selected", isSelected(path));
    }
  }

  updateFocus(path: string | null): void {
    if (this.destroyed) return;
    for (const self of Array.from(
      this.body.querySelectorAll<HTMLElement>(".tree-item-self[data-path]")
    )) {
      self.classList.toggle("has-focus", !!path && self.dataset.path === path);
    }
  }

  get visibleCount(): number {
    return this.snapshot.rows.length;
  }

  pathAt(index: number): string | null {
    return this.snapshot.rows[index]?.path ?? null;
  }

  indexOfPath(path: string): number {
    return this.snapshot.index.get(path) ?? -1;
  }

  /** 两个可见行之间的完整行路径（含两端），顺序按当前显示顺序 */
  pathsInRange(fromPath: string, toPath: string): string[] | null {
    const from = this.snapshot.index.get(fromPath);
    const to = this.snapshot.index.get(toPath);
    if (from === undefined || to === undefined) return null;
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return this.snapshot.rows.slice(start, end + 1).map((row) => row.path);
  }

  rowSelf(path: string): HTMLElement | null {
    if (this.destroyed) return null;
    return this.body.querySelector<HTMLElement>(
      `.tree-item-self[data-path="${escapeAttr(path)}"]`
    );
  }

  /** 自动定位：行不在视口内时滚到它附近；已在视口内不打扰用户 */
  scrollToPath(path: string): void {
    if (this.destroyed) return;
    const index = this.snapshot.index.get(path);
    if (index === undefined) return;

    const top = this.paddingTop + index * this.pitch;
    const viewTop = this.body.scrollTop;
    const viewBottom = viewTop + this.body.clientHeight;
    if (top >= viewTop + 2 && top + this.pitch <= viewBottom - 2) return;

    const target = Math.max(0, top - Math.max(0, (this.body.clientHeight - this.pitch) / 3));
    this.render(target);
  }

  /**
   * 拖拽悬停展开：就地插入子行，不重建正在拖拽的源节点。
   * 展开后占位条会暂时失真，dragend 时由视图整窗重绘修正。
   */
  expandInPlace(path: string): void {
    if (this.destroyed) return;
    const index = this.snapshot.index.get(path);
    if (index === undefined) return;
    const row = this.snapshot.rows[index];
    if (row.kind !== "folder" || !(row.file instanceof TFolder)) return;

    const self = this.body.querySelector<HTMLElement>(
      `.tree-item-self[data-path="${escapeAttr(path)}"]`
    );
    const item = self?.closest<HTMLElement>(".tree-item");
    if (!item) {
      this.render();
      return;
    }

    item.classList.remove("is-collapsed");
    self?.querySelector<HTMLElement>(".collapse-icon")?.classList.remove("is-collapsed");

    let sub = item.querySelector<HTMLElement>(":scope > .nav-folder-children");
    if (!sub) {
      sub = document.createElement("div");
      sub.className = "tree-item-children nav-folder-children";
      item.appendChild(sub);
    }
    sub.replaceChildren();

    const children = this.model.childRows(path);
    for (const child of children) child.depth = row.depth + 1;
    this.appendFullSubtree(sub, children);
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    window.cancelAnimationFrame(this.scrollRaf);
    window.cancelAnimationFrame(this.layoutRaf);
    window.cancelAnimationFrame(this.measureRaf);
    this.scrollRaf = 0;
    this.layoutRaf = 0;
    this.measureRaf = 0;
    this.body.removeEventListener("scroll", this.onScroll);
  }

  private readonly onScroll = (): void => {
    if (this.destroyed || this.scrollRaf) return;
    this.scrollRaf = window.requestAnimationFrame(() => {
      this.scrollRaf = 0;
      // 拖拽期间重建窗口会替换 drag source，Chrome 随后连鼠标事件一起吞掉，
      // 取消拖拽时收不了尾；等 dragend 后再更新窗口。
      if (document.body.classList.contains("kb-dragging")) return;
      this.updateWindow();
    });
  };

  private scheduleLayout(): void {
    if (this.destroyed || this.layoutRaf) return;
    this.layoutRaf = window.requestAnimationFrame(() => {
      this.layoutRaf = 0;
      if (this.destroyed) return;
      this.measure();
      this.updateWindow();
    });
  }

  private updateWindow(): void {
    const n = this.snapshot.rows.length;
    if (!n) return;
    const scrollTop = this.body.scrollTop;
    const { start, end } = this.computeRange(scrollTop);
    if (start === this.lastStart && end === this.lastEnd) return;

    this.renderWindow(start, end);
    this.lastStart = start;
    this.lastEnd = end;
    this.body.scrollTop = scrollTop;
  }

  private computeRange(scrollTop: number): { start: number; end: number } {
    const n = this.snapshot.rows.length;
    if (!n) return { start: 0, end: 0 };

    const first = Math.floor((scrollTop - this.paddingTop) / this.pitch);
    const last = Math.ceil(
      (scrollTop + this.body.clientHeight - this.paddingTop) / this.pitch
    );
    const start = clamp(first - OVERSCAN, 0, n);
    const end = clamp(last + OVERSCAN, start, n);
    return { start, end: Math.max(end, Math.min(n, start + 1)) };
  }

  private renderWindow(start: number, end: number): void {
    const { rows, index } = this.snapshot;
    const required = new Set<string>();

    for (let i = start; i < end; i++) {
      const row = rows[i];
      if (!row) continue;
      required.add(row.path);

      let parentPath = row.parentPath;
      while (parentPath && parentPath !== this.model.root) {
        required.add(parentPath);
        const parentIndex = index.get(parentPath);
        if (parentIndex === undefined) break;
        parentPath = rows[parentIndex]?.parentPath ?? "";
      }
    }

    const fragment = document.createDocumentFragment();
    const root = this.model.rootFolder();
    if (root) {
      this.renderChildList(fragment, this.model.childRows(root.path), required);
    }
    this.body.replaceChildren(fragment);
  }

  private renderChildList(
    container: ParentNode,
    children: TreeRow[],
    required: Set<string>
  ): void {
    let skipped = 0;
    const flushSpacer = (): void => {
      if (skipped <= 0) return;
      container.appendChild(this.makeSpacer(skipped * this.pitch));
      skipped = 0;
    };

    for (const child of children) {
      if (!required.has(child.path)) {
        skipped += this.subtreeOf(child.path);
        continue;
      }

      flushSpacer();
      const item = this.makeRow(child);
      container.appendChild(item);

      if (child.kind === "folder" && !child.collapsed) {
        const sub = document.createElement("div");
        sub.className = "tree-item-children nav-folder-children";
        this.renderChildList(sub, this.model.childRows(child.path), required);
        item.appendChild(sub);
      }
    }

    flushSpacer();
  }

  private subtreeOf(path: string): number {
    const index = this.snapshot.index.get(path);
    if (index === undefined) return 1;
    return this.snapshot.subtree[index] ?? 1;
  }

  private makeSpacer(height: number): HTMLElement {
    const spacer = document.createElement("div");
    spacer.className = "kb-tree-spacer";
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.height = `${Math.max(0, height).toFixed(2)}px`;
    return spacer;
  }

  private makeRow(row: TreeRow): HTMLElement {
    const isFolder = row.kind === "folder";
    const item = document.createElement("div");
    item.className = `tree-item ${isFolder ? "nav-folder" : "nav-file"}`;
    item.dataset.kind = row.kind;
    item.setAttribute("draggable", "true");
    if (row.hidden) item.classList.add("kb-hidden");

    const self = document.createElement("div");
    self.className = isFolder
      ? "tree-item-self nav-folder-title is-clickable mod-collapsible"
      : "tree-item-self nav-file-title tappable is-clickable";
    self.dataset.path = row.path;
    self.tabIndex = -1;
    self.setAttribute("draggable", "true");
    // 与原生一致：行宽统一，缩进靠行内 padding，负 margin 抵消嵌套容器
    self.style.setProperty("margin-inline-start", `${-17 * row.depth}px`, "important");
    self.style.setProperty(
      "padding-inline-start",
      `${24 + 17 * row.depth}px`,
      "important"
    );
    if (row.path === this.host.getDraggingPath()) self.classList.add("is-being-dragged");
    if (row.path === this.host.getFocusedPath()) self.classList.add("has-focus");
    if (this.host.isSelected(row.path)) self.classList.add("is-selected");

    if (isFolder) {
      const collapse = document.createElement("div");
      collapse.className = "tree-item-icon collapse-icon";
      setIcon(collapse, "right-triangle");
      if (row.collapsed) {
        item.classList.add("is-collapsed");
        collapse.classList.add("is-collapsed");
      }
      self.appendChild(collapse);
    }

    const inner = document.createElement("div");
    inner.className = isFolder
      ? "tree-item-inner nav-folder-title-content"
      : "tree-item-inner nav-file-title-content";
    inner.textContent = row.name;
    self.appendChild(inner);

    if (!isFolder) {
      const extension = (row.file as TFile).extension;
      if (extension && extension !== "md") {
        const tag = document.createElement("div");
        tag.className = "nav-file-tag";
        tag.textContent = extension;
        self.appendChild(tag);
      }
    }

    if (row.pinned) this.mountPin(self);

    if (isFolder) {
      const folder = row.file as TFolder;
      self.addEventListener("click", (event) => {
        if (event.button !== 0) return;
        this.host.onFolderClick(folder, event);
      });
      self.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.host.onFolderContextMenu(folder, event);
      });
    } else {
      const file = row.file as TFile;
      if (row.path === this.activePath) self.classList.add("is-active");
      self.addEventListener("click", (event) => {
        if (event.button !== 0) return;
        this.host.onFileClick(file, event);
      });
      self.addEventListener("auxclick", (event) => {
        if (event.button !== 1) return;
        this.host.onFileAuxClick(file, event);
      });
      self.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.host.onFileContextMenu(file, event);
      });
    }

    item.appendChild(self);
    return item;
  }

  /** 悬停展开时不再走窗口裁剪：整段子树直接挂进去，dragend 后统一重绘 */
  private appendFullSubtree(container: ParentNode, children: TreeRow[]): void {
    for (const child of children) {
      if (child.kind === "folder") {
        child.collapsed = this.host.isCollapsed(child.path);
      }
      const item = this.makeRow(child);
      container.appendChild(item);

      if (child.kind === "folder" && !child.collapsed) {
        const sub = document.createElement("div");
        sub.className = "tree-item-children nav-folder-children";
        const kids = this.model.childRows(child.path);
        for (const kid of kids) kid.depth = child.depth + 1;
        this.appendFullSubtree(sub, kids);
        item.appendChild(sub);
      }
    }
  }

  private mountPin(self: HTMLElement): void {
    const indicator = document.createElement("div");
    indicator.className = "kb-indicator";
    const pin = document.createElement("div");
    pin.className = "kb-pin-indicator";
    indicator.appendChild(pin);
    setIcon(pin, "pin");
    self.appendChild(indicator);
  }

  private measure(): void {
    const sample = this.body.querySelector<HTMLElement>(".tree-item-self[data-path]");
    if (sample) {
      const rect = sample.getBoundingClientRect();
      const marginBottom = parseFloat(getComputedStyle(sample).marginBottom) || 0;
      if (rect.height > 0) this.pitch = rect.height + marginBottom;
    }
    const style = getComputedStyle(this.body);
    this.paddingTop = parseFloat(style.paddingTop) || 0;
  }

  private buildSnapshot(rows: TreeRow[]): Snapshot {
    const index = new Map<string, number>();
    rows.forEach((row, i) => index.set(row.path, i));

    const n = rows.length;
    const subtree = new Array<number>(n).fill(1);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (rows[top].depth < rows[i].depth) break;
        stack.pop();
        subtree[top] = i - top;
      }
      stack.push(i);
    }
    while (stack.length > 0) {
      const top = stack.pop() as number;
      subtree[top] = n - top;
    }

    return { rows, index, subtree };
  }
}
