import { App, TAbstractFile, TFile, TFolder } from "obsidian";
import type { OrderManager } from "../core/order-manager";
import type { FolderSettings, OrderSettings } from "../core/order-types";
import type { TreeRow } from "./tree-types";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export interface TreeModelHost {
  app: App;
  orderManager: OrderManager;
  getSettings(): OrderSettings;
  getFolderSettings(folderPath: string): FolderSettings;
  isHiddenByRule(path: string): boolean;
  isCollapsed(path: string): boolean;
  getActivePath(): string | null;
}

/**
 * 单库树的作用域模型：只负责「这个库下面该按什么顺序显示哪些行」。
 * 原生树不需要它（Obsidian 自己维护），单库树的渲染、拖拽、键盘都从它读。
 */
export class TreeModel {
  private rootPath: string | null = null;
  private readonly childCache = new Map<string, TreeRow[]>();
  private readonly rowIndex = new Map<string, TreeRow>();

  constructor(private readonly host: TreeModelHost) {}

  get root(): string | null {
    return this.rootPath;
  }

  setRootPath(path: string | null): void {
    if (this.rootPath === path) return;
    this.rootPath = path;
    this.invalidateAll();
  }

  invalidateAll(): void {
    this.childCache.clear();
    this.rowIndex.clear();
  }

  /** 失效某个路径及其子孙；同时失效父级，让置顶/隐藏变化反映到父级排序里 */
  invalidate(path?: string): void {
    if (!path) {
      this.invalidateAll();
      return;
    }
    const prefix = path + "/";
    for (const key of [...this.childCache.keys()]) {
      if (key === path || key.startsWith(prefix)) this.childCache.delete(key);
    }
    for (const key of [...this.rowIndex.keys()]) {
      if (key === path || key.startsWith(prefix)) this.rowIndex.delete(key);
    }
    const parent = this.parentPathOf(path);
    if (parent) {
      this.childCache.delete(parent);
      this.rowIndex.delete(path);
    }
  }

  isInScope(path: string): boolean {
    if (!this.rootPath) return false;
    return path === this.rootPath || path.startsWith(this.rootPath + "/");
  }

  rootFolder(): TFolder | null {
    if (!this.rootPath) return null;
    const folder = this.host.app.vault.getAbstractFileByPath(this.rootPath);
    return folder instanceof TFolder ? folder : null;
  }

  /** 文件夹的直接子行，按当前显示顺序（含隐藏项，附件/非 md 不丢） */
  childRows(folderPath: string): TreeRow[] {
    const cached = this.childCache.get(folderPath);
    if (cached) return cached;

    const folder =
      folderPath === "/"
        ? this.host.app.vault.getRoot()
        : this.host.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder) || !this.isInScope(folder.path)) {
      const empty: TreeRow[] = [];
      this.childCache.set(folderPath, empty);
      return empty;
    }

    const ordered = this.sortChildren(folder);
    const rows = ordered.map((file) => this.makeRow(file, folder.path));
    this.childCache.set(folderPath, rows);
    for (const row of rows) this.rowIndex.set(row.path, row);
    return rows;
  }

  /** 展开可见行（折叠的文件夹只保留自身一行） */
  rows(): TreeRow[] {
    const folder = this.rootFolder();
    if (!folder) return [];

    const activePath = this.host.getActivePath();
    const out: TreeRow[] = [];
    const walk = (parent: TFolder, depth: number): void => {
      for (const row of this.childRows(parent.path)) {
        row.depth = depth;
        row.active = !!activePath && row.path === activePath;
        row.collapsed = row.kind === "folder" && this.host.isCollapsed(row.path);
        out.push(row);
        if (row.kind === "folder" && !row.collapsed) {
          walk(row.file as TFolder, depth + 1);
        }
      }
    };
    walk(folder, 0);
    return out;
  }

  row(path: string): TreeRow | null {
    return this.rowIndex.get(path) ?? null;
  }

  private sortChildren(folder: TFolder): TAbstractFile[] {
    // 隐藏项在「显示隐藏」关闭时不参与布局：虚拟窗口按行高算位置，
    // 保留 display:none 的行会让后续行与占位条错位。
    const showHidden = this.host.getSettings().showHidden;
    const children = showHidden
      ? folder.children
      : folder.children.filter((file) => !this.host.isHiddenByRule(file.path));

    try {
      const settings = this.host.getFolderSettings(folder.path);
      return this.host.orderManager
        .getSortedItems(settings, children.map((file) => ({ file })))
        .map((entry) => entry.file);
    } catch {
      return children.slice().sort((a, b) => collator.compare(a.name, b.name));
    }
  }

  private makeRow(file: TAbstractFile, parentPath: string): TreeRow {
    return {
      file,
      path: file.path,
      name: file instanceof TFile ? file.basename : file.name,
      kind: file instanceof TFolder ? "folder" : "file",
      depth: 0,
      parentPath,
      pinned: !!this.host.getSettings().items[file.path]?.isPinned,
      hidden: this.host.isHiddenByRule(file.path),
      active: false,
      collapsed: false,
    };
  }

  private parentPathOf(path: string): string | null {
    if (path === "/") return null;
    const parent = this.host.app.vault.getAbstractFileByPath(path)?.parent;
    if (parent) return parent.path;
    const cut = path.lastIndexOf("/");
    return cut === -1 ? "/" : cut === 0 ? "/" : path.slice(0, cut);
  }
}
