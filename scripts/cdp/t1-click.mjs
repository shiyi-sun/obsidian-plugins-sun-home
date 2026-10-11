import { INSTALL, RESET, EVENTS, ROWS, READY, STATE, MARK_RELOAD } from "./lib.mjs";

const SANDBOX = "__kb自测__";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });

async function waitReady(ctx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await ctx.page(READY);
    if (r.新文档 && r.ready && r.cards > 0) return r;
    await sleep(700);
  }
  throw new Error("等待 Obsidian 重载后的新文档超时");
}

/** 一次点击的判定：openNote 是否发生、click 是否到达目标行、DOM 重建是否发生在 click 之前 */
function verdict(tl, path) {
  const i = (ev) => tl.findIndex((e) => e.ev === ev);
  const openAt = tl.findIndex((e) => e.ev === "openNote" && e.path === path);
  const rebuildAt = i("rebuild!");
  const clickAt = i("click");
  return {
    打开成功: openAt !== -1,
    click到达目标行: tl.some((e) => e.ev === "click" && e.rowPath === path),
    重建次数: tl.filter((e) => e.ev === "rebuild!").length,
    重建发生在click之前: rebuildAt !== -1 && clickAt !== -1 && rebuildAt < clickAt,
  };
}

export default async (ctx) => {
  const rep = { steps: [] };

  // 干净起点：标记当前文档后重载，清掉任何残留探针
  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.ready = await waitReady(ctx);

  // 真点击卡片进树
  const card = await ctx.page(
    (p) => {
      const all = [...document.querySelectorAll(".kb-card")];
      const el = all.find((c) => c.dataset.path === p);
      if (!el) return { found: false, cards: all.map((c) => c.dataset.path) };
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { found: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    },
    SANDBOX
  );
  const checks = [];
  const add = (n, pass, d) =>
    checks.push({ 检查: n, 结论: pass ? "PASS" : "FAIL", ...(d ? { 证据: d } : {}) });
  if (!card.found) {
    add("卡片墙里能找到沙箱卡片", false, card);
    rep.checks = checks;
    rep.汇总 = "0/1 PASS";
    rep.失败项 = checks;
    return { ...rep, FAIL: "卡片墙没有沙箱库", cards: card.cards };
  }
  const c = center(card.rect);
  await ctx.move(c.x, c.y);
  await sleep(80);
  await ctx.click(c.x, c.y);
  await sleep(600);

  rep.instrument = await ctx.page(INSTALL);
  if (!rep.instrument.ok) {
    add("单库树已实体化（可挂钩探针）", false, rep.instrument);
    rep.checks = checks;
    rep.汇总 = "0/1 PASS";
    rep.失败项 = checks;
    return rep;
  }

  const targets = [`${SANDBOX}/说明.md`, `${SANDBOX}/根笔记1.md`, `${SANDBOX}/子文件夹A/笔记A1.md`];
  for (const path of targets) {
    const rows = await ctx.page(ROWS);
    const row = rows.rows?.find((r) => r.path === path);
    if (!row) {
      rep.steps.push({ path, FAIL: "行未渲染", 现有: rows.rows?.map((r) => r.path) });
      continue;
    }
    await ctx.page(RESET);
    const p = center(row.rect);
    await ctx.move(p.x, p.y);
    await sleep(60);
    await ctx.click(p.x, p.y); // ← 只点一次
    await sleep(500);
    const tl = await ctx.page(EVENTS);
    const state = await ctx.page(STATE);
    rep.steps.push({
      点一次: path,
      时间线: tl.map(
        (e) =>
          `${e.ev}${e.rowPath ? "@" + e.rowPath.split("/").pop() : ""}${e.path ? "→" + String(e.path).split("/").pop() : ""}` +
          `${e.inGesture !== undefined ? `(inGesture=${e.inGesture},pending=${e.pending})` : ""}${e.type ? "(" + e.type + ")" : ""}`
      ),
      判定: verdict(tl, path),
      结果: state,
    });
  }

  for (const st of rep.steps) {
    if (st.FAIL) {
      add(`单击一次即打开 ${st.path}`, false, st);
      continue;
    }
    const pass =
      st.判定?.打开成功 &&
      st.判定.click到达目标行 &&
      !st.判定.重建发生在click之前 &&
      st.结果.activeFile === st.点一次 &&
      st.结果.高亮行.includes(st.点一次);
    add(`单击一次即打开并在树里高亮：${st.点一次}`, pass, { 判定: st.判定, 结果: st.结果 });
  }
  if (rep.steps.length !== 3) add("三步都跑到了", false, { steps: rep.steps.length });

  // ---------- 4. Ctrl 单击 / 中键 → 新标签页（原生文件树都做得到） ----------
  const modTarget = `${SANDBOX}/子文件夹A/笔记A2.md`;
  const modRow = (await ctx.page(ROWS)).rows?.find((r) => r.path === modTarget);
  if (!modRow) {
    add("笔记A2 行可见（修饰键用例的前提）", false, { 现有: (await ctx.page(ROWS)).rows?.map((r) => r.path) });
  } else {
    const leafCount = () =>
      ctx.page(() => window.app.workspace.getLeavesOfType("markdown").length);
    const closeExtra = () =>
      ctx.page((p) => {
        const ws = window.app.workspace;
        const leaves = ws.getLeavesOfType("markdown").filter((l) => l.view?.file?.path === p);
        for (const l of leaves.slice(1)) l.detach();
        return leaves.length;
      }, modTarget);
    await closeExtra();
    await sleep(300);
    const n0 = await leafCount();
    const mp = center(modRow.rect);
    await ctx.click(mp.x, mp.y, "left", 2); // Ctrl+单击
    await sleep(600);
    const n1 = await leafCount();
    add("Ctrl 单击在原标签旁边再开一个标签（同原生）", n1 === n0 + 1, { 之前: n0, 之后: n1 });
    await closeExtra();
    await sleep(300);
    const n2 = await leafCount();
    await ctx.click(mp.x, mp.y, "middle"); // 中键
    await sleep(600);
    const n3 = await leafCount();
    add("中键单击同样新开标签（同原生）", n3 === n2 + 1, { 之前: n2, 之后: n3 });
    await closeExtra();
    await sleep(300);
    const n4 = await leafCount();
    add("收尾：修饰键用例没留多余标签", n4 === n2, { 收尾: n4, 基线: n2 });
  }

  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  rep.失败项 = checks.filter((c) => c.结论 === "FAIL");
  rep.结论 =
    rep.steps.length === 3 &&
    rep.steps.every(
      (s) =>
        s.判定?.打开成功 &&
        s.判定.click到达目标行 &&
        !s.判定.重建发生在click之前 &&
        s.结果.activeFile === s.点一次 &&
        s.结果.高亮行.includes(s.点一次)
    )
      ? "PASS：三篇笔记各单击一次即打开/切换，click 之前没有 DOM 重建"
      : "FAIL：存在单击不生效或 click 前重建";
  return rep;
};
