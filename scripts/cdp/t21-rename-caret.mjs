import { MARK_RELOAD } from "./lib.mjs";
import {
  SANDBOX,
  ROOT_A,
  FOLDER_A,
  waitReady,
  ensureSandbox,
  showTree,
  openKb,
  ensureExpanded,
  cleanupSandbox,
  sleep,
} from "./tree-contract.mjs";

/*
 行内重命名的鼠标定位：点击标题内某个字符应只移动光标，
 不能触发行的选中/打开（那会把焦点抢回行上，输入框随即失焦退出编辑）。
 文件行与文件夹行走同一条点击链路，各测一次。
*/

const MENU_ITEMS = () => {
  const menus = [...document.querySelectorAll(".menu")];
  const m = menus[menus.length - 1];
  if (!m) return [];
  return [...m.querySelectorAll(".menu-item")].map((el) => {
    const titleEl = el.querySelector(".menu-item-title") ?? el;
    const r = titleEl.getBoundingClientRect();
    return {
      text: (el.querySelector(".menu-item-title")?.textContent ?? el.textContent ?? "").trim(),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  });
};

const ROW_RECT = (path) => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  const el = view?.containerEl.querySelector(
    `.kb-tree-body .tree-item-self[data-path="${path}"]`
  );
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

const RENAME_STATE = () => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  const row = view?.containerEl.querySelector(".kb-tree-body .is-being-renamed");
  const inner = row?.querySelector(".tree-item-inner");
  const sel = window.getSelection();
  return {
    renaming: !!row,
    rowPath: row?.dataset?.path ?? null,
    editable: inner?.getAttribute("contenteditable") ?? null,
    focusedEditable: document.activeElement === inner,
    activeTag: document.activeElement?.className?.toString?.().split(" ")[0] ?? null,
    selectedText: row ? (sel?.toString() ?? "") : null,
    anchorOffset: sel?.anchorNode && row ? sel.anchorOffset : null,
    text: inner?.textContent ?? null,
  };
};

const CARET_POINT = (path, offset) => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  const inner = view?.containerEl.querySelector(
    `.kb-tree-body .tree-item-self[data-path="${path}"] .tree-item-inner`
  );
  const node = inner?.firstChild;
  if (!node) return null;
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(offset + 1, node.length));
  const r = range.getBoundingClientRect();
  return {
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
    charRect: { x: r.x, y: r.y, w: r.width, h: r.height },
  };
};

const EXISTS = (p) => !!window.app.vault.getAbstractFileByPath(p);

async function startRename(ctx, path) {
  const rr = await ctx.page(ROW_RECT, path);
  if (!rr) return { ok: false, reason: "找不到行" };
  await ctx.click(Math.round(rr.x + rr.w / 2), Math.round(rr.y + rr.h / 2), "right");
  await sleep(420);
  const items = await ctx.page(MENU_ITEMS);
  const item = items.find((i) => i.text === "重命名");
  if (!item) return { ok: false, reason: "菜单里没有重命名", items: items.map((i) => i.text) };
  await ctx.click(Math.round(item.rect.x + item.rect.w / 2), Math.round(item.rect.y + item.rect.h / 2));
  await sleep(350);
  return { ok: true };
}

export default async (ctx) => {
  const checks = [];
  const add = (name, pass, evidence) =>
    checks.push({ 检查: name, 结论: pass ? "PASS" : "FAIL", 证据: evidence });

  try {
    await ctx.page(MARK_RELOAD);
    await ctx.reloadApp();
    await waitReady(ctx);
    await ensureSandbox(ctx);
    await showTree(ctx, "kb");
    await openKb(ctx, SANDBOX);
    await ensureExpanded(ctx, "kb", [SANDBOX, FOLDER_A]);

    const fileCase = await startRename(ctx, ROOT_A);
    const before = await ctx.page(RENAME_STATE);
    add(
      "文件：右键重命名进入编辑态，初始全选",
      fileCase.ok && before.renaming && before.editable === "true" && before.selectedText === "根笔记A",
      { fileCase, before }
    );

    const cp = await ctx.page(CARET_POINT, ROOT_A, 2);
    await ctx.move(cp.x, cp.y);
    await sleep(60);
    await ctx.click(cp.x, cp.y);
    await sleep(300);
    const after = await ctx.page(RENAME_STATE);
    add(
      "文件：点击标题内某字符后仍在编辑并保持焦点",
      after.renaming && after.editable === "true" && after.focusedEditable,
      { click: cp, after }
    );
    add(
      "文件：点击定位光标而非选中整行",
      after.renaming && after.selectedText === "" && (after.anchorOffset === 2 || after.anchorOffset === 3),
      { after }
    );

    const expectedOffset = after.anchorOffset ?? 0;
    await ctx.type("X");
    await sleep(200);
    const typed = await ctx.page(RENAME_STATE);
    const expectedText = "根笔记A".slice(0, expectedOffset) + "X" + "根笔记A".slice(expectedOffset);
    add("文件：在点击位置插入字符", typed.renaming && typed.text === expectedText, {
      expectedText,
      typed,
    });

    await ctx.key("Escape", "Escape", 27);
    await sleep(300);
    const cancel = await ctx.page(RENAME_STATE);
    const stillOld = await ctx.page(EXISTS, ROOT_A);
    add("文件：Esc 取消后恢复原名", !cancel.renaming && stillOld === true, { cancel, stillOld });

    const folderCase = await startRename(ctx, FOLDER_A);
    const fBefore = await ctx.page(RENAME_STATE);
    add(
      "文件夹：右键重命名进入编辑态",
      folderCase.ok && fBefore.renaming && fBefore.rowPath === FOLDER_A,
      { folderCase, fBefore }
    );
    const fcp = await ctx.page(CARET_POINT, FOLDER_A, 1);
    await ctx.move(fcp.x, fcp.y);
    await sleep(60);
    await ctx.click(fcp.x, fcp.y);
    await sleep(300);
    const fAfter = await ctx.page(RENAME_STATE);
    add(
      "文件夹：点击标题定位光标，不退出编辑",
      fAfter.renaming &&
        fAfter.focusedEditable &&
        fAfter.selectedText === "" &&
        (fAfter.anchorOffset === 1 || fAfter.anchorOffset === 2),
      { click: fcp, after: fAfter }
    );
    await ctx.key("Escape", "Escape", 27);
    await sleep(300);
  } catch (err) {
    add("用例执行未抛异常", false, String(err?.stack || err).split("\n").slice(0, 6).join(" | "));
  } finally {
    try {
      await cleanupSandbox(ctx, SANDBOX);
    } catch (err) {
      add("清理测试沙箱", false, String(err?.message || err));
    }
  }

  return {
    checks,
    汇总: `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`,
    失败项: checks.filter((c) => c.结论 === "FAIL"),
  };
};
