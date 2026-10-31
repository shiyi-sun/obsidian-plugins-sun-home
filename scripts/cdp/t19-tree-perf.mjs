import {
  PERF_SANDBOX,
  waitReady,
  showTree,
  createPerfSandbox,
  cleanupSandbox,
  expandNativeMeasure,
  rowCounts,
  scrollBottom,
  scrollMid,
  measureOpenKb,
  summarize,
  sleep,
} from "./tree-contract.mjs";

/*
 P0：性能基线。

 默认 10,000 条，可用环境变量缩短：
   KB_PERF_COUNT=300 node scripts/cdp/run.mjs scripts/cdp/t19-tree-perf.mjs

 原生树用 Obsidian 自己的虚拟列表；单库树当前还是全量渲染。
 原生 DOM 行数受视口限制必须 PASS；单库行数/打开耗时在 P3 虚拟化后
 才会变成 PASS，当前记 PENDING。
*/

const COUNT = Math.max(1, Number(process.env.KB_PERF_COUNT || 10000) || 10000);
const DOM_BUDGET = 200;

const REP = { 条目数: COUNT };

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

const CLOSE_KB_TREE = () => {
  for (const leaf of [...window.app.workspace.getLeavesOfType("kb-tree-view")]) leaf.detach();
  return true;
};

export default async (ctx) => {
  const checks = [];
  try {
    await waitReady(ctx);
    // 造数前必须关掉单库树：否则每批 vault.create 都会触发它重绘，
    // 10k 造数会被拖到十分钟以上（P0 实测踩过）。
    await ctx.page(CLOSE_KB_TREE);
    await sleep(300);
    // 上一轮若留下性能沙箱，先清掉，保证测量对象干净
    await cleanupSandbox(ctx, PERF_SANDBOX);
    REP.创建开始 = new Date().toISOString();
    const t0 = Date.now();
    REP.沙箱 = await createPerfSandbox(ctx, COUNT);
    REP.创建耗时ms = Date.now() - t0;

    await showTree(ctx, "native");
    await sleep(500);
    REP.原生展开 = await expandNativeMeasure(ctx, PERF_SANDBOX);
    REP.原生顶部 = await rowCounts(ctx, "native");
    REP.原生底部 = await scrollBottom(ctx, "native");

    add(
      checks,
      "原生基准：顶部只渲染视口附近的行",
      (REP.原生顶部.totalRows ?? 0) > 0 && (REP.原生顶部.totalRows ?? 0) <= DOM_BUDGET,
      REP.原生顶部
    );
    // 实测说明：原生 1.14.4 在“直接跳到底部”时也会保留大量行
    // （300 条时 48 行，10k 时 9984 行），不是任何位置都只留视口。
    // 这里只把它记录成单库不劣化的基线，不把“底部 <=200”当原生承诺。
    add(
      checks,
      "原生基准：跳到底部后的行数已记录（原生也会渲染大量行）",
      (REP.原生底部.totalRows ?? 0) > (REP.原生顶部.totalRows ?? 0),
      REP.原生底部
    );

    REP.单库打开 = await measureOpenKb(ctx, PERF_SANDBOX);
    await sleep(400);
    REP.单库顶部 = await rowCounts(ctx, "kb");
    if (REP.单库顶部.err) {
      REP.单库打开 = { ...REP.单库打开, err: REP.单库顶部.err };
    } else {
      REP.单库中部 = await scrollMid(ctx, "kb");
      REP.单库底部 = await scrollBottom(ctx, "kb");
    }

    const singleTopRows = REP.单库顶部.totalRows ?? 0;
    const singleMidRows = REP.单库中部?.totalRows ?? 0;
    const singleBottomRows = REP.单库底部?.totalRows ?? 0;
    const nativeTopRows = REP.原生顶部.totalRows ?? 0;
    const nativeBottomRows = REP.原生底部.totalRows ?? 0;
    const nativeExpandMs = REP.原生展开.ms ?? 0;
    const singleOpenMs = REP.单库打开.ms ?? 0;

    pending(
      checks,
      "单库树顶部只渲染视口附近的行",
      (nativeTopRows > 0 && nativeTopRows <= DOM_BUDGET),
      singleTopRows > 0 && singleTopRows <= DOM_BUDGET,
      { rows: singleTopRows, nativeRows: nativeTopRows, budget: DOM_BUDGET, open: REP.单库打开, counts: REP.单库顶部 },
      "当前单库树全量递归渲染，DOM 行数随条目数增长"
    );
    pending(
      checks,
      "单库树常规滚动只渲染视口附近的行",
      nativeTopRows > 0 && nativeTopRows <= DOM_BUDGET,
      singleMidRows > 0 && singleMidRows <= DOM_BUDGET,
      { rows: singleMidRows, nativeRows: nativeTopRows, budget: DOM_BUDGET, counts: REP.单库中部 },
      "当前单库树全量递归渲染，DOM 行数随条目数增长"
    );
    pending(
      checks,
      "单库树滚到底部不劣于原生同场景",
      nativeBottomRows > 0,
      singleBottomRows > 0 && singleBottomRows <= nativeBottomRows + 200,
      { rows: singleBottomRows, nativeRows: nativeBottomRows, counts: REP.单库底部, native: REP.原生底部 },
      "当前单库树没有虚拟列表；原生跳到底部时本身也会保留大量行，P3 以不劣化为底线"
    );
    pending(
      checks,
      "单库打开耗时在原生同场景同一数量级",
      true,
      REP.单库打开.found === true && singleOpenMs <= Math.max(nativeExpandMs * 2 + 300, 800),
      { nativeExpandMs, singleOpenMs, threshold: Math.max(nativeExpandMs * 2 + 300, 800) },
      "当前单库树打开时全量建 DOM，耗时会明显高于原生虚拟列表"
    );

    REP.说明 =
      "PENDING 是 P3 虚拟化要消除的基线差异；这里保留原始数字，不用绝对值承诺最终性能。";
  } catch (err) {
    add(checks, "P0 执行未抛异常", false, String(err?.stack || err).split("\n").slice(0, 6).join(" | "));
  } finally {
    try {
      await ctx.page(CLOSE_KB_TREE);
      await sleep(200);
      await cleanupSandbox(ctx, PERF_SANDBOX);
    } catch (err) {
      add(checks, "清理性能沙箱", false, String(err?.message || err));
    }
  }

  Object.assign(REP, summarize(checks));
  return REP;
};
