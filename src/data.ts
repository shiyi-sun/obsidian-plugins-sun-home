import { App, TAbstractFile, TFolder, TFile } from "obsidian";
import {
  OrderSettings,
  DEFAULT_ORDER_SETTINGS,
  isFolderSettings,
} from "./core/order-types";
import { AdmonitionConfig, DEFAULT_ADMONITION } from "./features/admonition";

/** 一个知识库 = 根目录下的一级文件夹，或某个分组文件夹的直接子文件夹 */
export interface KnowledgeBase {
  /** 文件夹路径（同时也是唯一 id），例如 "工作/中药手册" */
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

/**
 * 一个分组 = vault 根目录下的一个真实文件夹。
 * 旧版虚拟分组没有 path 字段（只存在 data.json 里），迁移后写入真实路径。
 */
export interface KnowledgeGroup {
  id: string;
  /** 显示名，与分组文件夹名保持一致 */
  name: string;
  /** 真实文件夹路径，例如 "工作"。旧版虚拟分组为空 */
  path?: string;
  /** 组内知识库的排序（存 path），未列入的排后面 */
  order: string[];
}

/** 知识库卡片的视觉模式 */
export type CardStyle = "border" | "gray" | "divider";

/** 持久化到插件 data.json 的配置 */
export interface KbSettings {
  /** 卡片墙外观：线框 / 浅灰底 / 分隔线 */
  cardStyle: CardStyle;
  /** 分组定义；新版每组对应一个真实文件夹 */
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
  cardStyle: "border",
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

/** 分组是否已经落到真实文件夹 */
export function isRealGroup(group: KnowledgeGroup): boolean {
  return !!group.path;
}

/** 是否还有尚未迁移的旧版虚拟分组 */
export function hasLegacyGroups(settings: KbSettings): boolean {
  return settings.groups.some((g) => !g.path);
}

export function parentPathOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "/" : path.slice(0, i) || "/";
}

export function baseNameOf(path: string): string {
  return path.substring(path.lastIndexOf("/") + 1) || path;
}

export function joinPath(parentPath: string, name: string): string {
  return parentPath === "/" || parentPath === "" ? name : `${parentPath}/${name}`;
}

export function getFolder(app: App, path: string): TFolder | null {
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFolder ? f : null;
}

export function pathExists(app: App, path: string): boolean {
  const vault = app.vault as unknown as {
    getAbstractFileByPathInsensitive?: (p: string) => TAbstractFile | null;
  };
  if (typeof vault.getAbstractFileByPathInsensitive === "function") {
    if (vault.getAbstractFileByPathInsensitive(path)) return true;
  }
  return !!app.vault.getAbstractFileByPath(path);
}

/** 判断某个顶层文件夹是否应当被视为知识库 */
function isHiddenFolder(name: string): boolean {
  return name.startsWith(".");
}

/** 新文件夹名做跨平台清理；Windows 下这些字符或保留名会直接创建失败 */
export function safeFolderName(raw: string): string {
  let name = raw
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[. ]+$/g, "");
  if (!name) name = "未命名";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name += "_";
  return name;
}

/** 目标处已有同名项时像原生一样自动避让（文件保留扩展名：xx.md → xx 1.md） */
export function uniquePath(
  app: App,
  parentPath: string,
  name: string,
  isFile = false
): string {
  const dot = isFile ? name.lastIndexOf(".") : -1;
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  let candidate = joinPath(parentPath, name);
  if (!pathExists(app, candidate)) return candidate;
  for (let i = 1; ; i++) {
    candidate = joinPath(parentPath, `${stem} ${i}${ext}`);
    if (!pathExists(app, candidate)) return candidate;
  }
}

/**
 * 扫描 vault，把知识库识别出来：
 * - 真实分组文件夹的直接子文件夹 → 组内知识库
 * - 根目录下未被登记为分组的文件夹 → 未分组知识库
 * - 旧版虚拟分组仍在根目录的成员 → 按 groups[].order 识别（迁移前兼容）
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
  const groupPaths = new Set(
    settings.groups.map((g) => g.path).filter((p): p is string => !!p)
  );

  const list: KnowledgeBase[] = [];
  const pushKb = (folder: TFolder, groupId: string | null): void => {
    if (isHiddenFolder(folder.name) || isHidden(folder.path)) return;
    const override = settings.overrides[folder.path];
    list.push({
      path: folder.path,
      name: override?.name || folder.name,
      icon: override?.icon,
      docCount: countDocs(folder),
      groupId,
    });
  };

  // 真实分组：直接子文件夹（跳过嵌套分组文件夹本身）
  for (const group of settings.groups) {
    if (!group.path) continue;
    const groupFolder = getFolder(app, group.path);
    if (!groupFolder || isHiddenFolder(groupFolder.name) || isHidden(groupFolder.path)) continue;
    for (const child of groupFolder.children) {
      if (!(child instanceof TFolder) || groupPaths.has(child.path)) continue;
      pushKb(child, group.id);
    }
  }

  // 根目录：未分组知识库 + 尚未迁移的虚拟分组
  for (const child of root.children) {
    if (!(child instanceof TFolder) || groupPaths.has(child.path)) continue;
    pushKb(child, findGroupOf(settings, child.path));
  }

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

/**
 * 某知识库当前属于哪个分组。
 * 新版按父目录判断（分组文件夹的直接子文件夹）；
 * 旧版虚拟分组仍从 order 数组里取，保证迁移前能用。
 */
export function findGroupOf(settings: KbSettings, path: string): string | null {
  const parent = parentPathOf(path);
  for (const g of settings.groups) {
    if (g.path && g.path === parent) return g.id;
  }
  if (parent === "/") {
    for (const g of settings.groups) {
      if (!g.path && g.order.includes(path)) return g.id;
    }
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

/** 新建知识库文件夹（parentPath 为 "/" 时建在 vault 根目录） */
export async function createKnowledgeBase(
  app: App,
  name: string,
  parentPath = "/"
): Promise<string> {
  const folderName = safeFolderName(name);
  if (!folderName) throw new Error("名称不能为空");
  const parent =
    parentPath === "/" || parentPath === ""
      ? app.vault.getRoot()
      : getFolder(app, parentPath);
  if (!parent) throw new Error(`父文件夹不存在：${parentPath}`);
  const path = joinPath(parent.path, folderName);
  if (pathExists(app, path)) {
    throw new Error(`已存在同名文件夹：${path}`);
  }
  await app.vault.createFolder(path);
  return path;
}

/** 新建真实分组文件夹（重名直接报错，避免把已有知识库误转成分组） */
export async function createGroupFolder(app: App, name: string): Promise<string> {
  const folderName = safeFolderName(name);
  const path = joinPath("/", folderName);
  if (pathExists(app, path)) {
    throw new Error(`已存在同名文件夹：${path}`);
  }
  await app.vault.createFolder(path);
  return path;
}

/**
 * 把组内排序 / 未分组排序与文件系统对齐。
 * 归属只认目录层级，order 数组只负责排序；外部新增/移动/删除文件夹后调用。
 * @returns 是否有改动
 */
export function reconcileGroupOrders(app: App, settings: KbSettings): boolean {
  let changed = false;
  const groupPaths = new Set(
    settings.groups.map((g) => g.path).filter((p): p is string => !!p)
  );

  for (const group of settings.groups) {
    if (!group.path) continue;
    const folder = getFolder(app, group.path);
    if (!folder) continue;

    if (group.name !== folder.name) {
      group.name = folder.name;
      changed = true;
    }

    const children = folder.children
      .filter(
        (c): c is TFolder =>
          c instanceof TFolder && !groupPaths.has(c.path) && !isHiddenFolder(c.name)
      )
      .map((c) => c.path)
      .sort((a, b) => baseNameOf(a).localeCompare(baseNameOf(b), "zh"));

    const next = group.order.filter((p) => children.includes(p));
    for (const p of children) if (!next.includes(p)) next.push(p);
    if (next.length !== group.order.length || next.some((p, i) => p !== group.order[i])) {
      group.order = next;
      changed = true;
    }
  }

  const legacyMembers = new Set<string>();
  for (const group of settings.groups) {
    if (group.path) continue;
    for (const p of group.order) legacyMembers.add(p);
  }

  const rootKbs = app.vault
    .getRoot()
    .children.filter(
      (c): c is TFolder =>
        c instanceof TFolder &&
        !groupPaths.has(c.path) &&
        !legacyMembers.has(c.path) &&
        !isHiddenFolder(c.name)
    )
    .map((c) => c.path)
    .sort((a, b) => baseNameOf(a).localeCompare(baseNameOf(b), "zh"));

  const nextUngrouped = settings.ungroupedOrder.filter((p) => rootKbs.includes(p));
  for (const p of rootKbs) if (!nextUngrouped.includes(p)) nextUngrouped.push(p);
  if (
    nextUngrouped.length !== settings.ungroupedOrder.length ||
    nextUngrouped.some((p, i) => p !== settings.ungroupedOrder[i])
  ) {
    settings.ungroupedOrder = nextUngrouped;
    changed = true;
  }

  return changed;
}

function remapPath(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  if (path.startsWith(oldPath + "/")) return newPath + path.slice(oldPath.length);
  return path;
}

/**
 * 文件夹被重命名 / 移动后，把所有按路径存的状态迁到新路径。
 * 包括名称覆盖、分组文件夹路径、组内/未分组排序、排序引擎的 items 键与父级 customOrder。
 * SortFeature 自己也会处理 items 键；这里做成幂等的，谁先跑都行。
 */
export function migrateSettingsPaths(
  settings: KbSettings,
  oldPath: string,
  newPath: string
): boolean {
  if (!oldPath || oldPath === newPath) return false;
  let changed = false;

  // 知识库显示名 / 图标覆盖
  const overrides: KbSettings["overrides"] = {};
  for (const [path, value] of Object.entries(settings.overrides)) {
    const next = remapPath(path, oldPath, newPath);
    if (next !== path) changed = true;
    overrides[next] = value;
  }
  settings.overrides = overrides;

  // 分组文件夹自身路径
  for (const group of settings.groups) {
    if (!group.path) continue;
    const next = remapPath(group.path, oldPath, newPath);
    if (next !== group.path) {
      group.path = next;
      group.name = baseNameOf(next);
      changed = true;
    }
  }

  // 排序数组（组内 + 未分组）
  for (const group of settings.groups) {
    const next = group.order.map((p) => remapPath(p, oldPath, newPath));
    if (next.some((p, i) => p !== group.order[i])) {
      group.order = next;
      changed = true;
    }
  }
  const nextUngrouped = settings.ungroupedOrder.map((p) =>
    remapPath(p, oldPath, newPath)
  );
  if (nextUngrouped.some((p, i) => p !== settings.ungroupedOrder[i])) {
    settings.ungroupedOrder = nextUngrouped;
    changed = true;
  }

  // 排序引擎的按路径条目
  const items: OrderSettings["items"] = {};
  for (const [path, value] of Object.entries(settings.order.items)) {
    const next = remapPath(path, oldPath, newPath);
    if (next !== path) changed = true;
    items[next] = value;
  }
  settings.order.items = items;

  // 父文件夹 customOrder 里存的是名字，不是路径
  const oldName = baseNameOf(oldPath);
  const newName = baseNameOf(newPath);
  const oldParentPath = parentPathOf(oldPath);
  const newParentPath = parentPathOf(newPath);
  const oldParent = settings.order.items[oldParentPath];
  if (isFolderSettings(oldParent)) {
    const idx = oldParent.customOrder.indexOf(oldName);
    if (idx !== -1) {
      if (oldParentPath === newParentPath) oldParent.customOrder[idx] = newName;
      else oldParent.customOrder.splice(idx, 1);
      changed = true;
    }
  }
  if (oldParentPath !== newParentPath) {
    const newParent = settings.order.items[newParentPath];
    if (isFolderSettings(newParent) && !newParent.customOrder.includes(newName)) {
      newParent.customOrder.push(newName);
      changed = true;
    }
  }

  return changed;
}

// ============================================================
// 旧版虚拟分组迁移
// ============================================================

export interface LegacyMigrationGroup {
  group: KnowledgeGroup;
  /** 当前仍在根目录、可以被搬进分组文件夹的成员 */
  members: TFolder[];
}

export function planLegacyMigration(app: App, settings: KbSettings): LegacyMigrationGroup[] {
  const rootPath = app.vault.getRoot().path;
  return settings.groups
    .filter((g) => !g.path)
    .map((group) => ({
      group,
      members: group.order
        .map((p) => app.vault.getAbstractFileByPath(p))
        .filter(
          (f): f is TFolder => f instanceof TFolder && (f.parent?.path ?? "") === rootPath
        ),
    }));
}

export interface MigrationResult {
  moved: number;
  groups: { name: string; path: string; renamed: boolean }[];
  errors: string[];
}

/**
 * 把旧版虚拟分组落成真实文件夹：建组文件夹 → 移入成员 → 路径状态跟着迁移。
 * 幂等：已带 path 的分组跳过；中途失败下次可继续迁移剩下的。
 */
export async function migrateLegacyGroups(
  app: App,
  settings: KbSettings,
  onProgress?: (message: string) => void
): Promise<MigrationResult> {
  const result: MigrationResult = { moved: 0, groups: [], errors: [] };
  const pending = settings.groups.filter((g) => !g.path);

  for (const group of pending) {
    // 先按旧 order 抓住成员：建好组文件夹后会触发 create 事件，
    // reconcile 看到“组文件夹是空的”会清空 order，不能等那之后再取。
    const members = group.order
      .map((p) => app.vault.getAbstractFileByPath(p))
      .filter(
        (f): f is TFolder =>
          f instanceof TFolder &&
          (f.parent?.path ?? "") === app.vault.getRoot().path
      );

    const desired = safeFolderName(group.name);
    const folderPath = uniquePath(app, "/", desired);
    try {
      await app.vault.createFolder(folderPath);
    } catch (err) {
      result.errors.push(`创建分组文件夹「${desired}」失败：${String(err)}`);
      continue;
    }

    const renamed = baseNameOf(folderPath) !== group.name;
    group.path = folderPath;
    group.name = baseNameOf(folderPath);
    result.groups.push({ name: group.name, path: folderPath, renamed });

    const movedPaths: string[] = [];
    for (const member of members) {
      const oldPath = member.path;
      onProgress?.(`移动「${member.name}」→「${group.name}」`);
      const target = uniquePath(app, folderPath, member.name);
      try {
        await app.fileManager.renameFile(member, target);
      } catch (err) {
        result.errors.push(`移动「${oldPath}」失败：${String(err)}`);
        continue;
      }
      migrateSettingsPaths(settings, oldPath, target);
      movedPaths.push(target);
      result.moved++;
    }
    // 按旧组内顺序写回；reconcile 再把其它已存在的子文件夹补到末尾
    group.order = movedPaths;
  }

  reconcileGroupOrders(app, settings);
  return result;
}

export interface DissolveResult {
  moved: number;
  errors: string[];
  folderDeleted: boolean;
}

/**
 * 删除真实分组：把组内所有内容移到根目录（知识库回到未分组），再删除空文件夹。
 * 绝不递归删除笔记；有内容搬不走时保留分组，便于重试。
 */
export async function dissolveGroup(
  app: App,
  settings: KbSettings,
  group: KnowledgeGroup
): Promise<DissolveResult> {
  const result: DissolveResult = { moved: 0, errors: [], folderDeleted: false };
  const folder = group.path ? getFolder(app, group.path) : null;

  if (folder) {
    for (const child of [...folder.children]) {
      const oldPath = child.path;
      const target = uniquePath(app, "/", child.name, child instanceof TFile);
      try {
        await app.fileManager.renameFile(child, target);
      } catch (err) {
        result.errors.push(`移动「${oldPath}」失败：${String(err)}`);
        continue;
      }
      migrateSettingsPaths(settings, oldPath, target);
      result.moved++;
    }

    // 不能只看 TFolder.children：Obsidian 的索引可能忽略点文件，
    // 而下面的删除是递归的，必须用底层目录列表确认真的为空
    let empty = (getFolder(app, folder.path)?.children.length ?? 0) === 0;
    if (empty) {
      try {
        const listing = await app.vault.adapter.list(folder.path);
        empty = listing.files.length === 0 && listing.folders.length === 0;
      } catch (err) {
        empty = false;
        result.errors.push(`无法确认分组文件夹是否为空：${String(err)}`);
      }
    }

    if (empty) {
      try {
        // 这个版本的 Obsidian 对空目录调用 delete(file) / rmdir(path, false)
        // 会落到 fs.rm 并报 EISDIR，必须显式 recursive（此时已确认目录是空的）
        await app.vault.delete(folder, true);
        result.folderDeleted = true;
      } catch (err) {
        try {
          await app.vault.adapter.rmdir(folder.path, true);
          result.folderDeleted = true;
        } catch (err2) {
          result.errors.push(`删除空分组文件夹失败：${String(err2)}`);
        }
      }
    } else if (result.errors.length === 0) {
      result.errors.push("分组文件夹里还有内容未能移出");
    }
  } else {
    result.folderDeleted = true;
  }

  if (result.folderDeleted) {
    settings.groups = settings.groups.filter((g) => g.id !== group.id);
  }
  reconcileGroupOrders(app, settings);
  return result;
}

/** 生成一个唯一的分组 id */
export function genGroupId(): string {
  return "g_" + Math.random().toString(36).slice(2, 9);
}
