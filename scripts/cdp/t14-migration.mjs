/*
旧版虚拟分组 → 真实文件夹迁移（自包含，可在任意测试 vault 跑）。
用 __kb迁移自测_ 前缀在根目录造一套临时结构，迁移完成后清理并还原设置。
*/
const P = "__kb迁移自测_";
const G1 = `${P}工作`;
const G2 = `${P}生活`;
const KB1 = `${P}中医`;
const KB2 = `${P}编程`;
const KB3 = `${P}旅行`;
const ROOT = `${P}杂项`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = async (P, G1, G2, KB1, KB2, KB3, ROOT) => {
  const app = window.app;
  const p = app.plugins.plugins["sun-home"];
  const removeIf = async (path) => {
    const f = app.vault.getAbstractFileByPath(path);
    if (f) await app.vault.delete(f, true);
  };
  for (const path of [G1, G2, ROOT, KB1, KB2, KB3]) await removeIf(path);

  window.__kbMigTestSnapshot = {
    groups: JSON.parse(JSON.stringify(p.settings.groups || [])),
    ungroupedOrder: [...(p.settings.ungroupedOrder || [])],
    overrides: JSON.parse(JSON.stringify(p.settings.overrides || {})),
    items: JSON.parse(JSON.stringify(p.settings.order.items || {})),
  };

  await app.vault.createFolder(KB1);
  await app.vault.createFolder(KB2);
  await app.vault.createFolder(KB3);
  await app.vault.createFolder(ROOT);
  await app.vault.create(`${KB1}/笔记.md`, "# 中医\n");
  await app.vault.create(`${KB2}/README.md`, "# 编程\n");
  await app.vault.create(`${KB3}/x.md`, "# 旅行\n");
  await app.vault.create(`${ROOT}/root.md`, "# 杂项\n");

  p.settings.groups = [
    { id: "g_mig_work", name: G1, order: [KB1, KB2] },
    { id: "g_mig_life", name: G2, order: [KB3] },
  ];
  p.settings.ungroupedOrder = [ROOT];
  p.settings.overrides = { [KB1]: { name: "中医手册", icon: "🌿" } };
  p.settings.order.items[KB1] = { isPinned: true, isHidden: false };
  await p.saveSettingsNow();
  p.refreshViews();
  await p.openKbHome();
  return true;
};

const SNAP = () => {
  const p = window.app.plugins.plugins["sun-home"];
  const s = p.settings;
  const exists = (path) => !!window.app.vault.getAbstractFileByPath(path);
  return {
    legacy: p.hasLegacyGroupDefs(),
    groups: (s.groups || []).map((g) => ({ name: g.name, path: g.path ?? null, order: [...g.order] })),
    ungroupedOrder: [...(s.ungroupedOrder || [])],
    overrideKeys: Object.keys(s.overrides || {}),
    pinned: s.order.items[`${window.__kbMigTestPrefix}工作/${window.__kbMigTestPrefix}中医`]?.isPinned ?? null,
    cards: [...document.querySelectorAll(".kb-card")].map((c) => c.dataset.path),
    disk: {
      工作: exists(`${window.__kbMigTestPrefix}工作`),
      中医: exists(`${window.__kbMigTestPrefix}中医`),
      组内中医: exists(`${window.__kbMigTestPrefix}工作/${window.__kbMigTestPrefix}中医`),
      组内编程: exists(`${window.__kbMigTestPrefix}工作/${window.__kbMigTestPrefix}编程`),
      组内旅行: exists(`${window.__kbMigTestPrefix}生活/${window.__kbMigTestPrefix}旅行`),
      根杂项: exists(`${window.__kbMigTestPrefix}杂项`),
    },
  };
};

const CLEANUP = async (P) => {
  const app = window.app;
  const p = app.plugins.plugins["sun-home"];
  const snap = window.__kbMigTestSnapshot || {};
  for (const name of [`${P}工作`, `${P}生活`, `${P}杂项`]) {
    const f = app.vault.getAbstractFileByPath(name);
    if (f) await app.vault.delete(f, true);
  }
  p.settings.groups = snap.groups || [];
  p.settings.ungroupedOrder = snap.ungroupedOrder || [];
  p.settings.overrides = snap.overrides || {};
  p.settings.order.items = snap.items || {};
  await p.saveSettingsNow();
  p.refreshViews();
  return true;
};

async function clickButton(ctx, text) {
  const p = await ctx.page((t) => {
    const b = [...document.querySelectorAll(".modal button")].find((x) => x.textContent.trim() === t);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, text);
  if (!p) return false;
  await ctx.click(p.x, p.y);
  return true;
}

export default async (ctx) => {
  const checks = [];
  const add = (n, pass, d) => checks.push({ 检查: n, 结论: pass ? "PASS" : "FAIL", ...(d ? { 证据: d } : {}) });
  const rep = {};
  await ctx.page((p) => ((window.__kbMigTestPrefix = p), true), P);

  try {
    await ctx.page(SETUP, P, G1, G2, KB1, KB2, KB3, ROOT);
    await sleep(800);
    rep.before = await ctx.page(SNAP);
    add(
      "迁移前：两个虚拟分组都在根目录、没有 path",
      rep.before.legacy === true &&
        rep.before.groups.every((g) => !g.path) &&
        rep.before.disk.中医 === true &&
        rep.before.disk.组内中医 === false,
      rep.before
    );

    await ctx.page(() => window.app.plugins.plugins["sun-home"].openMigrationModal());
    await sleep(500);
    const modalTitle = await ctx.page(
      () => document.querySelector(".modal h3")?.textContent ?? null
    );
    add("迁移弹窗自动出现", modalTitle === "旧分组改为真实文件夹", { modalTitle });

    await clickButton(ctx, "开始迁移");
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const migrating = await ctx.page(() => window.app.plugins.plugins["sun-home"].migrating);
      if (!migrating) break;
    }
    await sleep(800);
    rep.after = await ctx.page(SNAP);

    add(
      "迁移后：分组拿到真实 path，文件夹建好",
      rep.after.legacy === false &&
        rep.after.groups.every((g) => !!g.path) &&
        rep.after.disk.工作 === true &&
        rep.after.disk.组内中医 === true &&
        rep.after.disk.组内编程 === true &&
        rep.after.disk.组内旅行 === true,
      rep.after
    );
    add(
      "成员库已从根目录移走，未分组库留在根目录",
      rep.after.disk.中医 === false && rep.after.disk.根杂项 === true,
      rep.after.disk
    );
    add(
      "名称覆盖与置顶状态跟着新路径迁移",
      rep.after.overrideKeys.includes(`${G1}/${KB1}`) &&
        rep.after.overrideKeys.includes(KB1) === false &&
        rep.after.pinned === true,
      { overrideKeys: rep.after.overrideKeys, pinned: rep.after.pinned }
    );
    add(
      "组内排序与未分组排序同步更新",
      rep.after.groups.find((g) => g.name === G1)?.order.join("|") === `${G1}/${KB1}|${G1}/${KB2}` &&
        rep.after.ungroupedOrder.includes(ROOT) &&
        !rep.after.ungroupedOrder.includes(KB1),
      { groups: rep.after.groups, ungroupedOrder: rep.after.ungroupedOrder }
    );
    add(
      "卡片墙按真实分组展示",
      rep.after.cards.includes(`${G1}/${KB1}`) &&
        rep.after.cards.includes(`${G1}/${KB2}`) &&
        rep.after.cards.includes(`${G2}/${KB3}`),
      rep.after.cards
    );

    const close = await clickButton(ctx, "关闭");
    add("迁移完成后可以关闭弹窗", close === true);
  } finally {
    await ctx.page(CLEANUP, P);
    await sleep(600);
  }

  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  rep.失败项 = checks.filter((c) => c.结论 === "FAIL");
  return rep;
};
