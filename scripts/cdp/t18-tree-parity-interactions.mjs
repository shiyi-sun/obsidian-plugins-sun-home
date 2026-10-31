import { MARK_RELOAD } from "./lib.mjs";
import {
  SANDBOX,
  FOLDER_A,
  FOLDER_B,
  ROOT_A,
  ROOT_B,
  ROOT_C,
  ATTACHMENT,
  waitReady,
  ensureSandbox,
  showTree,
  openKb,
  ensureExpanded,
  snapshot,
  clickRow,
  selection,
  collectMenu,
  focusRow,
  cleanupSandbox,
  summarize,
  sleep,
} from "./tree-contract.mjs";

/*
 P0：两棵树交互对等基线。

 原生树是基准，必须 PASS；单库树当前未统一的地方记 PENDING。
 覆盖：
 - 附件/非 md 是否显示
 - 单击/Alt 多选/Shift 范围选中/Ctrl 新标签
 - 文件与文件夹右键菜单的核心项
 - F2 行内重命名
 - 单库树是否还有“全库排序”入口（统一后应移除）
*/

const REP = {};

function add(checks, name, pass, evidence) {
  checks.push({ 检查: name, 结论: pass ? "PASS" : "FAIL", 证据: evidence });
}

function pending(checks, name, nativePass, singlePass, evidence, reason) {
  if (nativePass !== true) {
    add(checks, `${name}（原生基准）`, false, evidence);
    return;
  }
  checks.push({
    检查: name,
    结论: singlePass ? "PASS" : "PENDING",
    证据: evidence,
    说明: singlePass ? undefined : reason || "单库树尚未统一",
  });
}

function titles(menu) {
  return (menu?.items ?? []).map((i) => i.title);
}

function hasAll(menu, wanted) {
  const got = titles(menu);
  return wanted.every((t) => got.includes(t));
}

const CORE_FILE_MENU = [
  "在新标签页中打开",
  "创建副本",
  "将文件移动到…",
  "复制路径",
  "在系统资源管理器中显示",
  "置顶",
  "隐藏",
  "重命名",
  "删除",
];

const CORE_FOLDER_MENU = [
  "新建笔记",
  "新建文件夹",
  "创建副本",
  "将文件夹移动到…",
  "在文件夹中查找",
  "排序方式",
  "重命名",
  "删除",
  "在系统资源管理器中显示",
  "复制路径",
  "置顶",
  "隐藏",
];

const FOCUS_STATE = () => {
  const view = window.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
  return {
    activeDom: view?.tree?.activeDom?.file?.path ?? view?.tree?.activeDom?.el?.dataset?.path ?? null,
    focused: view?.tree?.focusedItem?.file?.path ?? null,
    activeElement: document.activeElement?.dataset?.path ?? null,
    rename: !!document.querySelector(".is-being-renamed"),
  };
};

const TOOLBAR_SORT = () => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  return {
    exists: !!view?.containerEl?.querySelector('.kb-tree-toolbar [aria-label="排序方式"]'),
    labels: [...(view?.containerEl?.querySelectorAll(".kb-tree-toolbar .nav-action-button") ?? [])].map(
      (el) => el.getAttribute("aria-label")
    ),
  };
};

async function runNative(ctx, checks) {
  await showTree(ctx, "native");
  await ensureExpanded(ctx, "native", [SANDBOX, FOLDER_A, FOLDER_B]);
  const snap = await snapshot(ctx, "native");
  REP.nativeSnapshot = snap;
  const att = snap.rows.find((r) => r.path === ATTACHMENT);
  add(checks, "原生基准：附件/非 md 行可见", !!att && (att.text ?? "").includes("附件"), { att, rows: snap.rows.map((r) => r.path) });

  await clickRow(ctx, "native", ROOT_A);
  const one = await selection(ctx, "native");
  REP.nativeClick = one;
  add(checks, "原生基准：单击打开并只保留 is-active", one.active.includes(ROOT_A) && one.selected.length === 0, one);

  await clickRow(ctx, "native", ROOT_B, 1);
  const alt = await selection(ctx, "native");
  REP.nativeAlt = alt;
  add(checks, "原生基准：Alt+单击选中 B 且不打开", alt.selected.includes(ROOT_B), alt);

  await clickRow(ctx, "native", ROOT_C, 8);
  const shift = await selection(ctx, "native");
  REP.nativeShift = shift;
  add(
    checks,
    "原生基准：Shift+单击从 B 范围选到 C",
    shift.selected.includes(ROOT_B) && shift.selected.includes(ROOT_C),
    shift
  );

  const beforeLeaves = shift.markdownLeaves;
  await clickRow(ctx, "native", ROOT_A, 2);
  const ctrl = await selection(ctx, "native");
  REP.nativeCtrl = { beforeLeaves, after: ctrl };
  add(
    checks,
    "原生基准：Ctrl+单击打开新标签页",
    ctrl.markdownLeaves === beforeLeaves + 1,
    { beforeLeaves, afterLeaves: ctrl.markdownLeaves, selected: ctrl.selected }
  );

  await clickRow(ctx, "native", ROOT_A);
  const fileMenu = await collectMenu(ctx, "native", ROOT_A);
  REP.nativeFileMenu = fileMenu;
  add(checks, "原生基准：文件右键菜单包含完整核心项", hasAll(fileMenu, CORE_FILE_MENU), { got: titles(fileMenu), wanted: CORE_FILE_MENU });

  const folderMenu = await collectMenu(ctx, "native", FOLDER_A);
  REP.nativeFolderMenu = folderMenu;
  add(checks, "原生基准：文件夹右键菜单包含新建/排序/置顶/隐藏", hasAll(folderMenu, CORE_FOLDER_MENU), { got: titles(folderMenu), wanted: CORE_FOLDER_MENU });
  await clickRow(ctx, "native", ROOT_A);
  REP.nativeFocusBefore = await ctx.page(FOCUS_STATE);
  await focusRow(ctx, "native", ROOT_A);
  await ctx.key("F2", "F2", 113);
  await sleep(350);
  REP.nativeF2 = await ctx.page(FOCUS_STATE);
  await ctx.key("Escape", "Escape", 27);
  await sleep(200);
  REP.nativeF2After = await ctx.page(FOCUS_STATE);
  add(
    checks,
    "原生基准：F2 进入行内重命名，Esc 退出",
    REP.nativeF2.rename === true && REP.nativeF2After.rename === false,
    { before: REP.nativeFocusBefore, f2: REP.nativeF2, after: REP.nativeF2After }
  );

  await focusRow(ctx, "native", ROOT_A);
  REP.nativeFocusA = await ctx.page(FOCUS_STATE);
  await ctx.key("ArrowDown", "ArrowDown", 40);
  await sleep(250);
  REP.nativeArrowDown = await ctx.page(FOCUS_STATE);
  add(
    checks,
    "原生基准：方向键移动焦点",
    REP.nativeArrowDown.activeDom !== REP.nativeFocusA.activeDom ||
      REP.nativeArrowDown.focused !== REP.nativeFocusA.focused ||
      REP.nativeArrowDown.activeElement !== REP.nativeFocusA.activeElement,
    { before: REP.nativeFocusA, after: REP.nativeArrowDown }
  );

  return snap;
}

async function runKb(ctx, checks, nativeSnapshot, nativeFileMenu, nativeFolderMenu) {
  await openKb(ctx, SANDBOX);
  await showTree(ctx, "kb");
  await ensureExpanded(ctx, "kb", [SANDBOX, FOLDER_A, FOLDER_B]);
  const snap = await snapshot(ctx, "kb");
  REP.kbSnapshot = snap;
  const att = snap.rows.find((r) => r.path === ATTACHMENT);
  pending(
    checks,
    "附件/非 md 显示",
    true,
    !!att && (att.text ?? "").includes("附件"),
    { att, rows: snap.rows.map((r) => r.path) },
    "当前单库树只渲染文件夹和 .md，附件被过滤"
  );

  await clickRow(ctx, "kb", ROOT_A);
  const one = await selection(ctx, "kb");
  REP.kbClick = one;
  add(checks, "单库树：单击打开并高亮", one.active.includes(ROOT_A), one);

  await clickRow(ctx, "kb", ROOT_B, 1);
  const alt = await selection(ctx, "kb");
  REP.kbAlt = alt;
  pending(checks, "Alt+单击选中且不打开", true, alt.selected.includes(ROOT_B), alt, "当前单库树没有 Alt 多选，Alt 点击会按普通点击处理");

  await clickRow(ctx, "kb", ROOT_C, 8);
  const shift = await selection(ctx, "kb");
  REP.kbShift = shift;
  pending(
    checks,
    "Shift+单击范围选中",
    true,
    shift.selected.includes(ROOT_B) && shift.selected.includes(ROOT_C),
    shift,
    "当前单库树没有 Shift 范围选中"
  );

  const beforeLeaves = shift.markdownLeaves;
  await clickRow(ctx, "kb", ROOT_A, 2);
  const ctrl = await selection(ctx, "kb");
  REP.kbCtrl = { beforeLeaves, after: ctrl };
  pending(
    checks,
    "Ctrl+单击打开新标签页",
    true,
    ctrl.markdownLeaves === beforeLeaves + 1,
    { beforeLeaves, afterLeaves: ctrl.markdownLeaves, selected: ctrl.selected },
    "Ctrl 分支已存在，但需和其它点击语义一起复核"
  );

  await clickRow(ctx, "kb", ROOT_A);
  const fileMenu = await collectMenu(ctx, "kb", ROOT_A);
  REP.kbFileMenu = fileMenu;
  pending(
    checks,
    "文件右键菜单包含完整核心项",
    hasAll(nativeFileMenu, CORE_FILE_MENU),
    hasAll(fileMenu, CORE_FILE_MENU),
    { native: titles(nativeFileMenu), kb: titles(fileMenu), wanted: CORE_FILE_MENU },
    "当前单库树是简化菜单，缺创建副本/移动到/新标签组等核心项"
  );
  add(
    checks,
    "文件右键菜单标题与顺序和原生完全一致",
    JSON.stringify(titles(fileMenu)) === JSON.stringify(titles(nativeFileMenu)),
    { native: titles(nativeFileMenu), kb: titles(fileMenu) }
  );

  const folderMenu = await collectMenu(ctx, "kb", FOLDER_A);
  REP.kbFolderMenu = folderMenu;
  pending(
    checks,
    "文件夹右键菜单包含新建/排序/置顶/隐藏",
    hasAll(nativeFolderMenu, CORE_FOLDER_MENU),
    hasAll(folderMenu, CORE_FOLDER_MENU),
    { native: titles(nativeFolderMenu), kb: titles(folderMenu), wanted: CORE_FOLDER_MENU },
    "当前单库树菜单项较少"
  );
  add(
    checks,
    "文件夹右键菜单标题与顺序和原生完全一致",
    JSON.stringify(titles(folderMenu)) === JSON.stringify(titles(nativeFolderMenu)),
    { native: titles(nativeFolderMenu), kb: titles(folderMenu) }
  );

  await clickRow(ctx, "kb", ROOT_A);
  await focusRow(ctx, "kb", ROOT_A);
  await ctx.key("F2", "F2", 113);
  await sleep(350);
  REP.kbF2 = await ctx.page(FOCUS_STATE);
  await ctx.key("Escape", "Escape", 27);
  await sleep(200);
  REP.kbF2After = await ctx.page(FOCUS_STATE);
  pending(
    checks,
    "F2 行内重命名",
    true,
    REP.kbF2.rename === true && REP.kbF2After.rename === false,
    { f2: REP.kbF2, after: REP.kbF2After },
    "当前单库树重命名走弹窗，不是行内编辑"
  );

  const toolbar = await ctx.page(TOOLBAR_SORT);
  REP.kbToolbarSort = toolbar;
  pending(
    checks,
    "单库树不再有全库排序入口",
    true,
    toolbar.exists === false,
    toolbar,
    "当前单库树工具条仍有“排序方式”，且会一次改整个库"
  );

  // 给后续 P4 留原始数据：当前单库树的附件行确实不存在
  REP.kbAttachmentMissing = !att;
  REP.nativeAttachment = nativeSnapshot.rows.find((r) => r.path === ATTACHMENT);
}

export default async (ctx) => {
  const checks = [];
  try {
    await ctx.page(MARK_RELOAD);
    await ctx.reloadApp();
    REP.ready = await waitReady(ctx);
    REP.sandbox = await ensureSandbox(ctx);

    const nativeSnapshot = await runNative(ctx, checks);
    await runKb(ctx, checks, nativeSnapshot, REP.nativeFileMenu, REP.nativeFolderMenu);
  } catch (err) {
    add(checks, "P0 执行未抛异常", false, String(err?.stack || err).split("\n").slice(0, 6).join(" | "));
  } finally {
    try {
      await cleanupSandbox(ctx, SANDBOX);
    } catch (err) {
      add(checks, "清理测试沙箱", false, String(err?.message || err));
    }
  }

  Object.assign(REP, summarize(checks));
  REP.说明 = "原生基准必须 PASS；PENDING 是单库树待统一项，不是脚本故障。";
  return REP;
};
