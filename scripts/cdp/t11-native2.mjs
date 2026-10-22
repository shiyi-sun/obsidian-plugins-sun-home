import { READY, MARK_RELOAD, SHOW_EXPLORER, EXPAND_CHAIN, NATIVE_ROW } from "./lib.mjs";

const SUBA = "__kb自测__/子文件夹A";
const A1 = `${SUBA}/笔记A1.md`;
const A2 = `${SUBA}/笔记A2.md`;
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

const STATE = (pre) => {
  const title = document.querySelector(
    `[data-type="file-explorer"] .nav-folder-title[data-path="${pre.replace(/\/$/, "")}"]`
  );
  const box = title?.closest(".nav-folder");
  const kids = [...document.querySelectorAll('[data-type="file-explorer"] .nav-file-title')]
    .map((e) => e.dataset?.path)
    .filter((p) => p && p.startsWith(pre));
  return {
    折叠: box ? box.classList.contains("is-collapsed") : null,
    子项: kids,
    图钉数: kids.length
      ? [...document.querySelectorAll('[data-type="file-explorer"] .nav-file-title')]
          .filter((e) => e.dataset?.path?.startsWith(pre) && e.querySelector(".kb-pin-indicator"))
          .map((e) => e.dataset.path)
      : [],
    标题: title ? { x: title.getBoundingClientRect().x, y: title.getBoundingClientRect().y, w: title.getBoundingClientRect().width, h: title.getBoundingClientRect().height } : null,
  };
};

const MENU = () =>
  [...document.querySelectorAll(".menu")].map((m) =>
    [...m.querySelectorAll(".menu-item")].map((mi) => {
      const r = mi.getBoundingClientRect();
      return { text: mi.querySelector(".menu-item-title")?.textContent ?? "", x: r.x, y: r.y, w: r.width, h: r.height };
    })
  );

export default async (ctx) => {
  const rep = {};
  const checks = [];
  const add = (n, p, d) => checks.push({ 检查: n, 结论: p ? "PASS" : "FAIL", ...(d ? { 证据: d } : {}) });
  ctx.progress.push(rep);

  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.ready = await waitReady(ctx);
  const before = await ctx.page(() => ({ order: JSON.parse(JSON.stringify(window.app.plugins.plugins["sun-home"].settings.order)) }));

  await ctx.page(() => {
    const ws = window.app.workspace;
    const leaf = ws.getLeavesOfType("file-explorer")[0];
    if (ws.leftSplit?.collapsed) ws.leftSplit.expand();
    ws.revealLeaf(leaf);
    ws.setActiveLeaf(leaf, { focus: false });
    return true;
  });
  await sleep(1000);

  // 展开子文件夹A（用 is-collapsed 判断，真单击标题行）
  let st = await ctx.page(STATE, `${SUBA}/`);
  rep.初始 = st;
  if (st.折叠 === true && st.标题) {
    await ctx.click(Math.round(st.标题.x + st.标题.w / 2), Math.round(st.标题.y + st.标题.h / 2));
    await sleep(800);
    st = await ctx.page(STATE, `${SUBA}/`);
    rep.展开后 = st;
  }
  const 两篇都在 = st.子项.includes(A1) && st.子项.includes(A2);
  add("原生浏览器里能看到子文件夹A的两篇子笔记", 两篇都在, st);
  if (!两篇都在) {
    rep.说明 = "子项仍不可见，后续断言无意义";
    rep.checks = checks;
    return rep;
  }

  // ---------- 1. customOrder ----------
  await ctx.page((parent) => {
    const p = window.app.plugins.plugins["sun-home"];
    p.settings.order.items[parent] = { ...(p.settings.order.items[parent] || {}), sortOrder: "custom", customOrder: ["笔记A2.md", "笔记A1.md"] };
    p.sortFeature.syncRuntimeSettings();
    return p.saveSettingsNow().then(() => {
      p.sortFeature.sortExplorer();
      p.sortFeature.syncIndicators();
    });
  }, SUBA);
  await sleep(1000);
  const c1 = await ctx.page(STATE, `${SUBA}/`);
  rep.自定义顺序 = c1;
  add("原生浏览器按 customOrder 排：A2 在 A1 前", c1.子项[0] === A2 && c1.子项[1] === A1, c1.子项);

  // ---------- 2. 右键菜单切回名称序 ----------
  const t2 = await ctx.page(STATE, `${SUBA}/`);
  await ctx.click(Math.round(t2.标题.x + t2.标题.w / 2), Math.round(t2.标题.y + t2.标题.h / 2), "right");
  await sleep(500);
  let menus = await ctx.page(MENU);
  const sortItem = menus.flat().find((i) => i.text === "排序方式");
  await ctx.click(Math.round(sortItem.x + sortItem.w / 2), Math.round(sortItem.y + sortItem.h / 2));
  await sleep(700);
  menus = await ctx.page(MENU);
  const nameAsc = menus.flat().find((i) => i.text === "名称 A → Z");
  await ctx.click(Math.round(nameAsc.x + nameAsc.w / 2), Math.round(nameAsc.y + nameAsc.h / 2));
  await sleep(1000);
  const c2 = await ctx.page(STATE, `${SUBA}/`);
  const st2 = await ctx.page((parent) => window.app.plugins.plugins["sun-home"].settings.order.items[parent].sortOrder, SUBA);
  rep.名称序 = { 子项: c2.子项, sortOrder: st2 };
  add("右键「排序方式 → 名称 A → Z」把顺序换回 A1 在前并落盘", c2.子项[0] === A1 && st2 === "byNameAsc", rep.名称序);

  // ---------- 3. 置顶（原生浏览器内）----------
  await ctx.page((parent, a2) => {
    const p = window.app.plugins.plugins["sun-home"];
    p.settings.order.items[a2] = { ...(p.settings.order.items[a2] || {}), isPinned: true };
    p.sortFeature.syncRuntimeSettings();
    return p.saveSettingsNow().then(() => {
      p.sortFeature.sortExplorer();
      p.sortFeature.syncIndicators();
    });
  }, SUBA, A2);
  await sleep(1000);
  const c3 = await ctx.page(STATE, `${SUBA}/`);
  rep.置顶后 = c3;
  add("置顶项在原生浏览器里排到最前且带图钉", c3.子项[0] === A2 && c3.图钉数.includes(A2), c3);

  // ---------- 4. 收尾 ----------
  await ctx.page((snap) => {
    const p = window.app.plugins.plugins["sun-home"];
    p.settings.order = snap.order;
    p.sortFeature.syncRuntimeSettings();
    return p.saveSettingsNow().then(() => {
      p.sortFeature.syncIndicators();
      p.sortFeature.sortExplorer();
    });
  }, before);
  await sleep(700);
  rep.收尾后 = await ctx.page(STATE, `${SUBA}/`);

  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  return rep;
};
