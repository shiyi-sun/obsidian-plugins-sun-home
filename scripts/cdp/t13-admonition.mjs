/*
提示块（::: 语法）实机用例。跑在 t0 建好的沙箱库 __kb自测__ 里，收尾删掉自己的笔记。

覆盖：
  A0 底座装配没有失败的功能
  A1 实时预览把 ::: 渲染成块（嵌套的 info 嵌在 note 里面，所以 DOM 里 5 个、顶层 4 个）
  A2 在普通行打字 → 走「沿用缓存」的便宜路径（reuse>0，scanAll 不变）
  A3 光标进块 → 该块回退成源码
  A4 光标移出块 → 重新渲染，且仍不全文重扫
  A5 靶子：删掉起始行的冒号再把光标移出去，块必须消失
       （若 canReuse 的「标记身份指纹」判据失效，这里会留下一个赖着不走的旧块）
  A6 阅读视图渲染 + 嵌套块不被拍平
  A7 可折叠块默认收起，点标题能展开
  A8 阅读侧闸门在真预览里能拿到段信息（拿不到就当场暴露，不装通过）
  A9/A10 两个开关关掉→不渲染，开回来→恢复

踩过的坑（都写在这是为了让下一个人不必再踩）：
  - 不能用 getLeavesOfType("markdown")[0]：那个 leaf 可能没有 view.editor，
    必须挑「带 editor.cm 且 file 就是目标笔记」的那个，所以先装 window.__md()。
  - view.setMode("preview") 实测会把 getMode() 变成 undefined，切不出可见预览。
    正解是另开一个 leaf：先 openFile(f)，再 setViewState({type:"markdown", active:true,
    state:{mode:"preview", file:path}}) —— 顺序反过来会被 openFile 冲回 source。
    预览根是 previewMode.containerEl（typings 里没有 rootElement）。
    另：getLeaf 的第二参是方向字符串 "vertical"/"horizontal"，传对象会在 split 时抛异常。
    另另：ctx.page 的页面函数必须写成 `(arg) => (async () => {...})()`，漏掉结尾那对 ()
    会让 .apply 返回一个函数对象、被 CDP 序列化成 {}，看着"跑了"其实什么都没做。
  - 断言磁盘内容要用整行正则轮询。用 includes("ip 尾块靶子") 会被删了一半的
    `:tip 尾块靶子` 命中，第一次轮询就误判成"等到了"。
  - 设置 modal 在本机 Obsidian 1.14 是**独立窗口**（CDP 里能看到 about:blank 那个 target），
    主文档查不到 .modal。所以两个开关的点击是在主文档里挂载同一个 renderSettings
    之后点真实开关，另外单独断言「插件设置 tab 确实注册上了」。
  - 编辑器改动落盘是防抖的，断言磁盘内容要轮询等，不能 cachedRead 一次就下结论。
*/
import { READY, MARK_RELOAD } from "./lib.mjs";

const SANDBOX = "__kb自测__";
const NOTE = `${SANDBOX}/提示块实测.md`;
/** t0 建的纯文本笔记，用来验阅读侧那道「整段没有 ::: 就跳过」的闸门真的在跳 */
const PLAIN_NOTE = `${SANDBOX}/说明.md`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY = [
  "# 提示块实测",
  "",
  "普通段落一行。",
  "",
  ":::tip 简单提示",
  "提示正文 **粗体**",
  "",
  "| 名称 | 数量 |",
  "| --- | --- |",
  "| 苹果 | 3 |",
  "",
  "### 小节标题",
  "",
  "- 项目一",
  "- 项目二",
  "",
  "> 引用一句",
  ":::",
  "",
  ":::warning- 默认收起",
  "折叠内容",
  ":::",
  "",
  ":::note 外层",
  "外层文字",
  ":::info 内层",
  "内层文字",
  ":::",
  ":::",
  "",
  ":::tip 尾块靶子",
  "将被删掉冒号",
  ":::",
  "",
].join("\n");

/** 页面侧助手：找带编辑器的目标视图 + 找可见的预览根 */
const INSTALL_HELPERS = (notePath) => {
  window.__notePath = notePath;
  window.__md = () => {
    const leaves = window.app.workspace.getLeavesOfType("markdown");
    for (const l of leaves) {
      const v = l.view;
      if (v?.editor?.cm && v?.file?.path === window.__notePath && v?.getMode?.() !== "preview") return v;
    }
    for (const l of leaves) if (l.view?.editor?.cm) return l.view;
    return null;
  };
  window.__pv = () => {
    for (const l of window.app.workspace.getLeavesOfType("markdown")) {
      const v = l.view;
      if (v?.getMode?.() === "preview") {
        const r = v?.previewMode?.containerEl;
        if (r && r.getBoundingClientRect().height > 0) return r;
      }
    }
    const all = [...document.querySelectorAll(".markdown-preview-view")];
    return all.find((e) => e.getBoundingClientRect().height > 0) || null;
  };
  return {
    装好了: typeof window.__md === "function" && typeof window.__pv === "function",
    找到编辑器视图: !!window.__md?.(),
  };
};

const LEAF_DIAG = () => JSON.stringify({
  markdownLeaf数: window.app.workspace.getLeavesOfType("markdown").length,
  有带编辑器的: !!window.__md?.(),
  活动文件: window.app.workspace.getActiveFile()?.path ?? null,
  可见预览根: !!window.__pv?.(),
  预览里的块: window.__pv?.() ? window.__pv().querySelectorAll(".admonition").length : null,
});

const ENSURE_NOTE = (path, body) =>
  (async () => {
    const v = window.app.vault;
    const old = v.getAbstractFileByPath(path);
    if (old) await v.trash(old, true);
    await v.create(path, body);
    return { 建成: !!v.getAbstractFileByPath(path) };
  })();

const DELETE_NOTE = (path) =>
  (async () => {
    const f = window.app.vault.getAbstractFileByPath(path);
    if (f) await window.app.vault.trash(f, true);
    return { 删干净: !window.app.vault.getAbstractFileByPath(path) };
  })();

/**
 * 轮询磁盘内容（Obsidian 从编辑器写盘是防抖的）。
 * 用「整行正则」而不是 includes —— 上一版用 includes("ip 尾块靶子")，
 * 结果被删了一半的 `:tip 尾块靶子` 也包含它，第一次轮询就误判成等到了。
 */
const WAIT_DISK = (path, lineRe) =>
  (async () => {
    const re = new RegExp(lineRe, "m");
    const t0 = Date.now();
    let text = null;
    let tries = 0;
    while (Date.now() - t0 < 10000) {
      const f = window.app.vault.getAbstractFileByPath(path);
      if (f) text = await window.app.vault.cachedRead(f);
      tries++;
      if (text && re.test(text)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    return { text, 轮询次数: tries };
  })();

const PROBE = () => {
  const p = window.app.plugins.plugins["kb-home"];
  const f = p?.features?.get?.("admonition");
  return JSON.stringify({
    有插件: !!p,
    装配失败: p?.features?.failures?.map((x) => x.id + ": " + x.error) ?? null,
    有功能: !!f,
    ed: f ? { ...f.editorProbe } : null,
    rd: f ? { ...f.readingProbe } : null,
    开关: p?.settings?.admonition ?? null,
  });
};

const OPEN_NOTE = (path) =>
  (async () => {
    await window.app.workspace.openLinkText(path, "", false);
    return true;
  })();

/**
 * 量一处提示块的字号层级。
 * 他报的是"标题很小、正文很大，很怪"——所以钉住三件事：
 * 正文不许大于标题；整块要比周围正文小一档；嵌套块不许叠乘越缩越小。
 */
const TYPE_SCALE = (source) => {
  // 同一篇笔记可能在多个标签页里（其中一个是隐藏的），隐藏的编辑器不布局、量到全是 0。
  // 所以扫所有 markdown leaf，挑"有尺寸的那个"，别只认第一个。
  const views = window.app.workspace
    .getLeavesOfType("markdown")
    .map((l) => l.view)
    .filter((v) => v?.file?.path === window.__notePath);
  const wantPreview = source === "预览";
  const view =
    views.find((v) =>
      wantPreview
        ? v?.getMode?.() === "preview"
        : v?.getMode?.() !== "preview" && v?.editor?.cm && v.containerEl.getBoundingClientRect().height > 0
    ) ?? (wantPreview ? window.__pv?.() : window.__md?.()?.containerEl);
  const root =
    wantPreview
      ? view?.previewMode?.containerEl ?? (view?.querySelector ? view : null)
      : view?.containerEl ?? view;
  if (!root) return { 没有根: true, 场景: source };
  const px = (el) => (el ? +parseFloat(getComputedStyle(el).fontSize).toFixed(2) : null);
  const adm = [...root.querySelectorAll(".admonition")].find(
    (e) => !e.parentElement?.closest(".admonition")
  );
  if (!adm) return { 没有块: true, 场景: source };
  const 参照 =
    source === "预览"
      ? [...root.querySelectorAll("p")].find(
          (e) => !e.closest(".admonition") && (e.textContent || "").trim().length > 4
        )
      : root.querySelector(".cm-content");
  const 内层正文 = adm.querySelector(".admonition .admonition-content p");
  const h = adm.querySelector(".admonition-heading");
  const c = adm.querySelector(".admonition-content");
  const first = c?.querySelector("p") || c?.firstElementChild;
  const 缝CSS = c ? parseFloat(getComputedStyle(c).marginTop) : null;
  return {
    场景: source,
    标题: px(h),
    正文: px(c),
    周围正文: px(参照),
    嵌套正文: px(内层正文),
    缝: h && first ? +(first.getBoundingClientRect().top - h.getBoundingClientRect().bottom).toFixed(1) : null,
    内边距: parseFloat(getComputedStyle(adm).paddingTop),
    // 规格钉在 CSS 计算值上：缝与下内边距是写死的 px，上内边距是 1rem（跟根字号走）
    缝CSS: 缝CSS === undefined || Number.isNaN(缝CSS) ? null : 缝CSS,
    下内边距: parseFloat(getComputedStyle(adm).paddingBottom),
    根字号: parseFloat(getComputedStyle(document.documentElement).fontSize),
  };
};

/**
 * 另开一个 leaf 来测阅读视图。
 * 实测顺序很关键：先 openFile，再 setViewState({state:{mode:'preview', file}}) 才切得出预览
 * （反过来的话 openFile 会把模式冲回 source）。preview 根取 previewMode.containerEl。
 */
const OPEN_PREVIEW = (path) =>
  (async () => {
    const ws = window.app.workspace;
    const leaf = ws.getLeaf("split", "vertical");
    if (!leaf) return { ok: false, reason: "getLeaf 返回空" };
    const f = window.app.vault.getAbstractFileByPath(path);
    if (!f) return { ok: false, reason: "笔记不在 vault 里" };
    await leaf.openFile(f);
    await leaf.setViewState({ type: "markdown", active: true, state: { mode: "preview", file: path } });
    const v = leaf.view;
    const r = v?.previewMode?.containerEl;
    window.__previewLeaf = leaf;
    return {
      ok: true,
      模式: String(v?.getMode?.()),
      有预览容器: !!r,
      预览容器高: r ? Math.round(r.getBoundingClientRect().height) : null,
      预览里的块: r ? r.querySelectorAll(".admonition").length : null,
    };
  })();

/**
 * 关掉预览 leaf，并顺手清掉 empty 空叶。
 * 教训：探针在主区留下的多余 leaf 会把卡片墙挤窄（实测挤到 170px），
 * 让 t5 这种依赖视口几何的用例出现**假 FAIL**。收尾必须真的清干净。
 */
const CLOSE_PREVIEW = () => {
  const closed = [];
  for (const l of [...window.app.workspace.getLeavesOfType("markdown")]) {
    if (l.view?.getMode?.() === "preview") {
      closed.push(l.view?.file?.path ?? "?");
      l.detach();
    }
  }
  for (const l of [...window.app.workspace.getLeavesOfType("empty")]) {
    closed.push("(empty)");
    l.detach();
  }
  window.__previewLeaf = null;
  return { 关掉的: closed, 还有可见预览: !!window.__pv?.() };
};

const FIND_LINE = (needle) => {
  const view = window.__md?.();
  const doc = view?.editor?.cm?.state.doc;
  if (!doc) return null;
  for (let i = 1; i <= doc.lines; i++) {
    const l = doc.line(i);
    if (l.text.includes(needle)) return { line: i, from: l.from, text: l.text };
  }
  return null;
};

const GOTO = (pos) => {
  const cm = window.__md?.()?.editor?.cm;
  if (!cm) return false;
  cm.dispatch({ selection: { anchor: pos, head: pos } });
  cm.focus();
  return true;
};

/** 编辑器里画出来的块。嵌套块嵌在外层里面，所以顶层与总数分开数 */
const CM_BLOCKS = () => {
  // 必须限定在"目标笔记那个编辑器"里量：用 document 全局查会把用户另外打开的
  // 笔记里的提示块也算进来（实测就被他一篇含 :::tip 的笔记污染过一次，凭空多一块）
  const view = window.__md?.();
  const scope = view?.containerEl ?? document;
  const all = [...scope.querySelectorAll(".cm-content .admonition")];
  const top = all.filter((e) => !e.parentElement?.closest(".admonition"));
  return JSON.stringify({
    顶层: top.length,
    总数: all.length,
    标题: top.map((e) => e.querySelector(".admonition-heading-text")?.textContent ?? null),
    类型: top.map((e) => e.getAttribute("data-admonition-type")),
    量的是哪篇: view?.file?.path ?? null,
    源码可见: (scope.querySelector(".cm-content")?.textContent || "").includes(":::tip 简单提示"),
  });
};

const PV_BLOCKS = () => {
  const root = window.__pv?.();
  if (!root) return JSON.stringify({ 顶层: -1, 总数: -1, 没有可见预览根: true });
  const all = [...root.querySelectorAll(".admonition")];
  const top = all.filter((e) => !e.parentElement?.closest(".admonition"));
  const tip = top.find((e) => e.getAttribute("data-admonition-type") === "tip");
  const box = tip?.querySelector(".admonition-content");
  return JSON.stringify({
    顶层: top.length,
    总数: all.length,
    收起的: all.filter((e) => e.classList.contains("is-collapsed")).map((e) => e.getAttribute("data-admonition-type")),
    嵌套在内: !!root.querySelector(".admonition-note .admonition-info"),
    有尾块: all.some((e) => (e.querySelector(".admonition-heading-text")?.textContent || "").includes("尾块靶子")),
    框内有表格: !!box?.querySelector("table"),
    表格总数: root.querySelectorAll("table").length,
    表格内容在框里: (box?.querySelector("table")?.textContent || "").includes("苹果"),
    框内有小节标题: !!box?.querySelector("h3"),
    框内有列表: !!box?.querySelector("ul"),
    框内有引用: !!box?.querySelector("blockquote"),
    框外残留表格: [...root.children].filter((e) => e.tagName === "TABLE").length,
    间距: (() => {
      const h = tip?.querySelector(".admonition-heading");
      const c = tip?.querySelector(".admonition-content");
      if (!h || !c) return null;
      const cs = getComputedStyle(tip);
      return {
        缝: +(c.getBoundingClientRect().top - h.getBoundingClientRect().bottom).toFixed(1),
        框内边距: +parseFloat(cs.paddingTop).toFixed(1),
        缝CSS: parseFloat(getComputedStyle(c).marginTop),
        下内边距: parseFloat(cs.paddingBottom),
        根字号: parseFloat(getComputedStyle(document.documentElement).fontSize),
        gap: cs.rowGap,
      };
    })(),
    折叠标题矩形: (() => {
      const h = root.querySelector(".admonition-warning .admonition-heading");
      if (!h) return null;
      // 老规矩：先滚进可视区再量坐标，否则量到的位置可能在视口外，点击落空
      h.scrollIntoView({ block: "center" });
      const r = h.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })(),
  });
};

/**
 * 开关测试：把功能自己的 renderSettings 挂进主文档的一个浮层里，然后点真实开关。
 * 之所以不点设置 modal —— 本机 Obsidian 把设置开成独立窗口，主文档里没有它。
 */
const MOUNT_SETTINGS = () => {
  const p = window.app.plugins.plugins["kb-home"];
  document.getElementById("kb-adm-test-host")?.remove();
  const host = document.createElement("div");
  host.id = "kb-adm-test-host";
  host.setAttribute(
    "style",
    "position:fixed;left:12px;bottom:12px;width:560px;height:360px;z-index:99999;overflow:auto;background:var(--background-primary);border:1px solid #666;padding:8px"
  );
  document.body.appendChild(host);
  const f = p.features.get("admonition");
  const ctx = {
    app: window.app,
    settings: () => p.settings,
    save: () => p.saveSettingsNow(),
    refreshViews: () => {},
    registerEditorExtension: () => {},
    registerMarkdownPostProcessor: () => {},
    registerEvent: () => {},
    addCommand: () => {},
  };
  f.renderSettings(host, ctx);
  return JSON.stringify({
    挂上了: host.querySelectorAll(".setting-item").length,
    开关数: host.querySelectorAll(".checkbox-container").length,
    提示文字在: host.textContent.includes(":::tip"),
  });
};

const UNMOUNT_SETTINGS = () => {
  document.getElementById("kb-adm-test-host")?.remove();
  return JSON.stringify({ 清掉了: !document.getElementById("kb-adm-test-host") });
};

const TOGGLE_OF = (name) => {
  const host = document.getElementById("kb-adm-test-host");
  const item = [...(host?.querySelectorAll(".setting-item") || [])].find(
    (s) => s.querySelector(".setting-item-name")?.textContent?.trim() === name
  );
  if (!item) return JSON.stringify({ found: false });
  const sw = item.querySelector(".checkbox-container");
  if (!sw) return JSON.stringify({ found: true, hasSwitch: false });
  const r = sw.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    hasSwitch: true,
    on: sw.classList.contains("is-checked"),
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
  });
};

/** 设置页有没有把本插件那一节注册上（真正渲染在独立窗口里，这里只查注册） */
const SETTINGS_TAB_REGISTERED = () => {
  const s = window.app.setting;
  const ids = [...(s?.pluginTabs || []), ...(s?.settingTabs || [])].map(
    (t) => t?.id ?? t?.plugin?.manifest?.id ?? null
  );
  return JSON.stringify({ 有kb_home: ids.includes("kb-home"), 全部: ids.slice(0, 20) });
};

async function waitReady(ctx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await ctx.page(READY);
    if (r.新文档 && r.ready) return r;
    await sleep(700);
  }
  throw new Error("等待重载后的新文档超时");
}

/** 页面侧函数一律返回 JSON 字符串，免得 Obsidian 对象把 CDP 序列化撑爆 */
async function ask(ctx, fn, ...args) {
  const raw = await ctx.page(fn, ...args);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function waitFor(ctx, fn, pred, ms = 6000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await ask(ctx, fn);
    if (pred(last)) return last;
    await sleep(300);
  }
  return last;
}

export default async (ctx) => {
  const rep = {};
  const checks = [];
  const add = (name, pass, detail) =>
    checks.push({ 检查: name, 结论: pass ? "PASS" : "FAIL", ...(detail ? { 证据: detail } : {}) });
  ctx.progress.push(rep);

  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.就绪 = await waitReady(ctx);

  rep.建笔记 = await ctx.page(ENSURE_NOTE, NOTE, BODY);
  add("沙箱笔记创建成功", rep.建笔记.建成 === true, rep.建笔记);

  await ctx.page(OPEN_NOTE, NOTE);
  await sleep(1000);
  rep.装配 = await ask(ctx, PROBE);
  add(
    "A0 底座装配：无失败功能且提示块已挂上",
    rep.装配.有插件 && rep.装配.有功能 && (rep.装配.装配失败 ?? []).length === 0,
    rep.装配
  );

  rep.助手 = await ctx.page(INSTALL_HELPERS, NOTE);
  rep.叶子诊断 = await ask(ctx, LEAF_DIAG);
  add("编辑器视图可用（挑到了带 editor.cm 的那个）", rep.助手.找到编辑器视图 === true, rep.叶子诊断);

  // ---------- A1 渲染出块 ----------
  rep.块 = await waitFor(ctx, CM_BLOCKS, (r) => r.顶层 >= 3);
  add(
    "A1 实时预览：顶层 4 块、嵌套 info 在 note 里（DOM 共 5 个），且不显示源码",
    rep.块.量的是哪篇 === NOTE &&
      rep.块.顶层 === 4 &&
      rep.块.总数 === 5 &&
      !rep.块.源码可见,
    rep.块
  );

  // 实时预览这一路单独量一次字号：编辑器里正文字号由 .cm-content 决定，
  // 历史上这里还盖过一条"把正文设回 16px"的规则，必须单独钉住
  // 间距规格（用户 2026-10-11 定）：标题→正文的缝 5px、正文→块底 12px、块上内边距 1rem。
  // 钉在 CSS 计算值上而不是渲染缝上：渲染缝里含行高余量，字号一改就会漂。
  const 间距规格 = (m, 上内边距键) =>
    m &&
    m.缝CSS === 5 &&
    m.下内边距 === 12 &&
    Math.abs(m[上内边距键] - m.根字号) < 0.5 &&
    m.缝 !== null &&
    m.缝 > 0 &&
    m.缝 < m[上内边距键];
  rep.字号层级_编辑器 = await ctx.page(TYPE_SCALE, "编辑器");
  add(
    "A1b 实时预览：正文不大于标题、整块比周围小一档、嵌套不叠乘；间距按规格（缝 5px、正文到块底 12px、上内边距 1rem）",
    rep.字号层级_编辑器.正文 !== null &&
      rep.字号层级_编辑器.正文 <= rep.字号层级_编辑器.标题 &&
      rep.字号层级_编辑器.正文 < rep.字号层级_编辑器.周围正文 &&
      rep.字号层级_编辑器.嵌套正文 === rep.字号层级_编辑器.正文 &&
      间距规格(rep.字号层级_编辑器, "内边距"),
    rep.字号层级_编辑器
  );

  // ---------- A2 在普通行打字：应走便宜路径 ----------
  const plainLine = await ctx.page(FIND_LINE, "普通段落一行");
  if (!plainLine) {
    add("A2 找不到普通段落行（编辑器没抓到）", false, { plainLine, 诊断: rep.叶子诊断 });
  } else {
    await ctx.page(GOTO, plainLine.from + plainLine.text.length);
    await sleep(250);
    const before = await ask(ctx, PROBE);
    await ctx.type("补充文字");
    await sleep(500);
    const after = await ask(ctx, PROBE);
    rep.打字探针 = {
      scanAll: after.ed.scanAll - before.ed.scanAll,
      reuse: after.ed.reuse - before.ed.reuse,
      fromCache: after.ed.fromCache - before.ed.fromCache,
    };
    add(
      "A2 普通行打字：沿用缓存(reuse>0) 且不全文重扫(scanAll=0)",
      rep.打字探针.reuse >= 1 && rep.打字探针.scanAll === 0,
      rep.打字探针
    );
    const still = await ask(ctx, CM_BLOCKS);
    add("A2b 打字后顶层块仍是 4 个", still.顶层 === 4, still);
  }

  // ---------- A3 光标进块 → 回退源码 ----------
  const bodyLine = await ctx.page(FIND_LINE, "提示正文");
  if (bodyLine) {
    await ctx.page(GOTO, bodyLine.from + 2);
    await sleep(500);
    rep.进块 = await ask(ctx, CM_BLOCKS);
    add(
      "A3 光标进入 tip 块内：顶层只剩 3 块且该行显示源码",
      rep.进块.顶层 === 3 && rep.进块.总数 === 4 && rep.进块.源码可见,
      rep.进块
    );
  } else add("A3 找不到块正文行", false, bodyLine);

  // ---------- A4 移出块 → 重新渲染且不重扫 ----------
  if (plainLine) {
    const before = await ask(ctx, PROBE);
    await ctx.page(GOTO, plainLine.from + 3);
    await sleep(500);
    const after = await ask(ctx, PROBE);
    rep.出块探针 = {
      scanAll: after.ed.scanAll - before.ed.scanAll,
      fromCache: after.ed.fromCache - before.ed.fromCache,
      reuse: after.ed.reuse - before.ed.reuse,
    };
    const now = await ask(ctx, CM_BLOCKS);
    add(
      "A4 光标移出块：顶层画回 4 块，且只按缓存重算（scanAll=0、fromCache>=1）",
      now.顶层 === 4 && rep.出块探针.scanAll === 0 && rep.出块探针.fromCache >= 1,
      { ...rep.出块探针, 顶层: now.顶层, 总数: now.总数 }
    );
  }

  // ---------- A5 靶子：删掉起始行的冒号 ----------
  const tail = await ctx.page(FIND_LINE, ":::tip 尾块靶子");
  if (tail) {
    // 每键之前重新聚焦并把光标放回行首：块消失会重建 DOM、焦点跟着丢
    const 按了 = [];
    for (let i = 0; i < 4; i++) {
      await ctx.page(GOTO, tail.from);
      await sleep(120);
      await ctx.key("Delete", "Delete", 46);
      await sleep(150);
      按了.push((await ctx.page(FIND_LINE, "尾块靶子"))?.text ?? null);
    }
    rep.逐次删除 = 按了;

    const before = await ask(ctx, PROBE);
    await ctx.page(GOTO, plainLine ? plainLine.from + 3 : 0); // 移出这块，逼它重新装饰
    await sleep(600);
    const after = await ask(ctx, PROBE);
    rep.删冒号 = await ask(ctx, CM_BLOCKS);
    rep.删冒号探针 = {
      scanAll: after.ed.scanAll - before.ed.scanAll,
      reuse: after.ed.reuse - before.ed.reuse,
    };
    add(
      "A5 删掉起始行 4 个字符后：顶层降为 3，旧块没有赖着不走",
      rep.删冒号.顶层 === 3 && !rep.删冒号.标题.some((t) => (t || "").includes("尾块靶子")),
      { ...rep.删冒号, ...rep.删冒号探针 }
    );

    const disk = await ask(ctx, WAIT_DISK, NOTE, "^ip 尾块靶子$");
    rep.删冒号源码 = { 轮询次数: disk.轮询次数, 相关行: (disk.text || "").split("\n").filter((l) => l.includes("尾块靶子")) };
    add(
      "A5b 起始行被删到不成标记（磁盘上整行应为「ip 尾块靶子」）",
      /^ip 尾块靶子$/m.test(disk.text || "") && !/:{3,}\s*tip\s*尾块靶子/.test(disk.text || ""),
      rep.删冒号源码
    );
  } else {
    add("A5 找不到尾块起始行", false, { tail, 诊断: rep.叶子诊断 });
  }

  // ---------- A6/A7 阅读视图（另开预览 leaf） ----------
  rep.阅读前探针 = await ask(ctx, PROBE);
  rep.开预览 = await ask(ctx, OPEN_PREVIEW, NOTE);
  await sleep(1200);
  rep.预览 = await waitFor(ctx, PV_BLOCKS, (r) => r.顶层 >= 3, 9000);
  add(
    "A6 阅读视图：顶层 3 块、嵌套 info 在 note 里（共 4 个）、warning 默认收起、尾块不再成框",
    rep.预览.顶层 === 3 &&
      rep.预览.总数 === 4 &&
      rep.预览.嵌套在内 === true &&
      rep.预览.有尾块 === false &&
      rep.预览.收起的.includes("warning"),
    { 开预览: rep.开预览, 预览: rep.预览 }
  );
  // 限制钉子（记的是"现在确实还这样"，不是"应该这样"）：
  // 后处理器是按段(section)调用的，空行会把 :::tip 标记和它下面的表格切进两次调用，
  // 而我们每次的"当前框"栈都是新的 → 表格进不了框，只能留在框外。
  // 修法是跨段传递未闭合的块（并核对文件源码里到底有没有对应的闭合，防止打错的 :::tip 吞掉整篇）。
  // 哪天修好了，这条会转红 —— 那时请连同 README「已知限制」一起删掉。
  add(
    "A6limit 已知限制：块内表格跨段所以留在框外（修好后此条应转红并更新 README）",
    rep.预览.表格总数 > 0 && rep.预览.框内有表格 === false,
    { 表格总数: rep.预览.表格总数, 框内有表格: rep.预览.框内有表格, 顶层: rep.预览.顶层, 总数: rep.预览.总数 }
  );

  rep.字号层级_预览 = await ctx.page(TYPE_SCALE, "预览");
  add(
    "A6c 阅读视图：正文不大于标题、整块比周围小一档、嵌套不叠乘；间距按规格（缝 5px、正文到块底 12px、上内边距 1rem）",
    rep.字号层级_预览.标题 !== null &&
      rep.字号层级_预览.正文 <= rep.字号层级_预览.标题 &&
      rep.字号层级_预览.正文 < rep.字号层级_预览.周围正文 &&
      rep.字号层级_预览.嵌套正文 === rep.字号层级_预览.正文 &&
      间距规格(rep.字号层级_预览, "内边距"),
    rep.字号层级_预览
  );

  add(
    "A6b 间距规格在阅读视图成立：缝 5px、正文到块底 12px、上内边距 1rem（改动 styles.css 时会转红）",
    !!rep.预览.间距 && 间距规格(rep.预览.间距, "框内边距"),
    rep.预览.间距
  );

  // 判红自检：钉住的是实测值不是常量——把缝临时改成 16px，量到的必须跟着变 16，
  // 撤掉内联样式后再回到样式表的 5。否则这条规格断言就是假的。
  const 能判红 = await ctx.page(() => {
    const c = document.querySelector(".admonition .admonition-content");
    if (!c) return { 有对象: false };
    const 原 = c.style.marginTop;
    c.style.marginTop = "16px";
    const 改后 = parseFloat(getComputedStyle(c).marginTop);
    c.style.marginTop = 原 || "";
    return { 有对象: true, 改后, 改回: parseFloat(getComputedStyle(c).marginTop) };
  });
  add(
    "间距规格能判红：内联改成 16px 后实测跟着变 16，撤掉后回到样式表的 5",
    能判红.有对象 === true && 能判红.改后 === 16 && 能判红.改回 === 5,
    能判红
  );

  if (rep.预览.折叠标题矩形) {
    const 收起前 = rep.预览.收起的.includes("warning");
    const p = rep.预览.折叠标题矩形;
    await ctx.move(p.x, p.y);
    await sleep(200);
    await ctx.click(p.x, p.y);
    await sleep(500);
    const 展开后 = await ask(ctx, PV_BLOCKS);
    add(
      "A7 :::warning- 默认收起，点标题能展开",
      收起前 === true && !展开后.收起的.includes("warning"),
      { 收起前, 展开后: 展开后.收起的 }
    );
  } else {
    add("A7 找不到可折叠块的标题", false, rep.预览);
  }

  // ---------- A8 阅读闸门：拿一篇完全没有 ::: 的笔记来验它到底跳没跳 ----------
  // 提示块那篇里几乎每段都含 :::，用它测不出闸门；说明.md 是 t0 建的纯文本笔记。
  rep.关提示块预览 = await ask(ctx, CLOSE_PREVIEW);
  rep.闸门前探针 = await ask(ctx, PROBE);
  rep.开预览纯文本 = await ask(ctx, OPEN_PREVIEW, PLAIN_NOTE);
  await sleep(1300);
  const plainPv = await ask(ctx, PV_BLOCKS);
  const after = await ask(ctx, PROBE);
  rep.闸门增量 = {
    seen: after.rd.sectionsSeen - rep.闸门前探针.rd.sectionsSeen,
    skipped: after.rd.sectionsSkipped - rep.闸门前探针.rd.sectionsSkipped,
    infoNull: after.rd.sectionInfoNull - rep.闸门前探针.rd.sectionInfoNull,
  };
  add(
    "A8 无 ::: 的笔记：每个段都被闸门跳过（skipped>0 且等于 seen）",
    rep.闸门增量.skipped > 0 && rep.闸门增量.skipped === rep.闸门增量.seen,
    { ...rep.闸门增量, 纯文本预览里的块: plainPv.顶层 }
  );
  rep.关纯文本预览 = await ask(ctx, CLOSE_PREVIEW);
  add(
    "预览 leaf 都能关干净（不留残叶影响后续断言）",
    rep.关提示块预览.还有可见预览 === false && rep.关纯文本预览.还有可见预览 === false,
    { 第一次: rep.关提示块预览, 第二次: rep.关纯文本预览 }
  );

  // ---------- A9/A10 两个开关（在主文档里挂载同一渲染函数后点真实开关） ----------
  rep.挂载 = await ask(ctx, MOUNT_SETTINGS);
  add(
    "A9a renderSettings 渲染出两个开关与用法说明",
    rep.挂载.挂上了 === 2 && rep.挂载.开关数 === 2 && rep.挂载.提示文字在 === true,
    rep.挂载
  );
  rep.tab注册 = await ask(ctx, SETTINGS_TAB_REGISTERED);
  add("A9b 本插件的设置页确实注册进了 Obsidian 的设置列表", rep.tab注册.有kb_home === true, rep.tab注册);

  const t1 = await ask(ctx, TOGGLE_OF, "实时预览中渲染");
  if (t1.hasSwitch) {
    await ctx.click(t1.x, t1.y);
    await sleep(700);
    const off = await ask(ctx, CM_BLOCKS);
    const st = await ask(ctx, PROBE);
    const t1b = await ask(ctx, TOGGLE_OF, "实时预览中渲染");
    await ctx.click(t1b.x, t1b.y);
    await sleep(700);
    const on = await ask(ctx, CM_BLOCKS);
    add(
      "A9 关掉「实时预览中渲染」→ 编辑器不画块且设置落盘；开回来 → 顶层恢复 3 块",
      off.顶层 === 0 && st.开关.inEditor === false && on.顶层 === 3,
      { 关后顶层: off.顶层, 设置: st.开关, 开回顶层: on.顶层, 开关初值: t1.on }
    );
  } else {
    add("A9 找不到「实时预览中渲染」的开关", false, t1);
  }

  // 阅读开关：再开一次预览 leaf 来验
  rep.开预览2 = await ask(ctx, OPEN_PREVIEW, NOTE);
  await sleep(1000);
  const pvBefore = await ask(ctx, PV_BLOCKS);
  const t2 = await ask(ctx, TOGGLE_OF, "阅读视图渲染");
  if (t2.hasSwitch) {
    await ctx.click(t2.x, t2.y);
    await sleep(800);
    const pvOff = await ask(ctx, PV_BLOCKS);
    const t2b = await ask(ctx, TOGGLE_OF, "阅读视图渲染");
    await ctx.click(t2b.x, t2b.y);
    await sleep(800);
    const pvOn = await ask(ctx, PV_BLOCKS);
    add(
      "A10 关掉「阅读视图渲染」→ 预览不画块；开回来 → 数量复原",
      pvOff.顶层 === 0 && pvOn.顶层 === pvBefore.顶层,
      { 关前: pvBefore.顶层, 关后: pvOff.顶层, 开回: pvOn.顶层 }
    );
  } else {
    add("A10 找不到「阅读视图渲染」的开关", false, t2);
  }

  // ---------- 收尾 ----------
  await ask(ctx, CLOSE_PREVIEW);
  rep.卸载挂载 = await ask(ctx, UNMOUNT_SETTINGS);
  rep.删除笔记 = await ctx.page(DELETE_NOTE, NOTE);
  add("收尾：测试笔记已删除、浮层已撤", rep.删除笔记.删干净 === true && rep.卸载挂载.清掉了 === true, {
    笔记: rep.删除笔记,
    浮层: rep.卸载挂载,
  });

  const finalProbe = await ask(ctx, PROBE);
  rep.最终探针 = finalProbe;
  add(
    "收尾：开关回到默认（两个都开）、装配仍无失败",
    finalProbe.开关?.inEditor === true && finalProbe.开关?.inReading === true && (finalProbe.装配失败 ?? []).length === 0,
    { 开关: finalProbe.开关, ed: finalProbe.ed, rd: finalProbe.rd }
  );

  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length} PASS / ${checks.filter((c) => c.结论 === "FAIL").length} FAIL`;
  rep.失败项 = checks.filter((c) => c.结论 === "FAIL");
  return rep;
};
