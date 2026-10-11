/**
 * 提示块语法解析：`:::type[标题]{attrs}` … `:::`。
 * 纯字符串处理，阅读视图与编辑器两条链路共用；类型、默认标题、图标也在这里单点定义。
 */

export type AdmonitionType = "note" | "tip" | "info" | "warning" | "danger";

export const TYPES: AdmonitionType[] = ["note", "tip", "info", "warning", "danger"];

export const DEFAULT_TITLE: Record<AdmonitionType, string> = {
  note: "NOTE",
  tip: "TIP",
  info: "INFO",
  warning: "WARNING",
  danger: "DANGER",
};

/** 24x24 viewBox 的 SVG path，颜色由 CSS 的 currentColor 决定 */
export const ICON_PATHS: Record<AdmonitionType, string> = {
  // 圆圈 + i
  note: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  // 灯泡
  tip: "M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z",
  // 圆圈 + i（信息）
  info: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  // 三角感叹号
  warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  // 火焰
  danger: "M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z",
};

/**
 * 起始标记，支持的写法：
 *   :::tip                → 默认标题
 *   :::tip 自定义标题      → 空格后直接跟标题
 *   :::tip[自定义标题]      → 方括号标题（Docusaurus 风格）
 *   :::tip+ / :::tip-      → 可折叠 / 默认折叠
 *   :::tip{.cls #id}       → 附加属性
 */
const OPEN_RE =
  /^[ \t]*:{3,}[ \t]*([A-Za-z][A-Za-z0-9_]*)[ \t]*([+-]?)[ \t]*(?:\[([^\]]*)\])?[ \t]*(\{[^}]*\})?[ \t]*(.*?)[ \t]*$/;

/** 结束标记：单独一行的 ::: */
const CLOSE_RE = /^[ \t]*:{3,}[ \t]*$/;

export interface ParsedOpen {
  type: AdmonitionType;
  title: string | null;
  collapsible: boolean;
  open: boolean;
}

export function isAdmonitionType(word: string): word is AdmonitionType {
  return (TYPES as string[]).includes(word.toLowerCase());
}

/** 解析起始标记行；不是提示块起始则返回 null */
export function parseOpen(line: string): ParsedOpen | null {
  const m = line.match(OPEN_RE);
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (!isAdmonitionType(type)) return null;

  const marker = m[2] ?? "";
  const attrs = (m[4] ?? "").toLowerCase();
  const collapsible = marker === "+" || marker === "-" || /\bopen\b|\bcollapsible\b/.test(attrs);
  const open = marker !== "-";

  // 标题：方括号优先，其次用行尾剩余文本（去掉包裹的 #id）
  let title = (m[3] ?? "").trim();
  if (!title) title = (m[5] ?? "").replace(/#[^\s{]+/g, "").trim();

  return { type, title: title || null, collapsible, open };
}

export function isClosing(line: string): boolean {
  return CLOSE_RE.test(line);
}

export interface BlockMeta {
  type: AdmonitionType;
  title: string | null;
  collapsible: boolean;
  open: boolean;
  /** 起始行（0 基） */
  startLine: number;
  /** 结束行（0 基） */
  endLine: number;
}

/** 扫描整篇文档，收集所有提示块（支持嵌套；未闭合的整块忽略） */
export function collectBlocks(lines: string[]): BlockMeta[] {
  const out: BlockMeta[] = [];

  for (let i = 0; i < lines.length; i++) {
    const open = parseOpen(lines[i]);
    if (!open) continue;

    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (parseOpen(lines[j])) {
        depth++;
        continue;
      }
      if (isClosing(lines[j])) {
        if (depth === 0) {
          end = j;
          break;
        }
        depth--;
      }
    }
    if (end === -1) continue;

    out.push({ ...open, startLine: i, endLine: end });
    i = end;
  }

  return out;
}

/**
 * 一行的「标记身份」指纹。编辑器增量重算用它判断：改动前后这行是否还是
 * 同一个标记（同类型、同标题、同折叠态）。指纹相同 → 块结构不可能变化。
 */
export function markerKey(line: string): string {
  const open = parseOpen(line);
  if (open) return `o|${open.type}|${open.title ?? ""}|${open.collapsible ? 1 : 0}|${open.open ? 1 : 0}`;
  return isClosing(line) ? "c" : "-";
}
