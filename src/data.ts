import { App, TAbstractFile, TFolder, TFile } from "obsidian";
import { OrderSettings, DEFAULT_ORDER_SETTINGS } from "./core/order-types";
import { AdmonitionConfig, DEFAULT_ADMONITION } from "./features/admonition";

/** 一个知识库 = vault 根目录下的一个一级文件夹 */
export interface KnowledgeBase {
  /** 文件夹路径（同时也是唯一 id），例如 "中药手册" */
  path: string;
  /** 显示名称，默认取文件夹名，可被配置覆盖 */
  name: string;
  /** 该库下的文档（.md）数量，含所有子层级 */
  docCount: number;
  /** 可选的 emoji / 图标 */
  icon?: string;
  /** 所属分组 id，null 表示未分组 */
  groupId: string | null;
}

/** 一个分组 = 纯虚拟概念，不对应任何真实文件夹 */
export interface KnowledgeGroup {
  id: string;
  name: string;
  /** 组内知识库的排序（存 path），未列入的排后面 */
  order: string[];
}

/** 持久化到插件 data.json 的配置 */
export interface KbSettings {
  /** 分组定义；分组是虚拟的，只用于归类展示 */
  groups: KnowledgeGroup[];
  /** 各知识库的元信息覆盖（名称 / 图标） */
  overrides: Record<string, { name?: string; icon?: string }>;
  /** 未分组知识库的排序 */
  ungroupedOrder: string[];
  /** 启动时是否自动打开知识库列表页 */
  openOnStartup: boolean;
  /** 卡片墙列数上限（响应式，仅作提示） */
  maxColumns: number;
  /** 排序 / 置顶 / 隐藏 配置（整合自 flexplorer） */
  order: OrderSettings;
  /** 提示块（::: 语法）功能，由 AdmonitionFeature 使用 */
  admonition: AdmonitionConfig;
}

export const DEFAULT_SETTINGS: KbSettings = {
  groups: [],
  overrides: {},
  ungroupedOrder: [],
  openOnStartup: true,
  maxColumns: 4,
  // ⚠️ 必须深拷贝：若直接引用 DEFAULT_ORDER_SETTINGS，则所有实例共享同一个
  // items / hidePatterns 对象；任何写入都会污染全局默认值，且下次加载时
  // 会把上一轮的残留数据当成"默认值"带进来。这是「隐藏状态重启后错乱」的根源之一。
  order: {
    ...DEFAULT_ORDER_SETTINGS,
    items: {},
    hidePatterns: [],
  },
  admonition: { ...DEFAULT_ADMONITION },
};

/** 判断某个顶层文件夹是否应当被视为知识库 */
function isHiddenFolder(name: string): boolean {
  return name.startsWith(".");
}

/**
 * 扫描 vault，把所有一级文件夹识别为知识库。
 * 排序规则：先按分组内的 order，再按未分组 order，未出现的排在最后（按名称）。
 *
 * @param isHidden 「该路径当前是否被隐藏」——由调用方提供（与原生树共用同一套
 *   手动隐藏 + glob 规则）。隐藏起来的文件夹不该在知识库列表里冒头。
 */
export function scanKnowledgeBases(
  app: App,
  settings: KbSettings,
  isHidden: (path: string) => boolean = () => false
): KnowledgeBase[] {
  const root = app.vault.getRoot();
  const folders = root.children.filter(
    (c): c is TFolder =>
      c instanceof TFolder && !isHiddenFolder(c.name) && !isHidden(c.path)
  );

  const list: KnowledgeBase[] = folders.map((folder) => {
    const override = settings.overrides[folder.path];
    return {
      path: folder.path,
      name: override?.name || folder.name,
      icon: override?.icon,
      docCount: countDocs(folder),
      groupId: findGroupOf(settings, folder.path),
    };
  });

  // 按配置顺序排序
  const weight = (kb: KnowledgeBase): number => {
    if (kb.groupId) {
      const g = settings.groups.find((x) => x.id === kb.groupId);
      const idx = g ? g.order.indexOf(kb.path) : -1;
      return idx === -1 ? 9999 : idx;
    }
    const idx = settings.ungroupedOrder.indexOf(kb.path);
    return idx === -1 ? 9999 : idx;
  };

  return list.sort((a, b) => {
    const wa = weight(a);
    const wb = weight(b);
    if (wa !== wb) return wa - wb;
    return a.name.localeCompare(b.name, "zh");
  });
}

/** 某知识库当前属于哪个分组（分组归属只存在 order 数组里，没有单独字段） */
export function findGroupOf(settings: KbSettings, path: string): string | null {
  for (const g of settings.groups) {
    if (g.order.includes(path)) return g.id;
  }
  return null;
}

/** 递归统计文件夹里的 .md 文件数量 */
export function countDocs(folder: TFolder): number {
  let n = 0;
  const walk = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && child.extension === "md") n++;
    }
  };
  walk(folder);
  return n;
}

/** 取某个知识库文件夹下的直接子项（用于树视图） */
export function getChildren(app: App, path: string): TAbstractFile[] {
  const folder = app.vault.getAbstractFileByPath(path);
  if (folder instanceof TFolder) {
    return folder.children
      .slice()
      .sort((a, b) => {
        // 文件夹在前，文件在后；同类按名称
        const af = a instanceof TFolder ? 0 : 1;
        const bf = b instanceof TFolder ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.name.localeCompare(b.name, "zh");
      });
  }
  return [];
}

/** 新建知识库文件夹 */
export async function createKnowledgeBase(app: App, name: string): Promise<string> {
  const path = name.trim();
  if (!path) throw new Error("名称不能为空");
  if (app.vault.getAbstractFileByPath(path)) {
    throw new Error(`已存在同名文件夹：${path}`);
  }
  await app.vault.createFolder(path);
  return path;
}

/** 生成一个唯一的分组 id */
export function genGroupId(): string {
  return "g_" + Math.random().toString(36).slice(2, 9);
}
