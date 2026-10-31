import type { App, TAbstractFile } from "obsidian";
import type { OrderManager } from "../core/order-manager";
import type { OrderSettings } from "../core/order-types";

export type TreeDropSide = "before" | "after";

export interface TreeRow {
  file: TAbstractFile;
  path: string;
  /** 文件夹名 / .md 的 basename / 非 md 的完整文件名 */
  name: string;
  kind: "folder" | "file";
  /** 作用域根的直接子项为 0 */
  depth: number;
  parentPath: string;
  pinned: boolean;
  hidden: boolean;
  active: boolean;
  collapsed: boolean;
}

/** 指针命中的一行；rect 是标题行（.tree-item-self）的矩形 */
export interface TreeRowHit {
  path: string;
  kind: "folder" | "file";
  rect: DOMRect;
}

export interface TreeChildRowRect {
  path: string;
  rect: DOMRect;
}

export type TreeDropTarget =
  | { kind: "sibling"; folderPath: string; siblingPath: string; side: TreeDropSide }
  | { kind: "folder"; folderPath: string };

/**
 * 两棵树对拖拽控制器暴露的最小接口。
 * 所有几何/命中/模型访问都经这里，控制器本身不直接碰 DOM 结构。
 */
export interface TreeDndSurface {
  /** 原生为 "/"，单库树为当前知识库路径 */
  readonly scopeRootPath: string;
  readonly scrollEl: HTMLElement | null;

  scrollRect(): DOMRect | null;
  containsPoint(x: number, y: number): boolean;
  /** 命中标题行；2px 行距等空白返回 null */
  resolveRowAtPoint(x: number, y: number): TreeRowHit | null;
  /** 空白/行距/容器 padding 归属的文件夹；不在树上返回 null */
  blankFolderAt(x: number, y: number): string | null;
  /** 某文件夹的直接子行及其标题矩形，按当前渲染顺序 */
  childRowRects(folderPath: string): TreeChildRowRect[];

  /** 当前选中项路径，按可见顺序排列 */
  selectedPaths(): string[];
  isCollapsed(path: string): boolean;
  expand(path: string): void;
  /** 文件夹当前显示顺序（含未渲染/隐藏项），用于移入末尾与排序固化 */
  orderedChildPaths(folderPath: string): string[];

  captureScroll(): void;
  restoreScrollAfterMoves(): void;

  isInScope(path: string): boolean;

  markSibling(path: string, side: TreeDropSide): void;
  markFolder(path: string): void;
  clearMarks(): void;

  markDragSource?(path: string, active: boolean): void;
  onDragStart?(event: DragEvent, path: string): void;
  onDragOver?(): void;
}

export interface TreeDragSource {
  surface: TreeDndSurface;
  path: string;
}

export interface TreeDndHost {
  app: App;
  orderManager: OrderManager;
  getSettings(): OrderSettings;
  getItemSettings(path: string): { isPinned: boolean };
  /** 拖拽源所在的面板；不属于任何树时返回 null */
  resolveSource(target: EventTarget | null): TreeDragSource | null;
  /** 指针移动时保持/切换活动面板（多 Files 面板时重新绑定容器） */
  resolveTargetSurface(active: TreeDndSurface, point: { x: number; y: number }): TreeDndSurface;
}
