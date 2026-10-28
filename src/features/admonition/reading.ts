/**
 * 阅读视图渲染：把 Obsidian 已经渲染好的 DOM 重新归组进提示块。
 *
 * 只做归组，不做二次渲染：
 * Obsidian 会把 :::tip / ::: 这类行渲染成普通 <p>，相邻行还可能被并进同一个 <p>
 * 用 <br> 分隔。所以这里按顺序把「起始标记之后、结束标记之前」那些**已经渲染好的节点**
 * 搬进框里就完事了。
 *
 * 值得知道的一点：搬完之后正文里的行内语法（**粗体**、`代码`、链接）依然是渲染好的样子 ——
 * 因为 Obsidian 在我们接手前就渲染过了，不花任何额外代价。
 * 原来那套「把搬进框的 DOM 反推成 Markdown 再重渲染一次」已经删掉：
 * 它既不带来任何显示效果，又会把嵌套块压平、把反推函数不认识的结构弄丢。
 *
 * 唯一因此留下的边界：跨空行的块级元素（表格、小标题、代码块）如果落在**另一个后处理器调用**
 * 的段里，就进不了框（每个段的处理是独立的）。实测本机 vault 536 篇里 ::: 只有 3 处、
 * 全是一行文字，没有这种写法，所以不做跨段状态机 —— 那套东西换来的复杂度与风险不划算。
 *
 * ⚠️ 两条容易写错的地方（都是实测踩出来的）：
 * 1. **不能判断 `node.isConnected`**。编辑器（实时预览）那条链路是把块体渲染到一个
 *    **游离的 div** 里、渲染完再搬进 widget，整棵子树的 isConnected 都是 false。
 *    上一版加了这句，结果实时预览里的嵌套提示块全军覆没（阅读视图反而正常），
 *    现场证据：后处理器收到的容器 已连接=false、直接子元素=["P."]。
 * 2. **不能把 Obsidian 的块外壳从 DOM 里摘掉**。阅读视图是增量渲染的，它攥着
 *    `div.el-p` / `div.el-table` 这些外壳的引用；摘掉会让 Obsidian 内部读到
 *    null.children 并抛异常。只能清空（见 retireShell），空壳由 styles.css 的
 *    `:empty` 规则藏起来。
 */
import { App } from "obsidian";
import { isClosing, parseOpen, ParsedOpen } from "./parser";
import { DEFAULT_TITLE, ICON_PATHS } from "./parser";

const CLS = "admonition";

/**
 * 正文块的标签集合。阅读视图会把每个顶层块再包一层外壳（div.el-p …），
 * 所以不能只看 root 直接子元素的标签，否则这些块一个都搬不进框。
 */
const BLOCK_SELECTOR = "p, ul, ol, blockquote, table, pre, h1, h2, h3, h4, h5, h6";

/** 阅读开关切换后，让已打开的预览重渲染一遍（旧的 DOM 不会自己变回来） */
export function refreshPreviews(app: App): void {
  app.workspace.trigger("markdown-preview-rerender");
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    (leaf.view as { previewMode?: { rerender?: (full?: boolean) => void } }).previewMode?.rerender?.(
      true
    );
  }
}

/** 逻辑行：源码行的文本 + 承载它的 DOM 片段 */
interface LogicalLine {
  text: string;
  nodes: Node[];
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 拼接元素文本，<br> 还原为 \n；代码内部不参与（里面的 ::: 不是标记） */
function textWithBreaks(el: Element, parts: string[] = []): string {
  el.childNodes.forEach((node) => {
    if (node.nodeName === "BR") {
      parts.push("\n");
    } else if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const name = (node as Element).nodeName;
      if (name !== "CODE" && name !== "PRE") textWithBreaks(node as Element, parts);
    }
  });
  return parts.join("");
}

/** 把一个元素按 <br> 拆成逻辑行，保留原始节点以便搬移 */
function splitIntoLines(el: Element): LogicalLine[] {
  const lines: LogicalLine[] = [{ text: "", nodes: [] }];
  const last = () => lines[lines.length - 1];

  const pushText = (text: string) => {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push({ text: "", nodes: [] });
      if (!part) return;
      last().text += part;
      last().nodes.push(document.createTextNode(part));
    });
  };

  el.childNodes.forEach((node) => {
    if (node.nodeName === "BR") {
      lines.push({ text: "", nodes: [] });
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? "");
      return;
    }
    last().text += textWithBreaks(node as Element);
    last().nodes.push(node);
  });

  return lines;
}

/** 该块是不是顶层块（blockquote 里的 p、li、表格单元格里的 p 跟着外层外壳一起走） */
function isTopUnit(el: HTMLElement, root: HTMLElement): boolean {
  let p: HTMLElement | null = el.parentElement;
  while (p && p !== root) {
    if (p.matches(BLOCK_SELECTOR)) return false;
    p = p.parentElement;
  }
  return true;
}

/** 取挂在 root 下的那一层外壳（搬动时连外壳一起搬，保住 Obsidian 的布局钩子） */
function shellUnder(el: HTMLElement, root: HTMLElement): HTMLElement {
  let cur: HTMLElement = el;
  while (cur.parentElement && cur.parentElement !== root) cur = cur.parentElement;
  return cur.parentElement === root ? cur : el;
}

/** 标记行的外壳用完只清空、不摘除，理由见文件头第 2 条 */
function retireShell(shell: HTMLElement): void {
  shell.replaceChildren();
}

/* ------------------------------------------------------------------ */
/* 提示块 DOM                                                          */
/* ------------------------------------------------------------------ */

function buildBlock(open: ParsedOpen): { block: HTMLElement; contentEl: HTMLElement } {
  const block = createDiv();
  block.addClass(CLS, `${CLS}-${open.type}`);
  block.setAttr("data-admonition-type", open.type);

  const heading = block.createDiv({ cls: `${CLS}-heading` });

  if (open.collapsible) {
    block.addClass(`${CLS}-collapsible`);
    if (!open.open) block.addClass("is-collapsed");
    heading.setAttr("role", "button");
    heading.setAttr("tabindex", "0");

    const arrow = heading.createSpan({ cls: `${CLS}-arrow` });
    const arrowSvg = arrow.createSvg("svg", {
      attr: { viewBox: "0 0 24 24", width: "16", height: "16" },
    });
    arrowSvg.createSvg("path", {
      attr: { fill: "currentColor", d: "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z" },
    });
  }

  const iconWrap = heading.createDiv({ cls: `${CLS}-icon` });
  const icon = iconWrap.createSvg("svg", { attr: { viewBox: "0 0 24 24", "aria-hidden": "true" } });
  icon.createSvg("path", { attr: { d: ICON_PATHS[open.type] } });

  const headingText = heading.createDiv({ cls: `${CLS}-heading-text` });
  headingText.setText(open.title ?? DEFAULT_TITLE[open.type]);

  const contentEl = block.createDiv({ cls: `${CLS}-content` });

  if (open.collapsible) {
    const toggle = () => block.toggleClass("is-collapsed", !block.hasClass("is-collapsed"));
    heading.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      toggle();
    });
    heading.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  }

  return { block, contentEl };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export function renderAdmonitionsInSection(root: HTMLElement): void {
  const stack: HTMLElement[] = [];
  /** 当前该往哪儿放内容：最里层块的正文，没有块就是 root 本身 */
  const target = () => stack[stack.length - 1] ?? root;

  /** 放进当前框；若还没有框，就插在原位置前面（保住顺序） */
  const place = (node: Node, ref?: Element | null) => {
    const box = target();
    if (box === root) root.insertBefore(node, ref ?? null);
    else box.appendChild(node);
  };

  const snapshot = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).filter(
    (n) => isTopUnit(n, root) && !n.closest(`.${CLS}`)
  );

  for (const node of snapshot) {
    // 已经被上一步搬进某个框了（嵌套时会发生），别重复处理
    if (node.closest(`.${CLS}`)) continue;

    const shell = shellUnder(node, root);
    const ref = shell.nextElementSibling;
    const raw = textWithBreaks(node);

    // 段落里被 <br> 合并了多行源码：逐行拆，遇到标记就切容器
    if (node.tagName === "P" && raw.includes("\n")) {
      const lines = splitIntoLines(node);
      let buffer: Node[] = [];

      const flush = () => {
        if (buffer.length === 0) return;
        const p = createEl("p");
        buffer.forEach((n, i) => {
          if (i > 0) p.appendChild(createEl("br"));
          p.appendChild(n);
        });
        buffer = [];
        place(p, ref);
      };

      for (const line of lines) {
        const open = parseOpen(line.text);
        if (open) {
          flush();
          const built = buildBlock(open);
          place(built.block, ref);
          stack.push(built.contentEl);
          continue;
        }
        if (isClosing(line.text) && stack.length > 0) {
          flush();
          stack.pop();
          continue;
        }
        buffer.push(...line.nodes);
      }
      flush();
      retireShell(shell);
      continue;
    }

    const open = parseOpen(raw);
    if (open) {
      const built = buildBlock(open);
      place(built.block, ref);
      stack.push(built.contentEl);
      retireShell(shell);
      continue;
    }
    if (isClosing(raw)) {
      if (stack.length > 0) {
        stack.pop();
        retireShell(shell);
      }
      continue;
    }
    // 普通块（含表格 / 标题 / 列表 / 引用 / 代码块）：在框里就连外壳整块搬进框
    if (stack.length > 0) target().appendChild(shell);
  }
}
