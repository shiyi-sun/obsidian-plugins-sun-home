import { READY, MARK_RELOAD } from "./lib.mjs";

const SB = "__kb自测__";
const TEST_GROUP_HINTS = ["自测分组", "放置区实验组", "移入实验组"];
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

export default async (ctx) => {
  const rep = {};

  // 1) 设置里清掉测试痕迹（分组、顺序项、隐藏/置顶项、卡片归属）
  rep.清理结果 = await ctx.page(
    (box, hints) => {
      const p = window.app.plugins.plugins["kb-home"];
      const s = p.settings;
      s.groups = (s.groups || []).filter((g) => !hints.some((h) => g.name.startsWith(h)));
      if (s.ungroupedOrder) s.ungroupedOrder = s.ungroupedOrder.filter((x) => x !== box);
      for (const g of s.groups) g.order = g.order.filter((x) => x !== box);
      s.overrides = Object.fromEntries(Object.entries(s.overrides || {}).filter(([k]) => k !== box));
      s.order.items = Object.fromEntries(Object.entries(s.order.items || {}).filter(([k]) => k !== box && !k.startsWith(box + "/")));
      s.order.hidePatterns = (s.order.hidePatterns || []).filter((x) => !String(x).startsWith(box));
      s.order.showHidden = false;
      p.sortFeature.syncRuntimeSettings();
      return p.saveSettingsNow().then(() => {
        p.sortFeature.syncIndicators();
        p.sortFeature.sortExplorer();
        return {
          groups: s.groups.map((g) => `${g.name}:${g.order.length}`),
          沙箱痕迹: Object.keys(s.order.items).filter((k) => k.startsWith(box)),
          hidePatterns: s.order.hidePatterns,
          ungroupedHasSandbox: s.ungroupedOrder.includes(box),
        };
      });
    },
    SB,
    TEST_GROUP_HINTS
  );

  // 2) 磁盘上确认干净
  rep.磁盘 = await ctx.page(
    (box) =>
      window.app.vault.adapter.read(".obsidian/plugins/kb-home/data.json").then((t) => {
        const d = JSON.parse(t);
        return {
          沙箱痕迹: Object.keys(d.order?.items || {}).filter((k) => k.startsWith(box)),
          hidePatterns: d.order?.hidePatterns,
          groups: (d.groups || []).map((g) => g.name),
          ungrouped: d.ungroupedOrder,
          隐藏项: Object.entries(d.order?.items || {}).filter(([, v]) => v?.isHidden).map(([k]) => k),
          openOnStartup: d.openOnStartup,
        };
      }),
    SB
  );

  // 3) 关掉测试期间打开的多余标签（含指向已删文件的死标签）
  //  ⚠️ 不能看 view.file：未实体化的 leaf 那里是 null，死标签就是这么漏网的。
  //     要读 getViewState().state.file —— 它在没布局的标签上同样有值。
  const 该关的 = (box) =>
    window.app.workspace
      .getLeavesOfType("markdown")
      .filter((l) => {
        const p = l.getViewState?.()?.state?.file ?? l.view?.file?.path ?? null;
        if (!p) return false;
        return p.startsWith(box) || !window.app.vault.getAbstractFileByPath(p);
      })
      .map((l) => l.getViewState?.()?.state?.file ?? l.view?.file?.path);
  rep.关闭的标签 = await ctx.page(该关的, SB);
  await ctx.page((box) => {
    const ws = window.app.workspace;
    for (const leaf of [...ws.getLeavesOfType("markdown")]) {
      const p = leaf.getViewState?.()?.state?.file ?? leaf.view?.file?.path ?? null;
      if (!p) continue;
      if (p.startsWith(box) || !window.app.vault.getAbstractFileByPath(p)) leaf.detach();
    }
    return true;
  }, SB);
  await sleep(500);
  rep.关完之后剩下的死标签 = await ctx.page(该关的, SB);

  // 4) 删掉沙箱库本身（只删测试建的那个文件夹）
  rep.删除沙箱 = await ctx.page((box) => {
    const folder = window.app.vault.getAbstractFileByPath(box);
    if (!folder) return "不存在，无需删";
    return window.app.vault.delete(folder, true).then(() => "已删除（移到系统回收站）");
  }, SB);
  await sleep(800);
  rep.沙箱还在吗 = await ctx.page((box) => !!window.app.vault.getAbstractFileByPath(box), SB);

  // 5) 刷新一次，确认插件仍然正常加载
  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.重启后就绪 = await waitReady(ctx);
  rep.重启后状态 = await ctx.page(() => {
    const p = window.app.plugins.plugins["kb-home"];
    const ws = window.app.workspace;
    return {
      版本: p?.manifest?.version,
      面板: {
        卡片墙: ws.getLeavesOfType("kb-home-view").length,
        单库树: ws.getLeavesOfType("kb-tree-view").length,
      },
      知识库数: [...document.querySelectorAll(".kb-card")].map((c) => c.dataset.path).length,
      有沙箱卡: !!document.querySelector('.kb-card[data-path="__kb自测__"]'),
      浏览器行数: document.querySelectorAll(".nav-file-title, .nav-folder-title").length,
      残留指示器: document.querySelectorAll(".kb-indicator").length,
      残留隐藏类: document.querySelectorAll(".kb-hidden").length,
    };
  });
  const checks = [];
  const add = (n, pass, d) =>
    checks.push({ 检查: n, 结论: pass ? "PASS" : "FAIL", ...(d ? { 证据: d } : {}) });
  add("沙箱文件夹已从 vault 删除", rep.沙箱还在吗 === false, { 沙箱还在吗: rep.沙箱还在吗 });
  add(
    "内存设置里查不到沙箱痕迹（order.items / overrides / 分组归属）",
    rep.清理结果.沙箱痕迹.length === 0 && rep.清理结果.ungroupedHasSandbox === false,
    rep.清理结果
  );
  add(
    "落盘的 data.json 里也查不到沙箱痕迹",
    rep.磁盘.沙箱痕迹.length === 0,
    rep.磁盘
  );
  add(
    "测试期间打开的标签（含指向已删文件的死标签）全部关干净",
    rep.关完之后剩下的死标签.length === 0 && rep.沙箱还在吗 === false,
    { 关掉的: rep.关闭的标签, 剩下的: rep.关完之后剩下的死标签 }
  );
  add(
    "重启后插件仍启用、原生树与卡片墙正常",
    rep.重启后状态.面板.卡片墙 + rep.重启后状态.面板.单库树 >= 1 &&
      rep.重启后状态.浏览器行数 > 0 &&
      !rep.重启后状态.有沙箱卡,
    rep.重启后状态
  );
  add(
    "原生树里不再有指向沙箱的隐藏类残留",
    (rep.重启后状态.残留隐藏类 ?? 0) >= 0 && !rep.磁盘.隐藏项.some((p) => p.startsWith(SB)),
    { 残留隐藏类: rep.重启后状态.残留隐藏类, 磁盘隐藏项: rep.磁盘.隐藏项 }
  );
  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  rep.失败项 = checks.filter((c) => c.结论 === "FAIL");
  return rep;
};
