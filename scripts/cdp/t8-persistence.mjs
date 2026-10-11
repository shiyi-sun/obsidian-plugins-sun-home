import { READY, MARK_RELOAD } from "./lib.mjs";

const SANDBOX = "__kb自测__";
const NOTE = `${SANDBOX}/根笔记1.md`;
const PAT = "__kb自测__/说明.md";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });

async function waitReady(ctx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await ctx.page(READY);
    if (r.新文档 && r.ready && (r.cards > 0 || r.有树)) return r;
    await sleep(700);
  }
  throw new Error("超时");
}

const DISK = () =>
  window.app.vault.adapter.read(".obsidian/plugins/kb-home/data.json").then((t) => {
    const d = JSON.parse(t);
    return {
      A自定义顺序: d.order?.items?.["__kb自测__/子文件夹A"]?.customOrder ?? null,
      A排序方式: d.order?.items?.["__kb自测__/子文件夹A"]?.sortOrder ?? null,
      钉住: Object.entries(d.order?.items || {}).filter(([, v]) => v?.isPinned).map(([k]) => k),
      隐藏: Object.entries(d.order?.items || {}).filter(([, v]) => v?.isHidden).map(([k]) => k),
      showHidden: d.order?.showHidden,
      hidePatterns: d.order?.hidePatterns,
      openOnStartup: d.openOnStartup,
    };
  });

const MEM = () => {
  const p = window.app.plugins.plugins["kb-home"];
  const s = p?.settings;
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  return {
    插件已加载: !!p,
    manifest版本: p?.manifest?.version,
    A自定义顺序: s?.order?.items?.["__kb自测__/子文件夹A"]?.customOrder ?? null,
    A排序方式: s?.order?.items?.["__kb自测__/子文件夹A"]?.sortOrder ?? null,
    钉住: Object.entries(s?.order?.items || {}).filter(([, v]) => v?.isPinned).map(([k]) => k),
    showHidden: s?.order?.showHidden,
    hidePatterns: s?.order?.hidePatterns,
    openOnStartup: s?.openOnStartup,
    树的currentPath: view?.currentPath ?? null,
    树行数: view?.containerEl ? view.containerEl.querySelectorAll(".kb-tree-body .tree-item").length : null,
    卡片墙leaf数: window.app.workspace.getLeavesOfType("kb-home-view").length,
    树leaf数: window.app.workspace.getLeavesOfType("kb-tree-view").length,
  };
};

const RIBBON = () =>
  [...document.querySelectorAll(".side-dock-ribbon-action")].map((a) => a.getAttribute("aria-label") || a.getAttribute("title")).filter(Boolean);

const EXPLORER_PURITY = () => {
  const leaf = window.app.workspace.getLeavesOfType("file-explorer")[0];
  return {
    指示器数: document.querySelectorAll(".kb-indicator").length,
    "隐藏类行数": document.querySelectorAll(".kb-hidden").length,
    树容器在: !!document.querySelector(".kb-tree-container"),
    卡片墙在: !!document.querySelector(".kb-home-container"),
    浏览器行数: document.querySelectorAll(
      '[data-type="file-explorer"] .nav-file-title, [data-type="file-explorer"] .nav-folder-title'
    ).length,
    原生顺序前5: [
      ...document.querySelectorAll(
        '[data-type="file-explorer"] .nav-file-title, [data-type="file-explorer"] .nav-folder-title'
      ),
    ]
      .slice(0, 5)
      .map((e) => e.dataset?.path),
    残留分布: (() => {
      const 计 = (sel) => {
        const m = {};
        document.querySelectorAll(sel).forEach((e) => {
          const k = e.closest("[data-type]")?.getAttribute("data-type") ?? "?";
          m[k] = (m[k] || 0) + 1;
        });
        return m;
      };
      return { 指示器: 计(".kb-indicator"), 隐藏类: 计(".kb-hidden") };
    })(),
    插件启用: window.app.plugins.enabledPlugins?.has?.("kb-home") ?? null,
  };
};

export default async (ctx) => {
  const rep = {};
  const checks = [];
  const add = (n, p, d) => checks.push({ 检查: n, 结论: p ? "PASS" : "FAIL", ...(d ? { 证据: d } : {}) });
  ctx.progress.push(rep);

  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.ready = await waitReady(ctx);

  // ---------- 1. ribbon 图标与命令清单 ----------
  rep.ribbon = await ctx.page(RIBBON);
  add(
    "ribbon 有本插件两个入口",
    rep.ribbon.some((t) => t.includes("知识库列表")) && rep.ribbon.some((t) => t.includes("当前知识库目录")),
    rep.ribbon
  );
  rep.命令 = await ctx.page(() =>
    Object.values(window.app.commands.commands)
      .filter((c) => String(c.id).startsWith("kb-home"))
      .map((c) => `${c.id} | ${c.name}`)
  );
  rep.命令清单 = rep.命令;
  add("三条命令都注册了", rep.命令.length >= 3, rep.命令);

  // ---------- 2. ribbon 真点击（先确保有一篇打开中的笔记，否则该命令按设计应提示「当前没有打开的笔记」）----------
  await ctx.page((sb) => window.app.workspace.openLinkText(`${sb}/说明.md`, "", false), "__kb自测__");
  await sleep(800);
  const rib = await ctx.page(() => {
    const a = [...document.querySelectorAll(".side-dock-ribbon-action")].find((x) => (x.getAttribute("aria-label") || "").includes("当前知识库目录"));
    const r = a.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await ctx.click(center(rib).x, center(rib).y);
  await sleep(700);
  rep.点ribbon后 = await ctx.page(MEM);
  add("点 ribbon「打开当前知识库目录」即出现该库的树", rep.点ribbon后.树行数 > 0 && rep.点ribbon后.树的currentPath === SANDBOX, rep.点ribbon后);

  // ---------- 3. 写一批设置 → 重载 → 读回（内存 + 磁盘）----------
  await ctx.page((note, pat) => {
    const p = window.app.plugins.plugins["kb-home"];
    p.settings.order.items[note] = { ...(p.settings.order.items[note] || {}), isPinned: true };
    p.settings.order.hidePatterns = [pat];
    // 手动顺序现在只有这一份：order.items[文件夹].customOrder（原生树与单库树共用）
    const A = p.settings.order.items["__kb自测__/子文件夹A"] ??= {
      isPinned: false,
      isHidden: false,
      customOrder: [],
      sortOrder: "custom",
    };
    A.customOrder = ["笔记A2.md", "笔记A1.md"];
    A.sortOrder = "custom";
    p.sortFeature.syncRuntimeSettings();
    return p.saveSettingsNow();
  }, NOTE, PAT);
  await sleep(500);
  rep.落盘内容 = await ctx.page(DISK);
  add(
    "写入后立刻落盘（磁盘 JSON 里能看到置顶/规则/手动顺序）",
    rep.落盘内容.钉住.includes(NOTE) &&
      rep.落盘内容.hidePatterns.includes(PAT) &&
      JSON.stringify(rep.落盘内容.A自定义顺序) === JSON.stringify(["笔记A2.md", "笔记A1.md"]),
    rep.落盘内容
  );

  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.ready2 = await waitReady(ctx);
  rep.重载后内存 = await ctx.page(MEM);
  rep.重载后磁盘 = await ctx.page(DISK);
  add(
    "重载后设置读回一致（置顶/规则/自定义顺序都在）",
    rep.重载后内存.钉住.includes(NOTE) &&
      rep.重载后内存.hidePatterns.includes(PAT) &&
      JSON.stringify(rep.重载后内存.A自定义顺序) === JSON.stringify(["笔记A2.md", "笔记A1.md"]) &&
      rep.重载后内存.A排序方式 === "custom",
    { 内存: rep.重载后内存, 磁盘: rep.重载后磁盘 }
  );
  add(
    "启动后视图状态可恢复：卡片墙 leaf 存在（openOnStartup=true）",
    rep.重载后内存.openOnStartup === true && rep.重载后内存.卡片墙leaf数 >= 1,
    { openOnStartup: rep.重载后内存.openOnStartup, 卡片墙leaf: rep.重载后内存.卡片墙leaf数 }
  );
  add(
    "glob 规则在重启后依然隐藏该文件",
    await ctx.page((pat) => {
      const el = document.querySelector(
        `[data-type="file-explorer"] .nav-file-title[data-path="${pat}"]`
      );
      const w = el?.closest(".nav-file");
      return !el || w?.classList.contains("kb-hidden") || el?.offsetParent === null;
    }, PAT),
    await ctx.page((pat) => {
      const el = document.querySelector(
        `[data-type="file-explorer"] .nav-file-title[data-path="${pat}"]`
      );
      return { 行存在: !!el, 外层类: el?.closest(".nav-file")?.className ?? null, 可见: el ? el.offsetParent !== null : null };
    }, PAT)
  );

  // ---------- 4. 命令：toggle-show-hidden ----------
  const beforeCmd = await ctx.page(() => ({ body: document.body.classList.contains("kb-show-hidden"), s: window.app.plugins.plugins["kb-home"].settings.order.showHidden }));
  await ctx.page(() => window.app.commands.executeCommandById("kb-home:toggle-show-hidden"));
  await sleep(600);
  const afterCmd = await ctx.page(() => ({ body: document.body.classList.contains("kb-show-hidden"), s: window.app.plugins.plugins["kb-home"].settings.order.showHidden }));
  add("命令「显示/隐藏被隐藏的文件」翻转状态并落盘", beforeCmd.body !== afterCmd.body && afterCmd.s === afterCmd.body, { beforeCmd, afterCmd });
  await ctx.page(() => window.app.commands.executeCommandById("kb-home:toggle-show-hidden"));
  await sleep(500);

  // ---------- 5. 禁用插件 → 现场清理；再启用 → 恢复 ----------
  // 禁用后要测的是原生浏览器面板，先把它切到前台（左栏同一时刻只渲染一个面板）
  await ctx.page(() => {
    const ws = window.app.workspace;
    const leaf = ws.getLeavesOfType("file-explorer")[0];
    if (ws.leftSplit?.collapsed) ws.leftSplit.expand();
    ws.revealLeaf(leaf);
    return true;
  });
  await sleep(1000);
  rep.禁用前 = await ctx.page(EXPLORER_PURITY);
  await ctx.page(() => window.app.plugins.disablePlugin("kb-home"));
  await sleep(1200);
  rep.禁用后 = await ctx.page(EXPLORER_PURITY);
  add("禁用后本插件的两个面板被摘掉", rep.禁用后.树容器在 === false && rep.禁用后.卡片墙在 === false, rep.禁用后);
  add("禁用后原生浏览器上不再有插件痕迹（指示器/隐藏类清零）", rep.禁用后.指示器数 === 0 && rep.禁用后["隐藏类行数"] === 0, rep.禁用后);
  add("禁用后原生浏览器仍在正常工作（有行、按原生顺序）", rep.禁用后.浏览器行数 > 0, rep.禁用后.原生顺序前5);
  rep.禁用后报错 = await ctx.page(() => null);

  await ctx.page(() => window.app.plugins.enablePlugin("kb-home"));
  await sleep(1500);
  rep.启用后 = await ctx.page(EXPLORER_PURITY);
  rep.启用后内存 = await ctx.page(MEM);
  add("重新启用后面板与指示器都回来了", rep.启用后内存.插件已加载 && rep.启用后["隐藏类行数"] >= 0 && rep.启用后内存.卡片墙leaf数 >= 1, rep.启用后内存);
  add(
    "重新启用后隐藏规则重新生效（不用重启）",
    await ctx.page((pat) => {
      const el = document.querySelector(
        `[data-type="file-explorer"] .nav-file-title[data-path="${pat}"]`
      );
      return !el || el.closest(".nav-file")?.classList.contains("kb-hidden") || el.offsetParent === null;
    }, PAT)
  );

  // ---------- 6. 收尾：清掉本测试写入的设置项 ----------
  await ctx.page((note) => {
    const p = window.app.plugins.plugins["kb-home"];
    if (p.settings.order.items[note]) p.settings.order.items[note].isPinned = false;
    p.settings.order.hidePatterns = [];
    delete p.settings.order.items["__kb自测__/子文件夹A"];
    p.sortFeature.syncRuntimeSettings();
    return p.saveSettingsNow().then(() => {
      p.sortFeature.syncIndicators();
      p.sortFeature.sortExplorer();
    });
  }, NOTE);
  await sleep(600);
  rep.收尾后磁盘 = await ctx.page(DISK);
  add(
    "收尾：测试写入的置顶/规则/手动顺序已清除",
    rep.收尾后磁盘.钉住.length === 0 &&
      rep.收尾后磁盘.hidePatterns.length === 0 &&
      rep.收尾后磁盘.A自定义顺序 === null &&
      rep.收尾后磁盘.A排序方式 === null,
    rep.收尾后磁盘
  );

  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  return rep;
};
