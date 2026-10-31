/*
分组标题拖拽排序：真实鼠标拖动分组标题，验证放置指示线、settings.groups 顺序与落盘。
测试会临时创建三个分组，结束后删除测试文件夹并恢复原有 groups 数组。
*/
import { READY, MARK_RELOAD } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = ["__分组排序A__", "__分组排序B__", "__分组排序C__"];

async function waitReady(ctx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await ctx.page(READY);
    if (r.新文档 && r.ready) return r;
    await sleep(700);
  }
  throw new Error("超时");
}

const STATE = () => {
  const p = window.app.plugins.plugins["sun-home"];
  return {
    settings: p.settings.groups.map((g) => g.name),
    dom: [...document.querySelectorAll(".kb-group-header .kb-group-name")].map((e) =>
      e.textContent.trim()
    ),
  };
};

const PERSISTED = async () => {
  const p = window.app.plugins.plugins["sun-home"];
  const data = await p.loadData();
  return (data?.groups || []).map((g) => g.name);
};

const FIT_GROUPS = (fromName, toName, after) => {
  const headerFor = (name) => {
    const label = [...document.querySelectorAll(".kb-group-name")].find(
      (e) => e.textContent.trim() === name
    );
    return label?.closest(".kb-group-header");
  };
  const source = headerFor(fromName);
  const target = headerFor(toName);
  if (!source || !target) return { err: "找不到分组标题" };

  const scroller = [...document.querySelectorAll(".kb-home-container")].find(
    (x) => x.scrollHeight > x.clientHeight + 4
  );
  const max = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
  const candidates = [];
  for (let s = 0; s <= max; s += 24) {
    if (scroller) scroller.scrollTop = s;
    candidates.push(s);
  }
  candidates.push(max);
  for (const scrollTop of candidates) {
    if (scroller) scroller.scrollTop = scrollTop;
    const rs = source.getBoundingClientRect();
    const rt = target.getBoundingClientRect();
    const visible = (r) => r.height > 0 && r.top >= 8 && r.bottom <= window.innerHeight - 8;
    if (!visible(rs) || !visible(rt) || rs.y === rt.y) continue;
    const to = {
      x: Math.round(rt.x + Math.min(80, rt.width / 2)),
      y: after ? Math.round(rt.bottom - 3) : Math.round(rt.top + 3),
    };
    const hit = document.elementFromPoint(to.x, to.y);
    if (hit?.closest(".kb-group-header") !== target) continue;
    return {
      scrollTop,
      from: { x: Math.round(rs.x + Math.min(80, rs.width / 2)), y: Math.round(rs.y + rs.height / 2) },
      to,
    };
  }
  return { err: "找不到两个分组标题同屏的滚动位置" };
};

const MARKS = () => ({
  dragging: [...document.querySelectorAll(".kb-group-dragging")].map((e) =>
    e.querySelector(".kb-group-name")?.textContent?.trim()
  ),
  before: [...document.querySelectorAll(".kb-group-drop-before")].map((e) =>
    e.querySelector(".kb-group-name")?.textContent?.trim()
  ),
  after: [...document.querySelectorAll(".kb-group-drop-after")].map((e) =>
    e.querySelector(".kb-group-name")?.textContent?.trim()
  ),
});

const CLEAR_MARKS = () => {
  document
    .querySelectorAll(".kb-group-dragging,.kb-group-drop-before,.kb-group-drop-after")
    .forEach((e) => e.classList.remove("kb-group-dragging", "kb-group-drop-before", "kb-group-drop-after"));
  window.app.plugins.plugins["sun-home"].refreshViews();
};

async function dragGroup(ctx, fromName, toName, after) {
  const geo = await ctx.page(FIT_GROUPS, fromName, toName, after);
  if (geo.err) return { geo, marks: null };

  await ctx.raw("mouseMoved", geo.from.x, geo.from.y);
  await sleep(60);
  await ctx.raw("mousePressed", geo.from.x, geo.from.y);
  await sleep(80);
  for (let i = 1; i <= 8; i++) {
    await ctx.raw(
      "mouseMoved",
      geo.from.x + i * 3,
      geo.from.y + i * 3
    );
    await sleep(25);
  }
  for (let i = 1; i <= 30; i++) {
    await ctx.raw(
      "mouseMoved",
      Math.round(geo.from.x + ((geo.to.x - geo.from.x) * i) / 30),
      Math.round(geo.from.y + ((geo.to.y - geo.from.y) * i) / 30)
    );
    await sleep(25);
  }
  await sleep(350);
  const marks = await ctx.page(MARKS);
  await ctx.raw("mouseReleased", geo.to.x, geo.to.y);
  await sleep(900);
  return { geo, marks };
}

export default async (ctx) => {
  const rep = {};
  const checks = [];
  const add = (name, pass, evidence) =>
    checks.push({ 检查: name, 结论: pass ? "PASS" : "FAIL", ...(evidence ? { 证据: evidence } : {}) });
  ctx.progress.push(rep);

  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.ready = await waitReady(ctx);
  await ctx.page(async () => {
    await window.app.commands.executeCommandById("sun-home:open-kb-home");
  });
  await sleep(800);

  const original = await ctx.page(() => JSON.parse(JSON.stringify(window.app.plugins.plugins["sun-home"].settings.groups)));
  rep.创建前 = await ctx.page(STATE);

  rep.创建 = await ctx.page(async (names) => {
    const p = window.app.plugins.plugins["sun-home"];
    const out = [];
    for (const name of names) {
      const g = await p.createGroup(name);
      out.push({ id: g.id, name: g.name });
    }
    return out;
  }, NAMES);
  await sleep(900);

  rep.创建后 = await ctx.page(STATE);
  add(
    "三个测试分组按创建顺序出现",
    NAMES.every((n) => rep.创建后.settings.includes(n)) &&
      NAMES.every((n) => rep.创建后.dom.includes(n)),
    rep.创建后
  );

  const first = NAMES[0];
  const last = NAMES[NAMES.length - 1];
  const drag = await dragGroup(ctx, first, last, true);
  rep.拖拽 = drag;
  add(
    "拖动分组标题时显示被拖状态和落点指示线",
    drag.marks?.dragging?.includes(first) &&
      (drag.marks?.after?.includes(last) || drag.marks?.before?.includes(last)),
    drag.marks || drag.geo
  );

  rep.拖拽后 = await ctx.page(STATE);
  rep.持久化后 = await ctx.page(PERSISTED);
  const expected = [NAMES[1], NAMES[2], NAMES[0]];
  // 测试库里可能有用户自己的分组（如「的说法」），只比较本次创建的三组
  const 设置顺序 = rep.拖拽后.settings.filter((n) => NAMES.includes(n));
  const DOM顺序 = rep.拖拽后.dom.filter((n) => NAMES.includes(n));
  add(
    "放下后分组顺序真实改变，DOM 与 settings.groups 一致",
    JSON.stringify(设置顺序) === JSON.stringify(expected) &&
      JSON.stringify(DOM顺序) === JSON.stringify(expected),
    { expected, 设置顺序, DOM顺序, 拖拽后: rep.拖拽后 }
  );
  add(
    "分组顺序已写入 data.json",
    JSON.stringify(rep.持久化后.filter((n) => NAMES.includes(n))) === JSON.stringify(expected),
    { expected, 持久化后: rep.持久化后 }
  );

  rep.清理 = await ctx.page(async (originalGroups, ids) => {
    const p = window.app.plugins.plugins["sun-home"];
    for (const id of ids) {
      const g = p.settings.groups.find((x) => x.id === id);
      if (g) await p.dissolveGroup(g);
    }
    p.settings.groups = originalGroups;
    await p.saveSettingsNow();
    p.refreshViews();
    return {
      groups: p.settings.groups.map((g) => g.name),
      folders: ids
        .map((id) => originalGroups.find((g) => g.id === id)?.path)
        .filter(Boolean),
    };
  }, original, rep.创建.map((g) => g.id));
  await sleep(800);

  const 沙箱残留 = await ctx.page((names) => {
    const vault = window.app.vault;
    return names.filter((n) => !!vault.getAbstractFileByPath(n));
  }, NAMES);
  add(
    "测试分组文件夹已清理，原分组数组已恢复",
    沙箱残留.length === 0 &&
      JSON.stringify(rep.清理.groups) ===
        JSON.stringify(original.map((g) => g.name)),
    { 沙箱残留, 清理: rep.清理, original }
  );
  await ctx.page(CLEAR_MARKS);

  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  rep.失败项 = checks.filter((c) => c.结论 !== "PASS");
  rep.checks = checks;
  return rep;
};
