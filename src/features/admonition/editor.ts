/**
 * 实时预览里的提示块渲染（CodeMirror 6 块级装饰）。
 *
 * 结构：
 * - 用 StateField（不是 ViewPlugin）保存「块集合 + 装饰 + 光标所在块」，
 *   因为要整段替换多行、改变垂直布局，ViewPlugin 的装饰不允许影响布局。
 * - 光标进入某个块时该块回退成源码，方便编辑；离开时再装饰回去。
 *
 * 重算策略（这里是本文件唯一的复杂度来源）：
 * 每次按键、每次移动光标都会走到 update()。全文重扫的成本是 O(文档行数)，
 * 一万两千行的笔记里长按方向键能占到每秒 56ms。所以先花 O(改动处) 判断
 * 「结构到底有没有可能变了」，能确定没变就沿用缓存 —— 实测把同一场景压到
 * 每秒 0.09ms。判据见 canReuse()。
 */
import {
  EditorState,
  Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import {
  App,
  MarkdownRenderChild,
  MarkdownRenderer,
  editorInfoField,
  editorLivePreviewField,
} from "obsidian";
import {
  BlockMeta,
  DEFAULT_TITLE,
  ICON_PATHS,
  collectBlocks,
  markerKey,
} from "./parser";
import type { AdmonitionConfig } from "./index";

export interface EditorProbe {
  /** 全文重扫次数（贵路径） */
  scanAll: number;
  /** 沿用缓存块集合、只平移装饰位置次数（便宜路径） */
  reuse: number;
  /** 仅因光标进出块而重算装饰次数 */
  fromCache: number;
  /** 块 widget 真正建 DOM 的次数（用来验「可视区外不渲染」是否成立） */
  widgetDoms: number;
}

interface EditorConfig {
  app: App;
  getSettings: () => AdmonitionConfig;
  probe: EditorProbe;
}

/** 设置变更后触发重算 */
export const refreshEffect = StateEffect.define<void>();

/** widget DOM 上挂的 Markdown 渲染生命周期持有者 */
const CHILD = "__kbAdmonitionChild";

class AdmonitionWidget extends WidgetType {
  constructor(
    private readonly meta: BlockMeta,
    private readonly body: string,
    private readonly app: App,
    private readonly sourcePath: string,
    private readonly probe: EditorProbe
  ) {
    super();
  }

  eq(other: AdmonitionWidget): boolean {
    return (
      other.meta.startLine === this.meta.startLine &&
      other.meta.type === this.meta.type &&
      other.meta.title === this.meta.title &&
      other.body === this.body
    );
  }

  toDOM(view: EditorView): HTMLElement {
    this.probe.widgetDoms++;
    const meta = this.meta;
    const root = createDiv();
    root.addClass("admonition", `admonition-${meta.type}`, "admonition-cm-block");
    root.setAttr("data-admonition-type", meta.type);

    const heading = root.createDiv({ cls: "admonition-heading" });
    const iconWrap = heading.createDiv({ cls: "admonition-icon" });
    const icon = iconWrap.createSvg("svg", { attr: { viewBox: "0 0 24 24", "aria-hidden": "true" } });
    icon.createSvg("path", { attr: { d: ICON_PATHS[meta.type] } });
    const titleEl = heading.createDiv({ cls: "admonition-heading-text" });
    titleEl.setText(meta.title ?? DEFAULT_TITLE[meta.type]);

    const contentEl = root.createDiv({ cls: "admonition-content" });
    contentEl.setText(this.body || " ");

    // 点块 → 光标落到块首，回退成源码好编辑
    root.addEventListener("mousedown", (evt) => {
      if ((evt.target as HTMLElement).closest("a")) return;
      evt.preventDefault();
      const pos = view.posAtDOM(root);
      if (pos >= 0) {
        view.dispatch({ selection: { anchor: pos } });
        view.focus();
      }
    });

    // 给这一块的 Markdown 渲染一个可回收的 Component：块被拆掉时连带摘掉
    // 后处理器登记的事件与嵌入，不留僵尸（原来这里传的是 null）。
    const child = new MarkdownRenderChild(contentEl);
    child.load();
    (root as any)[CHILD] = child;

    void this.hydrate(contentEl, titleEl, child);
    return root;
  }

  private async hydrate(
    contentEl: HTMLElement,
    titleEl: HTMLElement,
    child: MarkdownRenderChild
  ): Promise<void> {
    const holder = createDiv();
    await MarkdownRenderer.render(this.app, this.body, holder, this.sourcePath, child);
    if (!contentEl.isConnected) return;
    contentEl.empty();
    while (holder.firstChild) contentEl.appendChild(holder.firstChild);

    const titleSource = this.meta.title;
    if (titleSource && /[*_~`[\]]/.test(titleSource)) {
      const titleHolder = createDiv();
      await MarkdownRenderer.render(this.app, titleSource, titleHolder, this.sourcePath, child);
      if (!titleEl.isConnected) return;
      titleEl.empty();
      while (titleHolder.firstChild) titleEl.appendChild(titleHolder.firstChild);
    }
  }

  ignoreEvent(): boolean {
    // 交给上面自己的 mousedown 处理（点击要把光标送进块里）
    return false;
  }

  destroy(dom: HTMLElement): void {
    const child = (dom as any)[CHILD] as MarkdownRenderChild | undefined;
    child?.unload();
    dom.remove();
  }
}

/* ------------------------------------------------------------------ */
/* 字段值与重算                                                        */
/* ------------------------------------------------------------------ */

const NO_DECO: DecorationSet = Decoration.none;

interface FieldValue {
  deco: DecorationSet;
  /** 缓存的块集合（行号，0 基） */
  blocks: BlockMeta[];
  lineCount: number;
  /** 光标所在块的起始行；-1 表示不在任何块内 */
  cursorBlockStart: number;
}

function blankValue(state: EditorState): FieldValue {
  return { deco: NO_DECO, blocks: [], lineCount: state.doc.lines, cursorBlockStart: -1 };
}

function docLines(state: EditorState): string[] {
  const ls: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) ls.push(state.doc.line(i).text);
  return ls;
}

/** 1 基行号落在哪个块里，返回该块起始行（0 基），不在任何块里返回 -1 */
function blockAtLine(blocks: BlockMeta[], line: number): number {
  for (const b of blocks) {
    if (line >= b.startLine + 1 && line <= b.endLine + 1) return b.startLine;
  }
  return -1;
}

function bodyText(state: EditorState, meta: BlockMeta): string {
  const inner: string[] = [];
  for (let i = meta.startLine + 2; i <= meta.endLine; i++) inner.push(state.doc.line(i).text);
  return inner.join("\n").replace(/^\n+|\n+$/g, "");
}

function decorate(
  state: EditorState,
  blocks: BlockMeta[],
  cfg: EditorConfig,
  cursorBlockStart: number
): DecorationSet {
  if (blocks.length === 0) return NO_DECO;
  const info = state.field(editorInfoField, false);
  const sourcePath = info?.file?.path ?? "";

  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  for (const meta of blocks) {
    // 光标正在这一块里 → 保留源码
    if (meta.startLine === cursorBlockStart) continue;
    const from = state.doc.line(meta.startLine + 1).from;
    const to = state.doc.line(meta.endLine + 1).to;
    ranges.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new AdmonitionWidget(meta, bodyText(state, meta), cfg.app, sourcePath, cfg.probe),
        block: true,
      }),
    });
  }
  if (ranges.length === 0) return NO_DECO;
  ranges.sort((a, b) => a.from - b.from);

  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

/** 贵路径：全文重扫 */
function fullBuild(state: EditorState, cfg: EditorConfig): FieldValue {
  cfg.probe.scanAll++;
  const blocks = collectBlocks(docLines(state));
  const cursorBlockStart = blockAtLine(blocks, state.doc.lineAt(state.selection.main.head).number);
  return {
    deco: decorate(state, blocks, cfg, cursorBlockStart),
    blocks,
    lineCount: state.doc.lines,
    cursorBlockStart,
  };
}

/**
 * 这次文档改动可否沿用缓存的块集合。三条都过才免重扫：
 * 1) 行数没变 —— 增删行会让后面所有块的行号平移；
 * 2) 改动所在行的「标记身份」没变 —— 比的是这行改前改后的指纹，而不是
 *    改动文本里有没有冒号。所以在 `:::tip` 前面补一个字母（插入文本不含冒号）
 *    也能被抓出来，反过来删掉一个冒号同样能抓出来；
 * 3) 改动不落在任何块的行范围内 —— 落在里面就意味着该块的标题或正文变了；
 *    唯一的例外是「光标正在那块里」，此时那块本来就显示源码、没有 widget，
 *    正文新不新无关紧要，等光标移出时会用当下的文档内容重新切正文。
 */
function canReuse(value: FieldValue, tr: Transaction): boolean {
  const next = tr.state;
  if (next.doc.lines !== value.lineCount) return false;
  const prevDoc = tr.startState.doc;

  let ok = true;
  tr.changes.iterChanges((fromA, _toA, fromB) => {
    if (!ok) return;
    const beforeLine = prevDoc.lineAt(fromA);
    const afterLine = next.doc.lineAt(fromB);
    if (markerKey(beforeLine.text) !== markerKey(afterLine.text)) {
      ok = false;
      return;
    }
    const lineNo = afterLine.number;
    for (const b of value.blocks) {
      if (lineNo < b.startLine + 1 || lineNo > b.endLine + 1) continue;
      if (b.startLine !== value.cursorBlockStart) {
        ok = false;
        return;
      }
    }
  });
  return ok;
}

function updateValue(value: FieldValue, tr: Transaction, cfg: EditorConfig): FieldValue {
  const state = tr.state;

  if (!cfg.getSettings().inEditor || state.field(editorLivePreviewField, false) !== true) {
    // 关掉或在源码模式：不画东西。已经是空的就把同一个对象还回去。
    return value.deco === NO_DECO && value.blocks.length === 0
      ? value
      : blankValue(state);
  }

  if (tr.effects.some((e) => e.is(refreshEffect))) return fullBuild(state, cfg);

  if (!tr.docChanged) {
    const line = state.doc.lineAt(state.selection.main.head).number;
    const cursorBlockStart = blockAtLine(value.blocks, line);
    // 结构与「光标在哪一块」都没变 → 什么都不做，把同一个对象还回去，
    // CodeMirror 见到引用相等就不会动装饰。
    if (cursorBlockStart === value.cursorBlockStart) return value;
    cfg.probe.fromCache++;
    return {
      ...value,
      cursorBlockStart,
      deco: decorate(state, value.blocks, cfg, cursorBlockStart),
    };
  }

  if (canReuse(value, tr)) {
    cfg.probe.reuse++;
    return {
      deco: value.deco.map(tr.changes),
      blocks: value.blocks,
      lineCount: state.doc.lines,
      cursorBlockStart: value.cursorBlockStart,
    };
  }
  return fullBuild(state, cfg);
}

export function buildEditorExtension(cfg: EditorConfig): Extension {
  return StateField.define<FieldValue>({
    create: (state) =>
      cfg.getSettings().inEditor ? fullBuild(state, cfg) : blankValue(state),
    update: (value, tr) => updateValue(value, tr, cfg),
    provide: (f) => EditorView.decorations.compute([f], (state) => state.field(f).deco),
  });
}

/** 让所有打开的编辑器重算一遍（开关切换时用） */
export function refreshEditors(app: App): void {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const cm = (leaf.view as any)?.editor?.cm as EditorView | undefined;
    void cm?.dispatch?.({ effects: refreshEffect.of() });
  }
}
