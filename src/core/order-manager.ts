import { TAbstractFile, TFile, TFolder } from "obsidian";
import { initLog } from "./log";
import {
  BaseItemSettings,
  FolderSettings,
  ItemSettings,
  OrderSettings,
} from "./order-types";

const DEFAULT_ITEM_SETTINGS: BaseItemSettings = { isPinned: false, isHidden: false };
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * 排序管理器：维护「每文件夹自定义顺序 + 置顶」。
 * 移植自 flexplorer（MIT License, kh4f），去除了对私有类型的依赖。
 */
export class OrderManager {
  private readonly log = initLog("ORDER MANAGER", "#ff5000");
  private readonly pendingCopies = new Map<
    string,
    { settings: ItemSettings; sourceName?: string }
  >();

  constructor(
    private readonly getSettings: () => OrderSettings,
    private readonly getSortedFolderItems: (folder: TFolder) => { file: TAbstractFile }[],
    private readonly saveSettings: () => void | Promise<void>,
    /**
     * 顺序实质发生变化后的回调：让文件浏览器立刻按新顺序重绘。
     * 原版 flexplorer 在父文件夹未变化时直接调用 sortExplorer()，
     * 本移植版曾漏掉这一步，导致「拖拽之后顺序不动」。
     */
    private readonly onChanged: () => void = () => {}
  ) {}

  private get settings(): OrderSettings {
    return this.getSettings();
  }

  /** 与 vault 同步：清理失效路径、为所有文件夹播种顺序 */
  syncItems(isValid: (path: string) => boolean, root: TFolder): void {
    this.log("Syncing tracked items with vault");
    const prunedCount = this.pruneInvalidPaths(isValid);
    const changed = this.sync(root) || prunedCount > 0;
    // 仅在结构确实发生变化时才写盘 —— 避免每次启动都整份写入 150KB+ 的 JSON
    if (changed) {
      void this.saveSettings();
    } else {
      this.log("Sync produced no changes, skipping save");
    }
  }

  /** @returns 是否发生了实质变化（用于决定是否需要写盘） */
  private sync(folder: TFolder): boolean {
    let changed = false;
    const folderPath = folder.path;
    const oldSettings = this.settings.items[folderPath] as FolderSettings | undefined;

    // 首次启用时以「当前显示顺序」为种子，避免启用后顺序突变。
    // ⚠️ 性能：getSortedFolderItems 内部是 O(n log n) 排序 + O(n) 的 indexOf 比较，
    // 且本函数对所有文件夹递归调用。若已有自定义顺序（oldSettings.customOrder 非空），
    // 直接沿用旧顺序即可，无需再调用原生排序 —— 这在节点较多的 vault 上是数量级的差别。
    const oldChildren = oldSettings?.customOrder ?? [];
    const hasExistingOrder = oldSettings?.sortOrder === "custom" && oldChildren.length > 0;

    let mergedChildren: string[];
    if (hasExistingOrder) {
      // 快速路径：复用旧顺序，剔除已不存在的项，并把新出现的项按插入位置补齐。
      // 避免调用原生排序函数（O(n²logn) 热点），同时保证新文件不会漏出顺序表。
      const currentNames = folder.children.map((c) => c.name);
      const currentSet = new Set(currentNames);
      const kept = oldChildren.filter((p) => currentSet.has(p));
      const keptSet = new Set(kept);
      const added = currentNames.filter((n) => !keptSet.has(n));
      if (added.length === 0 && kept.length === oldChildren.length) {
        mergedChildren = oldChildren;
      } else {
        mergedChildren =
          this.settings.newItemPlacement === "top" ? [...added, ...kept] : [...kept, ...added];
        changed = true;
      }
    } else {
      let newChildren: string[];
      try {
        newChildren = this.getSortedFolderItems(folder).map((item) => item.file.name);
      } catch {
        newChildren = folder.children.map((c) => c.name);
      }
      const kept = oldChildren.filter((p) => newChildren.includes(p));
      const addedChildren = newChildren.filter((p) => !oldChildren.includes(p));
      mergedChildren =
        this.settings.newItemPlacement === "top"
          ? [...addedChildren, ...kept]
          : [...kept, ...addedChildren];
      changed = true;
    }

    if (!oldSettings || oldSettings.customOrder !== mergedChildren) {
      this.settings.items[folderPath] = {
        ...DEFAULT_ITEM_SETTINGS,
        sortOrder: "custom",
        ...oldSettings,
        customOrder: mergedChildren,
      };
      if (oldSettings?.customOrder !== mergedChildren) changed = true;
    }

    for (const child of folder.children) {
      if (child instanceof TFolder) {
        if (this.sync(child)) changed = true;
        continue;
      }
      if (child instanceof TFile) {
        const prevSettings = this.settings.items[child.path] as BaseItemSettings | undefined;
        // 已有记录则原样保留，避免每个文件都重建对象
        if (prevSettings) continue;
        this.settings.items[child.path] = {
          ...DEFAULT_ITEM_SETTINGS,
          ctime: child.stat.ctime,
          mtime: child.stat.mtime,
        };
        changed = true;
      }
    }

    return changed;
  }

  /** 删除失效路径（由 plugin 传入校验函数） @returns 删除的条目数 */
  pruneInvalidPaths(isValid: (path: string) => boolean): number {
    let removed = 0;
    for (const path of Object.keys(this.settings.items)) {
      // 保留根路径，其余校验
      if (path !== "/" && !isValid(path)) {
        delete this.settings.items[path];
        removed++;
      }
    }
    return removed;
  }

  add(item: TAbstractFile): void {
    const insertPos = this.settings.newItemPlacement;
    this.log(`Adding new item '${item.path}' at '${insertPos}'`);

    const items = this.settings.items;
    const isFolder = item instanceof TFolder;
    const parentItem = items[item.parent!.path] as FolderSettings;
    if (!parentItem) return;

    const staged = this.pendingCopies.get(item.path);
    const existing = items[item.path] as BaseItemSettings | undefined;

    if (staged) {
      this.pendingCopies.delete(item.path);
      items[item.path] = staged.settings;
      this.log(`Restored staged settings for copied item '${item.path}'`);
    } else if (existing) {
      // ⚠️ 关键修复：该路径已有记录时，绝不能重建对象！
      // Obsidian 启动索引扫描会对「已存在的文件」再次触发 create 事件，
      // 若此处无条件写入 {...DEFAULT_ITEM_SETTINGS}（isHidden:false），
      // 就会把用户设置的「隐藏 / 置顶」抹掉 —— 这正是「重启后隐藏失效」的真凶。
      // 这里只补齐可能缺失的字段，保留既有的 isPinned / isHidden / customOrder 等。
      items[item.path] = {
        ...existing,
        ctime: existing.ctime ?? (item instanceof TFile ? item.stat.ctime : Date.now()),
        mtime: existing.mtime ?? (item instanceof TFile ? item.stat.mtime : Date.now()),
      } as ItemSettings;
      this.log(`Preserved existing settings for '${item.path}'`);
    } else {
      items[item.path] = {
        ...DEFAULT_ITEM_SETTINGS,
        ...(isFolder ? { customOrder: [], sortOrder: "custom" as const } : {}),
        ctime: Date.now(),
        mtime: Date.now(),
      };
    }

    if (!parentItem.customOrder.includes(item.name)) {
      const sourceName = staged?.sourceName;
      if (sourceName) {
        const sourceIndex = parentItem.customOrder.indexOf(sourceName);
        parentItem.customOrder.splice(sourceIndex + 1, 0, item.name);
      } else if (insertPos === "top") {
        parentItem.customOrder.unshift(item.name);
      } else {
        parentItem.customOrder.push(item.name);
      }
    }

    this.persistCreateDeleteChange();
  }

  move(
    oldPath: string,
    newPath: string,
    siblingPath?: string,
    insertSide?: "before" | "after"
  ): void {
    this.log(`Moving '${oldPath}' to '${newPath}' ${insertSide} '${siblingPath}'`);
    if (oldPath === newPath && siblingPath === newPath) return this.log("No move needed");

    const items = this.settings.items;
    const fromName = this.getName(oldPath);
    const toName = this.getName(newPath);
    const fromParentPath = this.getParentPath(oldPath);
    const toParentPath = this.getParentPath(newPath);
    const fromParent = items[fromParentPath] as FolderSettings | undefined;
    const toParent = items[toParentPath] as FolderSettings | undefined;
    const parentChanged = fromParentPath !== toParentPath;

    // 跨文件夹移动时，vault 的 rename 事件（不带落点）和调用方（带落点）会各自进来一次，
    // 谁先到谁就把 items 的键从 oldPath 搬到 newPath。后到的那次不能因为「旧路径没了」
    // 就整段退出——带落点的调用一跳过，位置就永远丢了。
    const alreadyTransferred = !(oldPath in items);
    if (alreadyTransferred && (!siblingPath || !(newPath in items))) {
      return this.log("No settings entry for the source item, skipping");
    }

    if (!alreadyTransferred && oldPath !== newPath) {
      items[newPath] = items[oldPath];
      delete items[oldPath];
    }

    if (fromParent && toParent) {
      const fromIndex = fromParent.customOrder.indexOf(fromName);

      let insertIndex = 0;
      if (siblingPath) {
        const siblingIndex = toParent.customOrder.indexOf(this.getName(siblingPath));
        insertIndex = insertSide === "before" ? siblingIndex : siblingIndex + 1;
      }

      fromParent.customOrder = fromParent.customOrder.filter((p) => {
        if (p === fromName) {
          if (!parentChanged && fromIndex < insertIndex) insertIndex--;
          return false;
        }
        return true;
      });

      // 目标清单里已有这个名字 = 事件先跑过一次、把它插在了最上面。
      // 明确给了落点就得摘下来重放到落点，否则用户永远看到「落到最前面」。
      const presentIndex = toParent.customOrder.indexOf(toName);
      if (presentIndex !== -1 && siblingPath) {
        toParent.customOrder.splice(presentIndex, 1);
        if (presentIndex < insertIndex) insertIndex--;
      }

      if (!toParent.customOrder.includes(toName)) {
        const at = Math.max(0, Math.min(insertIndex, toParent.customOrder.length));
        toParent.customOrder.splice(at, 0, toName);
      }
    }

    void this.saveSettings();

    // 父文件夹未变化（同一个文件夹内换位置）时，vault 不会触发 rename 事件，
    // 必须主动让文件浏览器重排，否则界面上的顺序不会更新。
    if (!parentChanged) this.onChanged();
  }

  remove(path: string): void {
    this.log(`Removing item '${path}'`);
    const items = this.settings.items;
    const name = this.getName(path);
    const parentItem = items[this.getParentPath(path)] as FolderSettings | undefined;

    delete items[path];
    if (parentItem) {
      parentItem.customOrder = parentItem.customOrder.filter((p) => p !== name);
    }

    this.persistCreateDeleteChange();
  }

  private persistCreateDeleteChange(): void {
    if (!this.settings.persistOrderOnCreateDelete) {
      return this.log("Order persistence on create/delete disabled, skipping save");
    }
    void this.saveSettings();
  }

  stageCopyState(sourcePath: string, copyPath: string): void {
    const items = this.settings.items;
    const sourcePrefix = sourcePath === "/" ? "" : sourcePath + "/";
    const copyPrefix = copyPath === "/" ? "" : copyPath + "/";

    for (const [path, settings] of Object.entries(items)) {
      if (path !== sourcePath && !path.startsWith(sourcePrefix)) continue;
      const copyItemPath =
        path === sourcePath ? copyPath : copyPrefix + path.slice(sourcePrefix.length);
      this.pendingCopies.set(copyItemPath, {
        settings: JSON.parse(JSON.stringify(settings)),
        sourceName: path === sourcePath ? this.getName(sourcePath) : undefined,
      });
    }
    this.log(`Staged copy state from '${sourcePath}' to '${copyPath}'`);
  }

  /** 按文件夹设置排序：先置顶，再按 sortOrder */
  getSortedItems(
    folderSettings: FolderSettings,
    items: { file: TAbstractFile }[]
  ): { file: TAbstractFile }[] {
    // ⚠️ 性能：原实现在比较器里对每对元素调用 customOrder.indexOf()，
    // 复杂度 O(n²logn)。这里预建 name → index 的 Map，把比较降到 O(1)。
    const orderIndex = new Map<string, number>();
    folderSettings.customOrder.forEach((name, i) => orderIndex.set(name, i));

    return items.slice().sort((aItem, bItem) => {
      const [a, b] = [aItem.file, bItem.file];
      const aSet = this.settings.items[a.path] as BaseItemSettings | undefined;
      const bSet = this.settings.items[b.path] as BaseItemSettings | undefined;
      const isAPinned = aSet?.isPinned ?? false;
      const isBPinned = bSet?.isPinned ?? false;
      if (isAPinned !== isBPinned) return isAPinned ? -1 : 1;

      if (folderSettings.sortOrder !== "custom") {
        const isAFolder = a instanceof TFolder;
        const isBFolder = b instanceof TFolder;
        if (isAFolder !== isBFolder) return isAFolder ? -1 : 1;
      }

      switch (folderSettings.sortOrder) {
        case "custom": {
          const aIndex = orderIndex.get(a.name) ?? -1;
          const bIndex = orderIndex.get(b.name) ?? -1;
          if (aIndex === -1 || bIndex === -1) return this.compareByName(a, b);
          return aIndex - bIndex;
        }
        case "byNameDesc":
          return this.compareByName(b, a);
        case "byCreatedTimeAsc":
          return this.compareByTimestamp(a, b, "ctime", "asc");
        case "byCreatedTimeDesc":
          return this.compareByTimestamp(a, b, "ctime", "desc");
        case "byModifiedTimeAsc":
          return this.compareByTimestamp(a, b, "mtime", "asc");
        case "byModifiedTimeDesc":
          return this.compareByTimestamp(a, b, "mtime", "desc");
        case "byNameAsc":
        default:
          return this.compareByName(a, b);
      }
    });
  }

  private compareByName(a: TAbstractFile, b: TAbstractFile): number {
    return collator.compare(a.name, b.name);
  }

  private compareByTimestamp(
    a: TAbstractFile,
    b: TAbstractFile,
    type: "ctime" | "mtime",
    direction: "asc" | "desc"
  ): number {
    const aSet = a instanceof TFile ? (this.settings.items[a.path] as BaseItemSettings) : undefined;
    const bSet = b instanceof TFile ? (this.settings.items[b.path] as BaseItemSettings) : undefined;
    const aTimestamp = aSet?.[type] ?? -Infinity;
    const bTimestamp = bSet?.[type] ?? -Infinity;
    return direction === "asc" ? aTimestamp - bTimestamp : bTimestamp - aTimestamp;
  }

  private getName(path: string): string {
    return path.substring(path.lastIndexOf("/") + 1);
  }

  private getParentPath(path: string): string {
    return path.substring(0, path.lastIndexOf("/")) || "/";
  }
}
