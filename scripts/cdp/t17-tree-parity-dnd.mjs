import { MARK_RELOAD } from "./lib.mjs";
import {
  SANDBOX,
  FOLDER_A,
  FOLDER_B,
  ROOT_A,
  ROOT_B,
  ROOT_C,
  A1,
  A2,
  waitReady,
  ensureSandbox,
  INSTALL_DRAG_IMAGE_PROBE,
  showTree,
  openKb,
  ensureExpanded,
  rowRect,
  treeRect,
  blankPoint,
  dragProbe,
  dragCommit,
  dropState,
  readOrder,
  readSettings,
  setMode,
  resetSandboxOrders,
  moveFile,
  restoreByName,
  exists,
  cleanupSandbox,
  snapshot,
  summarize,
  sleep,
} from "./tree-contract.mjs";

/*
 P0：两棵树拖拽对等基线。

 原生树是基准，必须 PASS；单库树当前未统一的地方记 PENDING，
 这些 PENDING 就是 P2 的验收清单，失败不是测试脚本故障。

 关键检测点：
 - 文件夹行 30/40/30（用 0.27 和 0.73 区分原生与当前单库的 25/50/25）
 - 文件行 50/50
 - 2px 行距、树内空白/右侧留白
 - 库根空白（单库树当前是库名标题落点，不是树内空白）
 - 移入文件夹落到末尾
 - 非自定义排序拖一次后切 custom
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

function folderZone(state, folderPath) {
  const row = state?.rows?.find((r) => r.path === folderPath);
  return row?.side ?? null;
}

function siblingSide(state, rowPath) {
  const row = state?.rows?.find((r) => r.path === rowPath);
  return row?.side ?? null;
}

function hasIndicator(state) {
  return (state?.指示线 ?? 0) + (state?.移入高亮 ?? 0) > 0;
}

/** 单棵树跑一遍场景；返回原始观察，期望判定在下面统一做 */
async function runSuite(ctx, tree) {
  const out = { tree };
  await resetSandboxOrders(ctx);
  await showTree(ctx, tree);
  await ensureExpanded(ctx, tree, [SANDBOX, FOLDER_A, FOLDER_B]);
  out.snapshot = await snapshot(ctx, tree);

  const srcC = await rowRect(ctx, tree, ROOT_C);
  const folderB = await rowRect(ctx, tree, FOLDER_B);
  const fileB = await rowRect(ctx, tree, ROOT_B);
  const srcA = await rowRect(ctx, tree, ROOT_A);

  out.rects = { srcC, folderB, fileB, srcA };

  // 文件夹：0.27 应该 before（原生 30%），0.73 应该 after（原生 30%）
  out.folderBefore27 = null;
  out.folderInside50 = null;
  out.folderAfter73 = null;
  if (srcC && folderB) {
    out.folderBefore27 = await dragProbe(ctx, tree, srcC, folderB, 0.27);
    out.folderInside50 = await dragProbe(ctx, tree, srcC, folderB, 0.5);
    out.folderAfter73 = await dragProbe(ctx, tree, srcC, folderB, 0.73);
  }

  // 文件：0.2 before / 0.8 after
  out.fileBefore20 = null;
  out.fileAfter80 = null;
  if (srcC && fileB) {
    out.fileBefore20 = await dragProbe(ctx, tree, srcC, fileB, 0.2);
    out.fileAfter80 = await dragProbe(ctx, tree, srcC, fileB, 0.8);
  }

  // 2px 行距：拿 A 和 B 的缝隙当落点
  out.gap = null;
  if (srcA && fileB) {
    const gapRect = {
      x: fileB.x,
      y: Math.round(srcA.y + srcA.h + 1),
      w: fileB.w,
      h: 2,
    };
    out.gap = await dragProbe(ctx, tree, srcC, gapRect, 0.5);
  }

  // 树内右侧留白：避开滚动条，取容器右边内 14px
  const tr = await treeRect(ctx, tree);
  out.padding = null;
  if (srcC && tr) {
    const padRect = {
      x: Math.round(tr.x + tr.w - 14),
      y: Math.round(tr.y + 20),
      w: 1,
      h: 1,
    };
    out.padding = await dragProbe(ctx, tree, srcC, padRect, 0.5);
  }

  // 移入文件夹：先把 B 调成明确的 B2/B1，再拖 C 进 B 正中
  out.insideAppend = null;
  if (srcC && folderB) {
    await setMode(ctx, FOLDER_B, "custom", ["笔记B2.md", "笔记B1.md"]);
    await ensureExpanded(ctx, tree, [FOLDER_B]);
    const freshFolderB = await rowRect(ctx, tree, FOLDER_B);
    const freshSrcC = await rowRect(ctx, tree, ROOT_C);
    if (freshFolderB && freshSrcC) {
      const during = await dragCommit(ctx, tree, freshSrcC, freshFolderB, 0.5);
      const inB = await exists(ctx, `${FOLDER_B}/根笔记C.md`);
      const atRoot = await exists(ctx, ROOT_C);
      const bOrder = await readOrder(ctx, tree, FOLDER_B);
      out.insideAppend = { during, inB, atRoot, bOrder };
      if (inB) await moveFile(ctx, `${FOLDER_B}/根笔记C.md`, ROOT_C);
      await resetSandboxOrders(ctx);
      await ensureExpanded(ctx, tree, [FOLDER_B]);
    }
  }

  // 树内空白：把 A1 拖回库根。
  // 这条在原生树里作用域根 = vault 根，在单库树里作用域根 = 当前库。
  // 取末行下方的空白，避免“右侧留白”落进首行文件夹的区域。
  out.rootBlank = null;
  {
    const freshA1 = await rowRect(ctx, tree, A1);
    const blank = await blankPoint(ctx, tree);
    if (freshA1 && blank) {
      const during = await dragCommit(ctx, tree, freshA1, blank, 0.5);
      const atRoot = await exists(ctx, `${SANDBOX}/笔记A1.md`);
      const stillA = await exists(ctx, A1);
      const restored = await restoreByName(ctx, SANDBOX, "笔记A1.md", A1);
      out.rootBlank = { during, atRoot, stillA, blank, restored };
      await resetSandboxOrders(ctx);
      await ensureExpanded(ctx, tree, [FOLDER_A]);
    }
  }

  // 非自定义顺序：拖一次应切成 custom 并兑现落点
  out.nonCustom = null;
  {
    await setMode(ctx, FOLDER_A, "byNameAsc", []);
    const freshA1 = await rowRect(ctx, tree, A1);
    const freshA2 = await rowRect(ctx, tree, A2);
    if (freshA1 && freshA2) {
      const during = await dragCommit(ctx, tree, freshA2, freshA1, 0.2);
      const settings = await readSettings(ctx, FOLDER_A);
      const order = await readOrder(ctx, tree, FOLDER_A);
      out.nonCustom = { during, settings, order };
      await resetSandboxOrders(ctx);
    }
  }

  out.afterProbeC = {
    atRoot: await exists(ctx, ROOT_C),
    inB: await exists(ctx, `${FOLDER_B}/根笔记C.md`),
  };
  return out;
}

function zonePass(state, folderPath, side) {
  return folderZone(state, folderPath) === side;
}

export default async (ctx) => {
  const checks = [];
  REP.ready = null;
  REP.native = null;
  REP.kb = null;

  try {
    await ctx.page(MARK_RELOAD);
    await ctx.reloadApp();
    REP.ready = await waitReady(ctx);
    REP.sandbox = await ensureSandbox(ctx);
    await ctx.page(INSTALL_DRAG_IMAGE_PROBE);

    // 原生基准
    REP.native = await runSuite(ctx, "native");
    const n = REP.native;
    const nSnap = n.snapshot;
    const nRoot = nSnap.rows.find((r) => r.path === ROOT_A);
    const nDeep = nSnap.rows.find((r) => r.path === A1);
    add(
      checks,
      "原生基准：行高 24–26px、2px 行距、每层内容缩进 17px",
      !!nRoot &&
        !!nDeep &&
        nRoot.rect.h >= 24 &&
        nRoot.rect.h <= 26 &&
        nRoot.marginBottom === "2px" &&
        nDeep.contentX - nRoot.contentX === 17,
      { root: nRoot, deep: nDeep, 说明: "原生树里沙箱本身是一层，所以沙箱子项是 41/58px；相对作用域内每层 17px" }
    );
    add(checks, "原生基准：文件夹 0.27 落在 before 区", zonePass(n.folderBefore27, FOLDER_B, "before"), n.folderBefore27);
    add(checks, "原生基准：文件夹 0.5 落在 inside 区", zonePass(n.folderInside50, FOLDER_B, "folder"), n.folderInside50);
    add(checks, "原生基准：文件夹 0.73 落在 after 区", zonePass(n.folderAfter73, FOLDER_B, "after"), n.folderAfter73);
    add(checks, "原生基准：文件 0.2 落在 before", siblingSide(n.fileBefore20, ROOT_B) === "before", n.fileBefore20);
    add(checks, "原生基准：文件 0.8 落在 after", siblingSide(n.fileAfter80, ROOT_B) === "after", n.fileAfter80);
    add(checks, "原生基准：2px 缝隙有落点", hasIndicator(n.gap), n.gap);
    add(checks, "原生基准：右侧留白有落点", hasIndicator(n.padding), n.padding);
    add(
      checks,
      "原生基准：拖入文件夹落到末尾",
      n.insideAppend?.inB === true &&
        n.insideAppend?.atRoot === false &&
        n.insideAppend?.bOrder?.at(-1) === `${FOLDER_B}/根笔记C.md`,
      n.insideAppend
    );
    add(
      checks,
      "原生基准：树内空白把 A1 移回库根",
      n.rootBlank?.atRoot === true && n.rootBlank?.stillA === false,
      n.rootBlank
    );
    add(
      checks,
      "原生基准：名称序拖一次切 custom 并写入落点",
      n.nonCustom?.settings?.sortOrder === "custom" &&
        n.nonCustom?.settings?.customOrder?.[0] === "笔记A2.md" &&
        n.nonCustom?.order?.[0] === A2,
      n.nonCustom
    );
    add(
      checks,
      "原生基准：探针拖拽没有留下移动",
      n.afterProbeC?.atRoot === true && n.afterProbeC?.inB === false,
      n.afterProbeC
    );

    // 单库树
    await openKb(ctx, SANDBOX);
    REP.kb = await runSuite(ctx, "kb");
    const k = REP.kb;

    pending(checks, "文件夹 0.27 before / 0.5 inside / 0.73 after", true, zonePass(k.folderBefore27, FOLDER_B, "before") && zonePass(k.folderInside50, FOLDER_B, "folder") && zonePass(k.folderAfter73, FOLDER_B, "after"), {
      before27: k.folderBefore27,
      inside50: k.folderInside50,
      after73: k.folderAfter73,
    }, "当前单库树是 25/50/25，0.27/0.73 会落到 inside");
    pending(checks, "文件 0.2 before / 0.8 after", true, siblingSide(k.fileBefore20, ROOT_B) === "before" && siblingSide(k.fileAfter80, ROOT_B) === "after", {
      before20: k.fileBefore20,
      after80: k.fileAfter80,
    });
    pending(checks, "2px 缝隙有落点", true, hasIndicator(k.gap), k.gap, "当前单库树只匹配行本体，缝隙没有落点");
    pending(checks, "树内右侧留白有落点", true, hasIndicator(k.padding), k.padding, "当前单库树只匹配行本体，右侧留白没有落点");
    pending(
      checks,
      "移入文件夹落到末尾",
      true,
      k.insideAppend?.inB === true && k.insideAppend?.atRoot === false && k.insideAppend?.bOrder?.at(-1) === `${FOLDER_B}/根笔记C.md`,
      k.insideAppend,
      "当前 OrderManager.move 在 inside 时从索引 0 开始，落到最前"
    );
    pending(
      checks,
      "树内空白把 A1 移回库根",
      true,
      k.rootBlank?.atRoot === true && k.rootBlank?.stillA === false,
      k.rootBlank,
      "当前单库树以库名标题为落点，树内空白没有落点"
    );
    pending(
      checks,
      "名称序拖一次切 custom 并写入落点",
      true,
      k.nonCustom?.settings?.sortOrder === "custom" &&
        k.nonCustom?.settings?.customOrder?.[0] === "笔记A2.md" &&
        k.nonCustom?.order?.[0] === A2,
      k.nonCustom
    );
    pending(checks, "拖拽之后没有残留移动", true, k.afterProbeC?.atRoot === true && k.afterProbeC?.inB === false, k.afterProbeC);

    const dragImageSamples = [n.folderBefore27, n.fileAfter80, k.folderBefore27, k.fileAfter80];
    add(
      checks,
      "两棵树拖拽都抑制浏览器默认快照（setDragImage 为 1×1 透明图）",
      dragImageSamples.every((s) => (s?.dragImages || []).some((d) => d.w === 1 && d.h === 1)),
      {
        native: n.folderBefore27?.dragImages,
        nativeFile: n.fileAfter80?.dragImages,
        kb: k.folderBefore27?.dragImages,
        kbFile: k.fileAfter80?.dragImages,
      }
    );

    // 单库树几何基准（P3 要统一的部分）
    // 两棵树所在面板的左边距不同，几何比较必须先减去各自容器 x，不能直接比绝对坐标。
    const kRoot = k.snapshot.rows.find((r) => r.path === ROOT_A);
    const kDeep = k.snapshot.rows.find((r) => r.path === A1);
    const nBase = nSnap.containerRect?.x ?? 0;
    const kBase = k.snapshot.containerRect?.x ?? 0;
    const expectedRootX = nRoot?.contentX - nBase - 17;
    const expectedDeepX = nDeep?.contentX - nBase - 17;
    const nativeRowX = nRoot?.rect.x - nBase;
    const kbRootX = kRoot ? kRoot.contentX - kBase : null;
    const kbDeepX = kDeep ? kDeep.contentX - kBase : null;
    pending(
      checks,
      "行几何与原生一致（容器归一化后：内容左移 17px、行起点与原生一致）",
      true,
      !!kRoot &&
        !!kDeep &&
        Number.isFinite(expectedRootX) &&
        Number.isFinite(expectedDeepX) &&
        Math.abs(kRoot.rect.h - nRoot.rect.h) <= 1 &&
        kRoot.marginBottom === "2px" &&
        Math.abs(kbRootX - expectedRootX) <= 1 &&
        Math.abs(kbDeepX - expectedDeepX) <= 1 &&
        Math.abs(kRoot.rect.x - kBase - nativeRowX) <= 1 &&
        Math.abs(kDeep.rect.x - kBase - nativeRowX) <= 1,
      {
        root: kRoot,
        deep: kDeep,
        nativeRoot: nRoot,
        nativeDeep: nDeep,
        expectedRootX,
        expectedDeepX,
        kbRootX,
        kbDeepX,
        nativeRowX,
        kbRowX: kRoot ? kRoot.rect.x - kBase : null,
        kbDeepRowX: kDeep ? kDeep.rect.x - kBase : null,
      },
      "行内 padding 24/41px 与负 margin 未生效，内容或行起点与原生不一致"
    );
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
  REP.原生 = REP.native;
  REP.单库 = REP.kb;
  REP.说明 = "原生基准必须 PASS；PENDING 是单库树待统一项，不是脚本故障。";
  return REP;
};
