import { READY, MARK_RELOAD, ROW_RECT, SHOW_EXPLORER } from "./lib.mjs";

/*
 单库树的拖拽实测。行结构与原生文件树一致：
   .tree-item(.nav-folder|.nav-file) > .tree-item-self[data-path]
 指示属性也与原生共用：data-kb-drop-sibling / data-kb-drop-folder / is-being-dragged。
 覆盖：同级重排、移入文件夹、跨文件夹（落在别处条目上/下沿＝移到那个文件夹）、
       拖回库根、撞名自动避让、悬停折叠文件夹自动展开、拖完单击仍一次生效。
*/

const SANDBOX = "__kb自测__";
const A = `${SANDBOX}/子文件夹A`;
const B = `${SANDBOX}/子文件夹B`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });

async function waitReady(ctx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await ctx.page(READY);
    if (r.新文档 && r.ready && r.cards > 0) return r;
    await sleep(700);
  }
  throw new Error("超时");
}

const RECORDER = () => {
  window.__dnd = { events: [], over: 0 };
  for (const t of ["dragstart", "dragenter", "dragover", "dragleave", "drop", "dragend"]) {
    document.addEventListener(
      t,
      (e) => {
        const row = e.target?.closest?.(".tree-item-self") || e.target?.closest?.(".kb-card");
        const path = row?.dataset?.path ?? null;
        if (t === "dragover") {
          window.__dnd.over++;
          return;
        }
        if (t === "dragenter" && window.__dnd.events.some((x) => x.ev === "dragenter" && x.path === path))
          return;
        window.__dnd.events.push({ ev: t, path });
      },
      true
    );
  }
  return true;
};

const TREE = () => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  const p = window.app.plugins.plugins["sun-home"];
  const items = p.settings.order.items;
  return {
    // 顺序与原生树共用一份存储：order.items[文件夹] 的 sortOrder / customOrder
    库排序: items["__kb自测__"]?.sortOrder ?? null,
    库顺序: items["__kb自测__"]?.customOrder ?? null,
    A排序: items["__kb自测__/子文件夹A"]?.sortOrder ?? null,
    B排序: items["__kb自测__/子文件夹B"]?.sortOrder ?? null,
    B顺序: items["__kb自测__/子文件夹B"]?.customOrder ?? null,
    collapsed: view ? [...view.collapsed] : null,
    order: view
      ? [...view.containerEl.querySelectorAll(".kb-tree-body .tree-item")].map(
          (el) => el.querySelector(":scope > .tree-item-self")?.dataset?.path ?? null
        )
      : [],
    指示线: [
      ...document.querySelectorAll(
        ".kb-tree-body [data-kb-drop-sibling], .kb-tree-body [data-kb-drop-folder]"
      ),
    ].map((e) => {
      const path =
        e.dataset.path ?? e.querySelector(":scope > .tree-item-self")?.dataset?.path ?? "?";
      return `${path}=${e.dataset.kbDropSibling ?? "folder"}`;
    }),
    被拖行: [...document.querySelectorAll(".kb-tree-body .is-being-dragged")].map((e) => e.dataset.path),
    body类: document.body.classList.contains("kb-dragging"),
    原生结构: {
      文件夹行: document.querySelectorAll(".kb-tree-body .nav-folder-title.mod-collapsible").length,
      文件行: document.querySelectorAll(".kb-tree-body .nav-file-title").length,
      箭头: document.querySelectorAll(".kb-tree-body .collapse-icon svg.svg-icon").length,
      嵌套层: document.querySelectorAll(".kb-tree-body .nav-folder-children").length,
      靠padding缩进的行: [
        ...document.querySelectorAll(".kb-tree-body .tree-item"),
      ].filter((el) => el.style.paddingLeft).length,
    },
  };
};

const RECT = ROW_RECT;

/** 库根标题行的矩形（把它当作「移回库根」的放置目标） */
const ROOT_RECT = () => {
  const el = document.querySelector(".kb-tree-title[data-path]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

/** 从 src 行拖到 dst 行的指定高度比例（0=最上沿，0.5=中间，1=最下沿） */
async function dragTo(ctx, srcRect, dstRect, ratio, holdMs = 120) {
  const f = center(srcRect);
  const y = Math.round(dstRect.y + dstRect.h * ratio);
  const x = Math.round(dstRect.x + dstRect.w / 2);
  await ctx.raw("mouseMoved", f.x, f.y);
  await sleep(50);
  await ctx.raw("mousePressed", f.x, f.y);
  await sleep(70);
  for (const [dx, dy] of [
    [3, 1],
    [6, 2],
    [9, 3],
    [12, 4],
    [15, 5],
  ]) {
    await ctx.raw("mouseMoved", f.x + dx, f.y + dy);
    await sleep(35);
  }
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await ctx.raw(
      "mouseMoved",
      Math.round(f.x + (x - f.x) * (i / steps)),
      Math.round(f.y + (y - f.y) * (i / steps))
    );
    await sleep(30);
  }
  await ctx.raw("mouseMoved", x, y);
  await sleep(holdMs);
  const 落点前 = await ctx.page(TREE);
  await ctx.raw("mouseReleased", x, y);
  await sleep(500);
  return 落点前;
}

/** 复位：把沙箱库（含子文件夹）的排序方式统一设成名称升序，与原生树共用同一份设置 */
const RESET_STATE = (box) =>
  (async () => {
    const p = window.app.plugins.plugins["sun-home"];
    const v = window.app.workspace.getLeavesOfType("kb-tree-view")[0].view;
    v.collapsed.clear();
    // 直接走真实入口（TS 的 private 在运行时不拦），不再另设测试专用钩子
    v.applySortOrder(window.app.vault.getAbstractFileByPath(box), "byNameAsc");
    await p.saveSettingsNow();
    return true;
  })();

const MOVE = (from, to) =>
  (async () => {
    const f = window.app.vault.getAbstractFileByPath(from);
    if (!f) return { ok: false, reason: "源不存在" };
    await window.app.fileManager.renameFile(f, to);
    return { ok: true };
  })();

const EXISTS = (p) => !!window.app.vault.getAbstractFileByPath(p);

export default async (ctx) => {
  const rep = {};
  const checks = [];
  const add = (n, p, d) => checks.push({ 检查: n, 结论: p ? "PASS" : "FAIL", ...(d ? { 证据: d } : {}) });
  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      add(`${label}（脚本异常）`, false, String(e.message).slice(0, 200));
      return null;
    }
  };

  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.ready = await waitReady(ctx);
  const card = await ctx.page((p) => {
    const el = [...document.querySelectorAll(".kb-card")].find((c) => c.dataset.path === p);
    el?.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, SANDBOX);
  await ctx.click(center(card).x, center(card).y);
  await sleep(500);
  await ctx.page(RECORDER);
  await ctx.page(RESET_STATE, SANDBOX);
  await sleep(250);

  const base = await ctx.page(TREE);
  rep.基线顺序 = base.order.map((o) => o?.split("/").pop());
  add(
    "基线：本库排序方式 = 名称升序（写在和原生树同一份的 order.items 里）",
    base.库排序 === "byNameAsc",
    { 库排序: base.库排序 }
  );
  // 片B：行 DOM 必须是原生那套（缩进靠嵌套，不是自绘 paddingLeft）
  add(
    "树行复用原生结构（原生类名齐、没有靠 paddingLeft 自绘缩进）",
    base.原生结构.文件夹行 === 2 &&
      base.原生结构.文件行 === 7 &&
      base.原生结构.箭头 === 2 &&
      base.原生结构.嵌套层 === 2 &&
      base.原生结构.靠padding缩进的行 === 0,
    base.原生结构
  );

  // ---------- 1. 拖到目标上沿 = 排到其前 ----------
  await safe("阶段1", async () => {
    await ctx.page(() => ((window.__dnd.events = []), true));
    const src = await ctx.page(RECT, `${SANDBOX}/根笔记3.md`);
    const dst = await ctx.page(RECT, `${SANDBOX}/根笔记1.md`);
    rep.拖1_落点前 = await dragTo(ctx, src, dst, 0.12);
    rep.拖1_事件 = await ctx.page(() => window.__dnd.events.slice());
    const after = await ctx.page(TREE);
    rep.拖1_之后 = {
      order: after.order.map((o) => o?.split("/").pop()),
      库排序: after.库排序,
      库顺序: after.库顺序,
    };
    const evs = rep.拖1_事件.map((e) => e.ev);
    add(
      "拖拽事件链完整：dragstart/dragover/drop/dragend 都触发",
      ["dragstart", "drop", "dragend"].every((x) => evs.includes(x)) &&
        (await ctx.page(() => window.__dnd.over)) > 0,
      { 事件: rep.拖1_事件, dragover: await ctx.page(() => window.__dnd.over) }
    );
    add(
      "拖到目标上沿：出现 before 指示线，且真落到目标之前",
      rep.拖1_落点前.指示线.some((s) => s.endsWith("=before")) &&
        after.order.indexOf(`${SANDBOX}/根笔记3.md`) < after.order.indexOf(`${SANDBOX}/根笔记1.md`),
      { 指示线: rep.拖1_落点前.指示线, 之后顺序: rep.拖1_之后.order }
    );
    add(
      "被拖行有 is-being-dragged、body 有 kb-dragging",
      rep.拖1_落点前.被拖行.includes(`${SANDBOX}/根笔记3.md`) && rep.拖1_落点前.body类,
      { 被拖行: rep.拖1_落点前.被拖行, body类: rep.拖1_落点前.body类 }
    );
    add(
      "同层重排：该文件夹切到自定义顺序，并把新位置写进 order.items[库].customOrder",
      after.库排序 === "custom" &&
        Array.isArray(after.库顺序) &&
        after.库顺序.indexOf("根笔记3.md") < after.库顺序.indexOf("根笔记1.md"),
      { 库排序: after.库排序, 库顺序: after.库顺序 }
    );
    add("拖完 body 上的拖拽类被摘掉（不残留 user-select 等状态）", (await ctx.page(TREE)).body类 === false);
  });

  // ---------- 2. 拖到目标下沿 = 排到其后 ----------
  await safe("阶段2", async () => {
    await ctx.page(() => ((window.__dnd.events = []), true));
    const src = await ctx.page(RECT, `${SANDBOX}/说明.md`);
    const dst = await ctx.page(RECT, `${SANDBOX}/根笔记1.md`);
    rep.拖2_落点前 = await dragTo(ctx, src, dst, 0.88);
    const after = await ctx.page(TREE);
    rep.拖2_之后 = after.order.map((o) => o?.split("/").pop());
    add(
      "拖到目标下沿：after 指示线，且排到目标之后",
      rep.拖2_落点前.指示线.some((s) => s.endsWith("=after")) &&
        after.order.indexOf(`${SANDBOX}/说明.md`) === after.order.indexOf(`${SANDBOX}/根笔记1.md`) + 1,
      { 指示线: rep.拖2_落点前.指示线, 之后顺序: rep.拖2_之后 }
    );
  });

  // ---------- 3. 拖到文件夹中部 = 真实移入 ----------
  await safe("阶段3", async () => {
    await ctx.page(() => ((window.__dnd.events = []), true));
    const src = await ctx.page(RECT, `${SANDBOX}/根笔记2.md`);
    const dst = await ctx.page(RECT, B);
    rep.拖3_落点前 = await dragTo(ctx, src, dst, 0.5);
    const existsNew = await ctx.page(EXISTS, `${B}/根笔记2.md`);
    const existsOld = await ctx.page(EXISTS, `${SANDBOX}/根笔记2.md`);
    const tree = await ctx.page(TREE);
    rep.拖3 = {
      指示线: rep.拖3_落点前.指示线,
      新位置: existsNew,
      原位还在: existsOld,
      order: tree.order.map((o) => o?.split("/").pop()),
    };
    add("拖到文件夹中部：移入指示", rep.拖3_落点前.指示线.some((s) => s.endsWith("=folder")), rep.拖3_落点前.指示线);
    add(
      "拖到文件夹中部=磁盘上真实移动（原位消失、新位出现）",
      existsNew === true && existsOld === false,
      { 新位置: existsNew, 原位还在: existsOld }
    );
    await ctx.page(MOVE, `${B}/根笔记2.md`, `${SANDBOX}/根笔记2.md`);
    await sleep(400);
    add(
      "阶段3 已还原",
      (await ctx.page(EXISTS, `${SANDBOX}/根笔记2.md`)) === true &&
        (await ctx.page(EXISTS, `${B}/根笔记2.md`)) === false
    );
  });

  // ---------- 4. 跨文件夹：落在别处的条目上/下沿 = 移进那个文件夹 ----------
  await safe("阶段4跨文件夹", async () => {
    await ctx.page(RESET_STATE, SANDBOX);
    await sleep(250);
    const src = await ctx.page(RECT, `${A}/笔记A1.md`);
    const dst = await ctx.page(RECT, `${B}/笔记B1.md`);
    rep.拖4_落点前 = await dragTo(ctx, src, dst, 0.12);
    const inB = await ctx.page(EXISTS, `${B}/笔记A1.md`);
    const inA = await ctx.page(EXISTS, `${A}/笔记A1.md`);
    const after = await ctx.page(TREE);
    rep.拖4 = {
      指示线: rep.拖4_落点前.指示线,
      到B: inB,
      还在A: inA,
      B排序: after.B排序,
      库排序: after.库排序,
      B的顺序: after.B顺序,
    };
    add(
      "跨文件夹拖拽不再被拒：落在 B 内条目的上沿 → 文件真的进了 B",
      inB === true && inA === false,
      rep.拖4
    );
    add(
      "跨文件夹是「移动」：只改被移动项的归属，不把源文件夹切成自定义顺序",
      after.库排序 === "byNameAsc",
      { 库排序: after.库排序, B排序: after.B排序 }
    );
    add(
      "目标文件夹里记住了落位（写进 order.items[B].customOrder）",
      Array.isArray(after.B顺序) &&
        after.B顺序.indexOf("笔记A1.md") <= Math.max(0, after.B顺序.indexOf("笔记B1.md")),
      { B的顺序: after.B顺序, B排序: after.B排序 }
    );
    await ctx.page(MOVE, `${B}/笔记A1.md`, `${A}/笔记A1.md`);
    await sleep(400);
    await ctx.page(RESET_STATE, SANDBOX);
    add(
      "阶段4 已还原",
      (await ctx.page(EXISTS, `${A}/笔记A1.md`)) === true && (await ctx.page(EXISTS, `${B}/笔记A1.md`)) === false
    );
  });

  // ---------- 4b. 跨文件夹：落点位置必须被兑现，而不是停在队首 ----------
  // 阶段4 的断言写成 indexOf(被拖项) <= indexOf(落点项)，条目落到索引 0 时同样成立，
  // 所以「永远排到目标文件夹最上面」这个毛病它抓不到。这里用「下沿」把两者分开：
  // 期望 = 拖拽前屏幕上 B 的次序、把被拖项插到落点项之后；落到队首就不可能相等。
  const READ_FOLDER_ROWS = (p) =>
    [...document.querySelectorAll(".kb-tree-body .tree-item-self")]
      .map((el) => el.dataset?.path ?? "")
      .filter((x) => x.startsWith(`${p}/`))
      .map((x) => x.slice(p.length + 1));
  await safe("阶段4b跨文件夹落点", async () => {
    await ctx.page(async (p) => {
      if (!window.app.vault.getAbstractFileByPath(p)) await window.app.vault.create(p, "# B2\n");
      return true;
    }, `${B}/笔记B2.md`);
    await sleep(400);
    // 源和目标都先归到名称升序：这样「按名称排在最前」和「按落点排在 B1 之后」不会巧合重合
    await ctx.page((box, b) => {
      const v = window.app.workspace.getLeavesOfType("kb-tree-view")[0].view;
      v.applySortOrder(window.app.vault.getAbstractFileByPath(box), "byNameAsc");
      v.applySortOrder(window.app.vault.getAbstractFileByPath(b), "byNameAsc");
      return window.app.plugins.plugins["sun-home"].saveSettingsNow();
    }, SANDBOX, B);
    await sleep(300);

    const 基线B = await ctx.page(READ_FOLDER_ROWS, B);
    const 插入后 = (list, mover, afterName) => {
      const i = list.indexOf(afterName);
      return [...list.slice(0, i + 1), mover, ...list.slice(i + 1).filter((n) => n !== mover)];
    };
    const 期望 = 插入后(基线B, "笔记A2.md", "笔记B1.md");

    const src = await ctx.page(RECT, `${A}/笔记A2.md`);
    const dst = await ctx.page(RECT, `${B}/笔记B1.md`);
    rep.拖4b_落点前 = await dragTo(ctx, src, dst, 0.88);
    const 屏幕B = await ctx.page(READ_FOLDER_ROWS, B);
    const after = await ctx.page(TREE);
    const bOrder = after.B顺序 ?? [];
    rep.拖4b = {
      指示线: rep.拖4b_落点前.指示线,
      基线B,
      期望,
      屏幕B,
      B顺序: bOrder,
      B排序: after.B排序,
      进了B: await ctx.page(EXISTS, `${B}/笔记A2.md`),
      还在A: await ctx.page(EXISTS, `${A}/笔记A2.md`),
    };
    add(
      "跨文件夹拖到下沿：屏幕上就排在落点条目之后（不是最上面）",
      基线B.length >= 2 && JSON.stringify(屏幕B) === JSON.stringify(期望),
      { 基线B, 期望, 屏幕B, B排序: after.B排序 }
    );
    add(
      "落点写进了目标文件夹的 customOrder，且该文件夹转为自定义顺序（否则显示不认这个位置）",
      bOrder.indexOf("笔记A2.md") === bOrder.indexOf("笔记B1.md") + 1 && after.B排序 === "custom",
      { B顺序: bOrder, B排序: after.B排序 }
    );
    add("文件确实移动了（原位没了、新位在）", rep.拖4b.进了B === true && rep.拖4b.还在A === false, rep.拖4b);

    await ctx.page(MOVE, `${B}/笔记A2.md`, `${A}/笔记A2.md`);
    await sleep(400);
    await ctx.page(async (p) => {
      const f = window.app.vault.getAbstractFileByPath(p);
      if (f) await window.app.vault.trash(f, true);
      return true;
    }, `${B}/笔记B2.md`);
    await sleep(300);
    await ctx.page(RESET_STATE, SANDBOX);
    add(
      "阶段4b 已还原",
      (await ctx.page(EXISTS, `${A}/笔记A2.md`)) === true &&
        (await ctx.page(EXISTS, `${B}/笔记A2.md`)) === false &&
        (await ctx.page(EXISTS, `${B}/笔记B2.md`)) === false
    );
  });

  // ---------- 5. 拖回库根（库根标题行是放置目标） ----------
  await safe("阶段5拖回库根", async () => {
    const src = await ctx.page(RECT, `${A}/笔记A2.md`);
    const dst = await ctx.page(ROOT_RECT);
    rep.拖5_落点前 = await dragTo(ctx, src, dst, 0.5);
    const atRoot = await ctx.page(EXISTS, `${SANDBOX}/笔记A2.md`);
    const stillInA = await ctx.page(EXISTS, `${A}/笔记A2.md`);
    rep.拖5 = { 有库根放置目标: !!dst, 指示: rep.拖5_落点前.指示线, 回到库根: atRoot, 还在A: stillInA };
    add(
      "子文件夹里的笔记可以拖回库根（原生能做，这里不能更差）",
      atRoot === true && stillInA === false,
      rep.拖5
    );
    await ctx.page(MOVE, `${SANDBOX}/笔记A2.md`, `${A}/笔记A2.md`);
    await sleep(400);
    add("阶段5 已还原", (await ctx.page(EXISTS, `${A}/笔记A2.md`)) === true);
    await ctx.page(RESET_STATE, SANDBOX);
  });

  // ---------- 6. 撞名自动避让（原生做法），而不是拒绝这次移动 ----------
  await safe("阶段6撞名", async () => {
    // 先在 B 里立一个同名靶子
    await ctx.page(async (p) => {
      if (!window.app.vault.getAbstractFileByPath(p)) await window.app.vault.create(p, "# 撞名靶子\n");
      return true;
    }, `${B}/笔记A2.md`);
    await sleep(300);
    const src = await ctx.page(RECT, `${A}/笔记A2.md`);
    const dst = await ctx.page(RECT, B);
    rep.拖6_落点前 = await dragTo(ctx, src, dst, 0.5);
    const listing = await ctx.page((p) => {
      const f = window.app.vault.getAbstractFileByPath(p);
      return f ? f.children.map((c) => c.name) : null;
    }, B);
    rep.拖6 = { B目录内容: listing };
    const clone = (listing ?? []).find((n) => n !== "笔记A2.md" && n.startsWith("笔记A2"));
    add(
      "目标已有同名文件时自动改名避让（拖拽不白做）",
      Array.isArray(listing) && listing.includes("笔记A2.md") && !!clone,
      rep.拖6
    );
    // 收摊：删掉靶子，把避让出来的那份放回 A
    await ctx.page(async (box, movedName) => {
      const dup = window.app.vault.getAbstractFileByPath(`${box}/笔记A2.md`);
      if (dup) await window.app.vault.trash(dup, true);
      const mine = window.app.vault.getAbstractFileByPath(`${box}/${movedName}`);
      if (mine)
        await window.app.fileManager.renameFile(mine, "__kb自测__/子文件夹A/笔记A2.md");
      return true;
    }, B, clone);
    await sleep(400);
    await ctx.page(RESET_STATE, SANDBOX);
    add(
      "阶段6 已还原",
      (await ctx.page(EXISTS, `${A}/笔记A2.md`)) === true &&
        (await ctx.page(EXISTS, `${B}/笔记A2.md`)) === false &&
        (await ctx.page(EXISTS, `${B}/${clone}`)) === false,
      { clone }
    );
  });

  // ---------- 7. 悬停在折叠文件夹上会自动展开（拖拽不被打断） ----------
  await safe("阶段7悬停展开", async () => {
    await ctx.page((p) => {
      const v = window.app.workspace.getLeavesOfType("kb-tree-view")[0].view;
      v.collapsed.add(p);
      v.render();
      return true;
    }, A);
    await sleep(250);
    const src = await ctx.page(RECT, `${SANDBOX}/根笔记1.md`);
    const dst = await ctx.page(RECT, A);
    const f = center(src);
    const target = center(dst);
    await ctx.raw("mouseMoved", f.x, f.y);
    await sleep(60);
    await ctx.raw("mousePressed", f.x, f.y);
    await sleep(80);
    // 起步要一步一步挪：跳得太快 Chromium 迟迟判不出这是拖拽，
    // 悬停计时会被拖到后面才起跑（第一版就因此误判成「功能没生效」）
    for (const [dx, dy] of [
      [3, 1],
      [6, 2],
      [9, 3],
      [12, 4],
    ]) {
      await ctx.raw("mouseMoved", f.x + dx, f.y + dy);
      await sleep(30);
    }
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await ctx.raw(
        "mouseMoved",
        Math.round(f.x + (target.x - f.x) * (i / steps)),
        Math.round(f.y + (target.y - f.y) * (i / steps))
      );
      await sleep(30);
    }
    await ctx.raw("mouseMoved", target.x, target.y);
    await sleep(300);
    const 展开前 = await ctx.page((p) => ({
      collapsed: [...window.app.workspace.getLeavesOfType("kb-tree-view")[0].view.collapsed],
      行在不在: !!document.querySelector(`.kb-tree-body .tree-item-self[data-path="${p}/笔记A1.md"]`),
      body类: document.body.classList.contains("kb-dragging"),
    }), A);
    await sleep(1500);
    const 悬停后 = await ctx.page((p) => ({
      collapsed: [...window.app.workspace.getLeavesOfType("kb-tree-view")[0].view.collapsed],
      行在不在: !!document.querySelector(`.kb-tree-body .tree-item-self[data-path="${p}/笔记A1.md"]`),
      仍在拖: document.body.classList.contains("kb-dragging"),
      源还被举着: document.querySelectorAll(".kb-tree-body .is-being-dragged").length,
    }), A);
    rep.悬停展开 = { 展开前, 悬停后 };
    add(
      "停在折叠文件夹上一秒 → 就地展开，且拖拽仍然活着",
      展开前.行在不在 === false && 悬停后.行在不在 === true && 悬停后.仍在拖 === true,
      rep.悬停展开
    );
    // 松手放回原位（拖到刚展开的 A 里 → 移入，然后还原）
    await ctx.raw("mouseReleased", target.x, target.y);
    await sleep(600);
    const moved = await ctx.page(EXISTS, `${A}/根笔记1.md`);
    if (moved) await ctx.page(MOVE, `${A}/根笔记1.md`, `${SANDBOX}/根笔记1.md`);
    await sleep(400);
    await ctx.page(RESET_STATE, SANDBOX);
    add(
      "阶段7 收尾：拖拽态清干净、文件回到原位",
      (await ctx.page(EXISTS, `${SANDBOX}/根笔记1.md`)) === true &&
        (await ctx.page(TREE)).body类 === false,
      { 拖进了A: moved }
    );
  });

  // ---------- 8. 拖拽之后单击仍一次生效（与手势保护共存） ----------
  await safe("阶段8", async () => {
    const r = await ctx.page(RECT, `${SANDBOX}/根笔记3.md`);
    const p = center(r);
    await ctx.click(p.x, p.y);
    await sleep(450);
    const st = await ctx.page(() => ({
      active: window.app.workspace.getActiveFile()?.path ?? null,
      高亮: [...document.querySelectorAll(".kb-tree-body .nav-file-title.is-active")].map((e) => e.dataset.path),
    }));
    add("拖拽之后单击笔记仍一次即打开", st.active === `${SANDBOX}/根笔记3.md`, st);
  });

  // ---------- 8.5 一份顺序、两处生效：单库树里排完，原生树就是同一个顺序 ----------
  await safe("阶段8.5同一份存储", async () => {
    const 手排 = ["说明.md", "子文件夹B", "根笔记1.md", "根笔记2.md", "根笔记3.md", "子文件夹A"];
    await ctx.page((box, order) => {
      const p = window.app.plugins.plugins["sun-home"];
      const f = p.settings.order.items[box];
      f.customOrder = order;
      f.sortOrder = "custom";
      p.sortFeature.sortExplorer();
      window.app.workspace.getLeavesOfType("kb-tree-view")[0].view.render();
      return p.saveSettingsNow();
    }, SANDBOX, 手排);
    await sleep(500);
    const 树里 = await ctx.page((box) => {
      const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0].view;
      return [...view.containerEl.querySelectorAll(".kb-tree-body > .tree-item")].map(
        (el) => el.querySelector(":scope > .tree-item-self")?.dataset?.path?.split("/").pop() ?? ""
      );
    }, SANDBOX);
    rep.同一份存储 = { 手排, 单库树: 树里 };
    add("单库树按共享的 customOrder 显示", JSON.stringify(树里) === JSON.stringify(手排), rep.同一份存储);
    // 切到原生文件浏览器，量它渲染出来的同一层
    await ctx.page(SHOW_EXPLORER);
    await sleep(700);
    await ctx.page((box) => {
      const t = document.querySelector(`[data-type="file-explorer"] .nav-folder-title[data-path="${box}"]`);
      const box2 = t?.closest(".nav-folder");
      if (box2?.classList.contains("is-collapsed")) t.click();
      return true;
    }, SANDBOX);
    await sleep(600);
    const 原生里 = await ctx.page((box) => {
      const t = document.querySelector(`[data-type="file-explorer"] .nav-folder-title[data-path="${box}"]`);
      const kids = t?.closest(".nav-folder")?.querySelector(":scope > .nav-folder-children");
      if (!kids) return null;
      return [...kids.children]
        .filter((el) => el.classList.contains("tree-item"))
        .map((el) => el.querySelector(":scope > .tree-item-self")?.dataset?.path?.split("/").pop() ?? "");
    }, SANDBOX);
    rep.同一份存储.原生树 = 原生里;
    add(
      "原生文件浏览器同步显示同一顺序（真的只有一份数据）",
      JSON.stringify(原生里) === JSON.stringify(手排),
      rep.同一份存储
    );
    // 左栏同一时刻只渲染一个面板：后面还要量单库树，得把它切回前台
    await ctx.page(() => {
      const ws = window.app.workspace;
      const leaf = ws.getLeavesOfType("kb-tree-view")[0];
      if (ws.leftSplit?.collapsed) ws.leftSplit.expand();
      ws.revealLeaf(leaf);
      ws.setActiveLeaf(leaf, { focus: false });
      return true;
    });
    await sleep(600);
  });

  // ---------- 9. 沙箱顺序痕迹清除 ----------
  await safe("清理", async () => {
    await ctx.page(RESET_STATE, SANDBOX);
    await sleep(250);
    rep.清理后 = await ctx.page((box) => {
      const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0].view;
      // 只比顶层：子文件夹里的条目在 .nav-folder-children 里，不参与这一层排序
      const 屏幕 = [...view.containerEl.querySelectorAll(".kb-tree-body > .tree-item")].map(
        (el) => el.querySelector(":scope > .tree-item-self")?.dataset?.path?.split("/").pop() ?? ""
      );
      const 库 = window.app.vault.getAbstractFileByPath(box);
      const 是夹 = (c) => !!c.children;
      const 期望 = [...库.children]
        .filter((c) => 是夹(c) || c.extension === "md")
        .sort((a, b) => {
          if (是夹(a) !== 是夹(b)) return 是夹(a) ? -1 : 1;
          return a.name.localeCompare(b.name, "zh");
        })
        .map((c) => c.name);
      return {
        库排序: window.app.plugins.plugins["sun-home"].settings.order.items[box]?.sortOrder ?? null,
        屏幕顺序: 屏幕,
        期望,
      };
    }, SANDBOX);
    add(
      "复位生效：排序方式回到名称升序，屏幕顺序与「文件夹在前 + 名称升序」一致",
      rep.清理后.库排序 === "byNameAsc" &&
        JSON.stringify(rep.清理后.屏幕顺序) === JSON.stringify(rep.清理后.期望),
      rep.清理后
    );
  });

  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  rep.失败项 = checks.filter((c) => c.结论 === "FAIL");
  return rep;
};
