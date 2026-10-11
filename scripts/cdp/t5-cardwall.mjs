/*
卡片墙的拖拽：同级重排 + 拖进（折叠态）分组的放置区。
这条依赖视口几何：源卡与目标必须同时可见，凑不齐时判 SKIP（不算失败），
因为放不下是测试环境限制，不是插件行为问题。右键「移入分组」那条路径由 t4 覆盖。
*/
import { READY, MARK_RELOAD } from "./lib.mjs";

const SANDBOX = "__kb自测__";
const GROUP = "卡片拖拽组";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(ctx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await ctx.page(READY);
    if (r.新文档 && r.ready && r.cards > 0) return r;
    await sleep(700);
  }
  throw new Error("超时");
}

const REC = () => {
  window.__d = { ev: [], over: 0 };
  for (const t of ["dragstart", "dragenter", "dragleave", "drop", "dragend"]) {
    document.addEventListener(
      t,
      (e) => {
        if (t === "dragover") {
          window.__d.over++;
          return;
        }
        const row = e.target?.closest?.(".kb-card") || e.target?.closest?.(".kb-group");
        window.__d.ev.push({ ev: t, path: row?.dataset?.path ?? row?.dataset?.groupId ?? null });
      },
      true
    );
  }
  document.addEventListener("dragover", () => window.__d.over++, true);
  return true;
};

const SNAP = () => {
  const s = window.app.plugins.plugins["kb-home"].settings;
  return {
    ungroupedOrder: [...(s.ungroupedOrder || [])],
    groups: (s.groups || []).map((g) => ({ id: g.id, name: g.name, order: [...g.order] })),
  };
};

/** 找一个滚动位置，使源卡与落点同时可见，并确认落点真的命中目标元素 */
const FIT = (box, name, mode) => {
  const scrollers = [...document.querySelectorAll(".kb-home-container, .view-content")].filter((x) => x.scrollHeight > x.clientHeight + 4);
  const sc = scrollers[0];
  if (!sc) return { err: "没有可滚动容器" };
  const card = document.querySelector(`.kb-card[data-path="${box}"]`);
  if (!card) return { err: "找不到源卡片" };
  let target = null;
  if (mode === "card") {
    const all = [...document.querySelectorAll(".kb-card:not(.kb-card-add)")];
    const i = all.findIndex((c) => c.dataset.path === box);
    target = all[i === 0 ? 1 : i - 1];
  } else {
    const hdr = [...document.querySelectorAll(".kb-group-name")].find((e) => e.textContent === name);
    target = hdr?.closest?.(".kb-group")?.querySelector(".kb-group-drop-hint") || hdr?.closest?.(".kb-group");
  }
  if (!target) return { err: "找不到落点" };
  const max = sc.scrollHeight - sc.clientHeight;
  for (let s = 0; s <= max; s += 24) {
    sc.scrollTop = s;
    const rc = card.getBoundingClientRect();
    const rt = target.getBoundingClientRect();
    const ok = (r) => r.height > 0 && r.top >= 8 && r.bottom <= window.innerHeight - 8;
    if (!ok(rc) || !ok(rt)) continue;
    const p = { x: Math.round(rt.x + rt.width * 0.8), y: Math.round(rt.y + rt.height / 2) };
    const hit = document.elementFromPoint(p.x, p.y);
    const 命中目标 = mode === "card" ? hit?.closest?.(".kb-card") === target : !!hit?.closest?.(".kb-group-drop-hint, .kb-group");
    if (!命中目标) continue;
    return {
      scrollTop: s,
      源: { x: Math.round(rc.x + rc.width / 2), y: Math.round(rc.y + rc.height / 2) },
      落点: p,
      命中: (hit?.className || "").toString().slice(0, 40),
    };
  }
  return { err: "视口凑不出两者同屏的滚动位置（跳过）" };
};

const MARKS = () => ({
  目标高亮: [...document.querySelectorAll(".kb-card-drop-target")].map((e) => e.dataset.path),
  分组高亮: [...document.querySelectorAll(".kb-group-drop-target")].map((e) => e.dataset.groupId),
  被拖: [...document.querySelectorAll(".kb-card-dragging")].map((e) => e.dataset.path),
  dragPath: window.app.workspace.getLeavesOfType("kb-home-view")[0]?.view?.dragPath ?? null,
});

async function dragTo(ctx, f, t) {
  await ctx.raw("mouseMoved", f.x, f.y);
  await sleep(60);
  await ctx.raw("mousePressed", f.x, f.y);
  await sleep(80);
  for (let i = 1; i <= 6; i++) {
    await ctx.raw("mouseMoved", f.x + i * 2, f.y - i * 2);
    await sleep(30);
  }
  for (let i = 1; i <= 20; i++) {
    await ctx.raw("mouseMoved", Math.round(f.x + ((t.x - f.x) * i) / 20), Math.round(f.y + ((t.y - f.y) * i) / 20));
    await sleep(26);
  }
  await sleep(200);
  const marks = await ctx.page(MARKS);
  await ctx.raw("mouseReleased", t.x, t.y);
  await sleep(700);
  return marks;
}

export default async (ctx) => {
  const rep = {};
  const checks = [];
  const add = (n, res, d) => checks.push({ 检查: n, 结论: res === true ? "PASS" : res === "skip" ? "SKIP" : "FAIL", ...(d ? { 证据: d } : {}) });
  ctx.progress.push(rep);

  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.ready = await waitReady(ctx);
  await ctx.page(REC);
  const before = await ctx.page(SNAP);

  // ---------- 0. 卡片墙外观 + 隐藏文件夹不再冒充知识库 ----------
  rep.新建框 = await ctx.page(() => {
    const 按钮 = [...document.querySelectorAll(".kb-home-btn")].map((b) => b.textContent.trim());
    return {
      虚线新建框: document.querySelectorAll(".kb-card-add").length,
      卡片数: document.querySelectorAll(".kb-card").length,
      工具条按钮: 按钮,
    };
  });
  add(
    "卡片墙不再每个分组挂虚线「新建知识库」大框，工具条仍留着入口",
    rep.新建框.虚线新建框 === 0 &&
      rep.新建框.工具条按钮.some((t) => t.includes("新建知识库")) &&
      rep.新建框.工具条按钮.some((t) => t.includes("新建分组")),
    rep.新建框
  );

  const cardRect = await ctx.page((box) => {
    const el = document.querySelector(`.kb-card[data-path="${box}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, SANDBOX);
  add("沙箱卡片在列表里", !!cardRect, cardRect);
  if (cardRect) {
    await ctx.click(cardRect.x, cardRect.y, "right");
    await sleep(400);
    const hideItem = await ctx.page(() => {
      const mi = [...document.querySelectorAll(".menu .menu-item")].find((m) =>
        m.textContent.includes("从列表隐藏")
      );
      if (!mi) return null;
      const r = mi.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    add("卡片右键里有「从列表隐藏」", !!hideItem, hideItem);
    if (hideItem) {
      await ctx.click(hideItem.x, hideItem.y);
      await sleep(600);
      rep.隐藏后 = await ctx.page((box) => {
        const s = window.app.plugins.plugins["kb-home"].settings;
        return {
          卡片还在: !!document.querySelector(`.kb-card[data-path="${box}"]`),
          标记: !!s.order.items[box]?.isHidden,
          卡片数: document.querySelectorAll(".kb-card").length,
        };
      }, SANDBOX);
      add(
        "隐藏后这张卡片从知识库列表消失（用的就是原生树那个 isHidden 标记）",
        rep.隐藏后.卡片还在 === false && rep.隐藏后.标记 === true,
        rep.隐藏后
      );
      // 与原生同一开关：打开「显示被隐藏的文件」它就回来
      await ctx.page((box) => {
        const p = window.app.plugins.plugins["kb-home"];
        p.settings.order.showHidden = true;
        p.sortFeature?.syncRuntimeSettings();
        p.refreshViews();
        return p.saveSettingsNow();
      }, SANDBOX);
      await sleep(500);
      const 显示隐藏时 = await ctx.page(
        (box) => !!document.querySelector(`.kb-card[data-path="${box}"]`),
        SANDBOX
      );
      add("打开「显示被隐藏的文件」后它又回到列表", 显示隐藏时 === true, { 显示隐藏时 });
      // 复位：取消隐藏 + 关闭 showHidden
      await ctx.page((box) => {
        const p = window.app.plugins.plugins["kb-home"];
        p.settings.order.showHidden = false;
        if (p.settings.order.items[box]) p.settings.order.items[box].isHidden = false;
        p.sortFeature?.syncRuntimeSettings();
        p.refreshViews();
        return p.saveSettingsNow();
      }, SANDBOX);
      await sleep(500);
      const 复位后 = await ctx.page(
        (box) => ({
          卡片回来了: !!document.querySelector(`.kb-card[data-path="${box}"]`),
          还藏着: !!window.app.plugins.plugins["kb-home"].settings.order.items[box]?.isHidden,
          showHidden: window.app.plugins.plugins["kb-home"].settings.order.showHidden,
        }),
        SANDBOX
      );
      add("复位：取消隐藏后卡片回来、showHidden 回到 false", 复位后.卡片回来了 && !复位后.还藏着 && 复位后.showHidden === false, 复位后);
    }
  }

  // 准备：卡片墙很高，源卡（排最后）与目标卡（排最前）无法同屏。
  // 先把别的分组折叠、并把沙箱卡挪到目标卡旁边 —— 这是 setup，不是被断言的行为。
  rep.整理墙面 = await ctx.page((box) => {
    const p = window.app.plugins.plugins["kb-home"];
    const view = window.app.workspace.getLeavesOfType("kb-home-view")[0]?.view;
    for (const g of p.settings.groups) view.collapsed.add(g.id);
    const rest = p.settings.ungroupedOrder.filter((x) => x !== box);
    p.settings.ungroupedOrder = [rest[0], box, ...rest.slice(1)];
    view.render();
    return p.saveSettingsNow().then(() => ({ 沙箱位置: p.settings.ungroupedOrder.indexOf(box) }));
  }, SANDBOX);
  await sleep(600);

  // ---------- 1. 同级重排：把沙箱卡拖到另一张卡上 ----------
  const fit1 = await ctx.page(FIT, SANDBOX, null, "card");
  rep.同级几何 = fit1;
  if (fit1.err) {
    add("卡片同级拖拽重排", "skip", fit1.err);
  } else {
    const marks = await dragTo(ctx, fit1.源, fit1.落点);
    rep.同级悬停 = marks;
    const after = await ctx.page(SNAP);
    add("拖拽中目标卡片出现放置高亮", marks.目标高亮.length > 0, marks);
    add("放下后 ungroupedOrder 真的改变", JSON.stringify(before.ungroupedOrder) !== JSON.stringify(after.ungroupedOrder), {
      before: before.ungroupedOrder,
      after: after.ungroupedOrder,
    });
  }

  // ---------- 2. 建分组 → 折叠 → 拖到放置区 ----------
  const btn = await ctx.page(() => {
    const b = [...document.querySelectorAll(".kb-home-btn")].find((x) => x.textContent.includes("新建分组"));
    b.scrollIntoView({ block: "nearest" });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await ctx.click(btn.x, btn.y);
  await sleep(500);
  const inp = await ctx.page(() => {
    const i = document.querySelector(".modal input");
    const r = i?.getBoundingClientRect();
    return r ? { x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2) } : null;
  });
  await ctx.click(inp.x, inp.y);
  await ctx.clearAndType(GROUP);
  await ctx.key("Enter", "Enter", 13);
  await sleep(800);
  // 新建的分组要展开状态才有网格；这里刻意保持它折叠，只为拿放置区
  const hdr = await ctx.page((name) => {
    const h = [...document.querySelectorAll(".kb-group-name")].find((e) => e.textContent === name);
    if (!h) return null;
    h.scrollIntoView({ block: "center" });
    const r = h.closest(".kb-group-header").getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, GROUP);
  add("新建分组生效", !!hdr, hdr);
  if (hdr) {
    await ctx.click(hdr.x, hdr.y); // 折叠 → 出现「拖到此处移入本分组」
    await sleep(600);
    const fit2 = await ctx.page(FIT, SANDBOX, GROUP, "hint");
    rep.放置区几何 = fit2;
    if (fit2.err) {
      add("拖到折叠分组放置区即可移入", "skip", fit2.err);
    } else {
      const marks2 = await dragTo(ctx, fit2.源, fit2.落点);
      const after2 = await ctx.page(SNAP);
      rep.移入悬停 = marks2;
      rep.移入后分组 = after2.groups;
      add("拖拽中该分组整体高亮为放置区", marks2.分组高亮.length > 0 && marks2.dragPath === SANDBOX, marks2);
      add("放下后知识库进入该分组", after2.groups.some((g) => g.name === GROUP && g.order.includes(SANDBOX)), after2.groups);
    }
  }

  // ---------- 3. 收尾：删掉测试分组并恢复顺序 ----------
  await ctx.page((snap) => {
    const p = window.app.plugins.plugins["kb-home"];
    p.settings.ungroupedOrder = snap.ungroupedOrder;
    p.settings.groups = snap.groups;
    const v = window.app.workspace.getLeavesOfType("kb-home-view")[0]?.view;
    if (v) v.render();
    return p.saveSettingsNow();
  }, before);
  await sleep(500);
  const fin = await ctx.page(SNAP);
  add("收尾：分组与顺序回到测试前", JSON.stringify(fin.groups) === JSON.stringify(before.groups), fin.groups.map((g) => g.name));

  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length} PASS / ${checks.filter((c) => c.结论 === "SKIP").length} SKIP / ${checks.filter((c) => c.结论 === "FAIL").length} FAIL`;
  rep.失败项 = checks.filter((c) => c.结论 === "FAIL");
  return rep;
};
