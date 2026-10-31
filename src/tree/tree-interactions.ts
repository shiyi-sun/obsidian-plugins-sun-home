/**
 * 单库树的选中模型与行内重命名。
 * 选中规则与原生树一致：Alt 切换、Shift 范围、单击清空；
 * 行内重命名沿用原生的 .is-being-renamed + contenteditable 结构。
 */

export class TreeSelection {
  private selected = new Set<string>();
  private anchorPath: string | null = null;

  get anchor(): string | null {
    return this.anchorPath;
  }

  get size(): number {
    return this.selected.size;
  }

  has(path: string): boolean {
    return this.selected.has(path);
  }

  values(): string[] {
    return Array.from(this.selected);
  }

  selectOnly(path: string): void {
    this.selected.clear();
    this.selected.add(path);
    this.anchorPath = path;
  }

  /** 普通单击/Ctrl 单击：不进入多选，只把锚点移到该行 */
  setAnchorOnly(path: string): void {
    this.selected.clear();
    this.anchorPath = path;
  }

  toggle(path: string): void {
    if (this.selected.has(path)) this.selected.delete(path);
    else this.selected.add(path);
    this.anchorPath = path;
  }

  selectRange(paths: string[]): void {
    this.selected = new Set(paths);
  }

  set(paths: Iterable<string>): void {
    this.selected = new Set(paths);
  }

  clear(): void {
    this.selected.clear();
    this.anchorPath = null;
  }

  /** 文件夹改名/移动后同步选中路径与锚点 */
  remapPrefix(oldPath: string, newPath: string): void {
    const map = (path: string): string =>
      path === oldPath ? newPath : path.startsWith(oldPath + "/")
        ? newPath + path.slice(oldPath.length)
        : path;

    this.selected = new Set(Array.from(this.selected, map));
    if (this.anchorPath) this.anchorPath = map(this.anchorPath);
  }

  prune(exists: (path: string) => boolean): void {
    for (const path of [...this.selected]) {
      if (!exists(path)) this.selected.delete(path);
    }
    if (this.anchorPath && !exists(this.anchorPath)) this.anchorPath = null;
  }
}

export interface InlineRenameOptions {
  /** 进入编辑时显示的文本（不含扩展名） */
  initialText: string;
  /** 返回 true 表示已提交，false 表示名称非法/重名，继续编辑 */
  commit(text: string): Promise<boolean>;
  /** 取消/提交完成后的收尾；keepFocus 表示键盘操作，应把焦点还回该行 */
  finish(keepFocus: boolean): void;
}

function selectAll(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * 在行标题上进入行内重命名，返回后不抛异常。
 * Enter 提交、Esc 取消、失焦提交；输入法组合期间不提交。
 */
export function startInlineRename(
  rowSelf: HTMLElement,
  options: InlineRenameOptions
): void {
  const inner = rowSelf.querySelector<HTMLElement>(":scope > .tree-item-inner");
  if (!inner || rowSelf.classList.contains("is-being-renamed")) return;

  const original = inner.textContent ?? options.initialText;
  let done = false;
  let busy = false;
  let composing = false;

  rowSelf.classList.add("is-being-renamed", "has-focus");
  inner.setAttribute("contenteditable", "true");
  inner.setAttribute("spellcheck", "true");
  inner.textContent = options.initialText;

  const readText = (): string =>
    (inner.textContent ?? "").replace(/\r?\n/g, " ").trim();

  const teardown = (restore?: string): void => {
    if (done) return;
    done = true;
    inner.removeEventListener("keydown", onKeyDown);
    inner.removeEventListener("blur", onBlur);
    inner.removeEventListener("compositionstart", onCompositionStart);
    inner.removeEventListener("compositionend", onCompositionEnd);
    inner.removeEventListener("paste", onPaste);
    rowSelf.classList.remove("is-being-renamed");
    inner.removeAttribute("contenteditable");
    inner.removeAttribute("spellcheck");
    if (restore !== undefined) inner.textContent = restore;
  };

  const finish = async (cancel: boolean, keepFocus: boolean): Promise<void> => {
    if (done || busy) return;
    busy = true;

    if (cancel) {
      teardown(original);
      options.finish(keepFocus);
      return;
    }

    const accepted = await options.commit(readText());
    busy = false;
    if (accepted) {
      teardown();
      options.finish(keepFocus);
      return;
    }
    // 名称非法或重名：留在编辑态，全选让用户直接改
    inner.focus();
    selectAll(inner);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      if (composing || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      void finish(false, true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finish(true, true);
    }
  };

  const onBlur = (): void => {
    if (done || busy) return;
    void finish(false, false);
  };

  const onCompositionStart = (): void => {
    composing = true;
  };

  const onCompositionEnd = (): void => {
    composing = false;
  };

  const onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    const text = (event.clipboardData?.getData("text/plain") ?? "").replace(
      /\r?\n/g,
      " "
    );
    if (!text) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    selection.deleteFromDocument();
    selection.getRangeAt(0).insertNode(document.createTextNode(text));
    selection.collapseToEnd();
  };

  inner.addEventListener("keydown", onKeyDown);
  inner.addEventListener("blur", onBlur);
  inner.addEventListener("compositionstart", onCompositionStart);
  inner.addEventListener("compositionend", onCompositionEnd);
  inner.addEventListener("paste", onPaste);

  inner.focus();
  selectAll(inner);
}
