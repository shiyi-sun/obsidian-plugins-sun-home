/**
 * 排序与隐藏功能的类型定义
 * 移植自 flexplorer（MIT License, kh4f）
 */

export type SortOrder =
  | "custom"
  | "byNameAsc"
  | "byNameDesc"
  | "byCreatedTimeAsc"
  | "byCreatedTimeDesc"
  | "byModifiedTimeAsc"
  | "byModifiedTimeDesc";

export interface BaseItemSettings {
  isPinned: boolean;
  isHidden: boolean;
  /** 插件自维护的时间戳，跨设备稳定（不依赖 OS 文件属性） */
  ctime?: number;
  mtime?: number;
}

export interface FolderSettings extends BaseItemSettings {
  customOrder: string[];
  sortOrder: SortOrder;
}

export type ItemSettings = BaseItemSettings | FolderSettings;

export interface OrderSettings {
  /** 路径 → 设置 */
  items: Record<string, ItemSettings>;
  /** 是否显示被隐藏的条目 */
  showHidden: boolean;
  /** 隐藏规则（gitignore 风格 glob） */
  hidePatterns: string[];
  /** 新建条目的插入位置 */
  newItemPlacement: "top" | "bottom";
  /** 增删时是否持久化顺序 */
  persistOrderOnCreateDelete: boolean;
  debugMode: boolean;
}

export const DEFAULT_ORDER_SETTINGS: OrderSettings = {
  items: {},
  showHidden: false,
  hidePatterns: [],
  newItemPlacement: "top",
  persistOrderOnCreateDelete: true,
  debugMode: false,
};

/** 是否文件夹设置 */
export function isFolderSettings(s: ItemSettings | undefined): s is FolderSettings {
  return !!s && "customOrder" in s;
}

/** 取某路径的设置，缺失时返回默认值 */
export function getItemSettings(
  items: Record<string, ItemSettings>,
  path: string
): ItemSettings {
  if (!items[path]) {
    items[path] = { isPinned: false, isHidden: false };
  }
  return items[path];
}
