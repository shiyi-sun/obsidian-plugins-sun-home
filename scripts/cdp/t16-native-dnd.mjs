import { MARK_RELOAD, READY, SHOW_EXPLORER } from "./lib.mjs";

/*
 原生文件树拖拽的回归钉子：
 - 同级文件/文件夹换位必须有落点线，松手后顺序真的变
 - 文件夹当前按名称排序时，手动拖一次应自动切成自定义顺序（与单库树同语义）
 - Files 面板被重建后，拖拽仍然有效（不能把监听留在旧 DOM 上）
 - 拖动文件夹到自己子项必须无落点，不能把文件夹搬进自己里面
*/

const SANDBOX = "__kb自测__";
const A = `${SANDBOX}/子文件夹A`;
const B = `${SANDBOX}/子文件夹B`;
const A1 = `${A}/笔记A1.md`;
const A2 = `${A}/笔记A2.md`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOTH = (p1, p2) => {
  const el = (p) =>
    document.querySelector(
      `[data-type="file-explorer"] .nav-folder-title[data-path="${p}"], [data-type="file-explorer"] .nav-file-title[data-path="${p}"]`
    );
  const e1 = el(p1);
  const e2 = el(p2);
  if (!e1 || !e2) return { a: null, b: null };
  e1.scrollIntoView({ block: "center" });
  const r1 = e1.getBoundingClientRect();
  const r2 = e2.getBoundingClientRect();
  return {
    a: { x: r1.x, y: r1.y, w: r1.width, h: r1.height },
    b: { x: r2.x, y: r2.y, w: r2.width, h: r2.height },
  };
};

const STATE = (sandboxPath, aPath) => {
  const p = window.app.plugins.plugins["sun-home"];
  const it = p.settings.order.items;
  return {
    A: { mode: it[aPath]?.sortOrder ?? null, order: it[aPath]?.customOrder ?? null },
    sandbox: {
      mode: it[sandboxPath]?.sortOrder ?? null,
      order: it[sandboxPath]?.customOrder ?? null,
    },
    rowsA: [...document.querySelectorAll(`[data-type="file-explorer"] .nav-file-title`)].map(
      (e) => e.dataset.path
    ),
  };
};

const DRAG_UI = () => {
  const p = window.app.plugins.plugins["sun-home"];
  const d = p.sortFeature.dndEngine;
  const self = (el) =>
    el?.matches?.(".tree-item") ? el.querySelector(":scope > .tree-item-self") : el;
  return {
    dragged: d.draggedItem?.path ?? null,
    sibling: self(d.dropSibling)?.dataset?.path ?? null,
    folder: self(d.dropFolder)?.dataset?.path ?? null,
    指示线: document.querySelectorAll("[data-kb-drop-sibling]").length,
    移入高亮: document.querySelectorAll("[data-kb-drop-folder]").length,
  };
};

const SET_MODE = (path, mode, order) =>
  (async () => {
    const p = window.app.plugins.plugins["sun-home"];
    p.settings.order.items[path] = {
      ...(p.settings.order.items[path] || {}),
      sortOrder: mode,
      customOrder: order,
    };
    p.sortFeature.syncRuntimeSettings();
    await p.saveSettingsNow();
    p.sortFeature.sortExplorer();
    return true;
  })();

const EXPAND = (paths) =>
  (async () => {
    const v = window.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    for (const path of paths) {
      v?.fileItems?.[path]?.setCollapsed?.(false, true);
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 500));
    return true;
  })();

async function waitReady(ctx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await ctx.page(READY);
    if (r.新文档 && r.ready && r.cards > 0) return r;
    await sleep(700);
  }
  throw new Error("超时：知识库列表/插件未就绪");
}

/** 从 src 拖到 dst 的高度比例；返回拖拽中途的落点状态 */
async function dragTo(ctx, src, dst, ratio, holdMs = 180) {
  const f = { x: Math.round(src.x + src.w / 2), y: Math.round(src.y + src.h / 2) };
  const x = Math.round(dst.x + dst.w / 2);
  const y = Math.round(dst.y + dst.h * ratio);
  await ctx.raw("mouseMoved", f.x, f.y);
  await sleep(60);
  await ctx.raw("mousePressed", f.x, f.y);
  await sleep(80);
  for (const [dx, dy] of [
    [3, 1],
    [7, 2],
    [11, 3],
    [15, 5],
    [20, 7],
  ]) {
    await ctx.raw("mouseMoved", f.x + dx, f.y + dy);
    await sleep(40);
  }
  for (let i = 1; i <= 12; i++) {
    await ctx.raw("mouseMoved", Math.round(f.x + ((x - f.x) * i) / 12), Math.round(f.y + ((y - f.y) * i) / 12));
    await sleep(35);
  }
  await ctx.raw("mouseMoved", x, y);
  await sleep(holdMs);
  const during = await ctx.page(DRAG_UI);
  await ctx.raw("mouseReleased", x, y);
  await sleep(700);
  return during;
}

export default async (ctx) => {
  const rep = {};
  const checks = [];
  const add = (n, p, d) => checks.push({ 检查: n, 结论: p ? "PASS" : "FAIL", ...(d ? { 证据: d } : {}) });
  ctx.progress.push(rep);

  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.ready = await waitReady(ctx);
  await ctx.page(SHOW_EXPLORER);
  await sleep(800);
  await ctx.page(EXPAND, [SANDBOX, A, B]);
  await sleep(600);

  // 1) 自定义顺序下的同级文件换位
  await ctx.page(SET_MODE, A, "custom", ["笔记A2.md", "笔记A1.md"]);
  await sleep(700);
  let rects = await ctx.page(BOTH, A1, A2);
  rep.自定义前 = rects;
  if (rects.a && rects.b) {
    const during = await dragTo(ctx, rects.b, rects.a, 0.2);
    const st = await ctx.page(STATE, SANDBOX, A);
    rep.自定义拖拽 = { during, A: st.A };
    add(
      "自定义顺序：拖 A1 上沿到 A2 前，有落点线且顺序变为 A1/A2",
      during.dragged === A2 && during.sibling === A1 && st.A.order?.[0] === "笔记A2.md" && st.A.order?.[1] === "笔记A1.md",
      rep.自定义拖拽
    );
  } else add("自定义顺序场景：原生树里找不到 A1/A2 行", false, rects);

  // 2) 非自定义顺序：拖一次自动切自定义
  await ctx.page(SET_MODE, A, "byNameAsc", []);
  await sleep(700);
  rects = await ctx.page(BOTH, A1, A2);
  if (rects.a && rects.b) {
    const during = await dragTo(ctx, rects.b, rects.a, 0.2);
    const st = await ctx.page(STATE, SANDBOX, A);
    rep.名称序拖拽 = { during, A: st.A };
    add(
      "名称序文件夹：手动拖 A2 到 A1 前会自动切成自定义，并写入 A2/A1",
      during.dragged === A2 && st.A.mode === "custom" && st.A.order?.[0] === "笔记A2.md" && st.A.order?.[1] === "笔记A1.md",
      rep.名称序拖拽
    );
  } else add("名称序场景：原生树里找不到 A1/A2 行", false, rects);

  // 3) 文件夹同级换位
  await ctx.page(EXPAND, [SANDBOX]);
  await sleep(500);
  rects = await ctx.page(BOTH, A, B);
  if (rects.a && rects.b) {
    const during = await dragTo(ctx, rects.b, rects.a, 0.2);
    const st = await ctx.page(STATE, SANDBOX, A);
    const ai = st.sandbox.order?.indexOf("子文件夹A") ?? -1;
    const bi = st.sandbox.order?.indexOf("子文件夹B") ?? -1;
    rep.文件夹换位 = { during, sandbox: st.sandbox };
    add("文件夹同级换位：B 拖到 A 前，落点线与顺序都正确", during.dragged === B && bi !== -1 && ai !== -1 && bi < ai, rep.文件夹换位);
  } else add("文件夹换位场景：原生树里找不到 A/B 行", false, rects);

  // 4) 拖到自己子项必须拒绝
  await ctx.page(EXPAND, [A]);
  await sleep(500);
  rects = await ctx.page(BOTH, A, A1);
  if (rects.a && rects.b) {
    const during = await dragTo(ctx, rects.a, rects.b, 0.5);
    const exists = await ctx.page((p) => !!window.app.vault.getAbstractFileByPath(p), `${A}/子文件夹A`);
    rep.自投 = { during, 嵌套不存在: !exists };
    add("把文件夹拖到自己子项：无落点、无移入高亮、不会产生自嵌套", during.sibling === null && during.folder === null && during.指示线 === 0 && during.移入高亮 === 0 && !exists, rep.自投);
  } else add("自投场景：找不到 A 或 A1 行", false, rects);

  // 5) 重建 Files 面板后仍能拖
  await ctx.page(() => {
    const ws = window.app.workspace;
    const leaf = ws.getLeavesOfType("file-explorer")[0];
    leaf.detach();
    return true;
  });
  await sleep(800);
  await ctx.page(() => {
    const ws = window.app.workspace;
    const l = ws.getLeftLeaf(false);
    l.setViewState({ type: "file-explorer", active: true });
    ws.revealLeaf(l);
    ws.setActiveLeaf(l, { focus: true });
    return true;
  });
  await sleep(1500);
  await ctx.page(EXPAND, [SANDBOX, A]);
  await sleep(700);
  rects = await ctx.page(BOTH, A1, A2);
  if (rects.a && rects.b) {
    const during = await dragTo(ctx, rects.a, rects.b, 8 / 9);
    const st = await ctx.page(STATE, SANDBOX, A);
    rep.重建后 = { during, A: st.A };
    add("重建 Files 面板后，同级拖拽仍有效（无旧 DOM 监听残留）", during.dragged === A1 && st.A.order?.[0] === "笔记A2.md" && st.A.order?.[1] === "笔记A1.md", rep.重建后);
  } else add("重建面板场景：执行后原生树里找不到 A1/A2 行", false, rects);

  await ctx.page(SET_MODE, A, "custom", ["笔记A1.md", "笔记A2.md"]);
  await ctx.page(SET_MODE, SANDBOX, "custom", ["子文件夹A", "子文件夹B", "说明.md", "根笔记1.md", "根笔记2.md", "根笔记3.md"]);
  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  rep.失败项 = checks.filter((c) => c.结论 !== "PASS");
  return rep;
};
