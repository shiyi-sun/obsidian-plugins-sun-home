/*
菜单卫生 + 卸载清理 + 分组右键菜单/删除确认。
覆盖 1.3.5 的三处改动：B3 菜单自给自足、destroy() 撕痕迹、分组删除二次确认。
*/
import { READY, MARK_RELOAD, SHOW_EXPLORER, EXPAND_CHAIN, NATIVE_ROW } from "./lib.mjs";

const SANDBOX = "__kb自测__";
const FILE = `${SANDBOX}/根笔记1.md`;
const FOLDER = `${SANDBOX}/子文件夹A`;
const GROUP = "菜单验证组";
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

const ITEMS = () =>
  [...document.querySelectorAll(".menu .menu-item")].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      text: el.querySelector(".menu-item-title")?.textContent ?? "",
      图标: el.querySelector(".menu-item-icon svg")?.getAttribute("class")?.replace("svg-icon lucide-", "") ?? null,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });

const TREE_ROW = (p) => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  if (view?.getViewType?.() !== "kb-tree-view") return null;
  const el = view.containerEl.querySelector(`.kb-tree-body .tree-item-self[data-path="${p}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
};

const dupes = (items) => {
  const seen = {};
  for (const i of items) seen[i.text] = (seen[i.text] || 0) + 1;
  return Object.entries(seen).filter(([, n]) => n > 1).map(([t, n]) => `${t}×${n}`);
};

const MARKS = () => ({
  kb隐藏类: document.querySelectorAll(".kb-hidden").length,
  指示器节点: document.querySelectorAll(".kb-indicator").length,
  浏览器行数: document.querySelectorAll(
    '[data-type="file-explorer"] .nav-file-title, [data-type="file-explorer"] .nav-folder-title'
  ).length,
  树面板在: !!document.querySelector(".kb-tree-container"),
  卡片墙在: !!document.querySelector(".kb-home-container"),
});

const MODAL = () => {
  const m = document.querySelector(".modal");
  if (!m) return null;
  return {
    title: m.querySelector("h3")?.textContent ?? m.querySelector(".modal-title")?.textContent ?? null,
    body: m.querySelector("p")?.textContent ?? null,
    buttons: [...m.querySelectorAll("button")].map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }),
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

  const card = await ctx.page((box) => {
    const el = [...document.querySelectorAll(".kb-card")].find((c) => c.dataset.path === box);
    el?.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, SANDBOX);
  if (!card.x) return { ...rep, FAIL: "沙箱卡片不存在" };
  await ctx.click(card.x, card.y);
  await sleep(600);

  // 归一化前提：把该文件的置顶态清掉（上一轮若中断会残留，改变菜单文案）
  await ctx.page((p) => {
    const st = window.app.plugins.plugins["sun-home"].settings.order;
    if (st.items[p]) st.items[p].isPinned = false;
    return st.items[p] ? "已重置" : "无记录";
  }, FILE);
  await sleep(300);

  // ---------- 1. 文件右键菜单：无同名重复，且各项都是插件自己提供的 ----------
  const row = await ctx.page(TREE_ROW, FILE);
  await ctx.click(row.x, row.y, "right");
  await sleep(500);
  const fileMenu = await ctx.page(ITEMS);
  rep.文件菜单 = fileMenu.map((i) => `${i.text}[${i.图标}]`);
  add("文件右键菜单没有同名重复项", dupes(fileMenu).length === 0, rep.文件菜单);
  add(
    "文件菜单只保留插件自己的条目 + 置顶/隐藏（Obsidian 的注入项已不再出现）",
    ["打开", "在新标签页打开", "重命名", "删除", "复制路径", "在系统资源管理器中显示", "置顶", "隐藏"].every((t) =>
      rep.文件菜单.some((x) => x.startsWith(t + "["))
    ) && !rep.文件菜单.some((x) => x.startsWith("使用默认应用打开")) && !rep.文件菜单.some((x) => x.startsWith("将文件移动到")),
    rep.文件菜单
  );

  // 复制路径：唯一一条，且真的能复制
  await ctx.page(() => navigator.clipboard.writeText("SENTINEL-keep").then(() => true));
  const cp = fileMenu.find((i) => i.text === "复制路径");
  await ctx.click(Math.round(cp.x + cp.w / 2), Math.round(cp.y + cp.h / 2));
  await sleep(700);
  const clip = await ctx.page(() => navigator.clipboard.readText().then((t) => t).catch((e) => "ERR:" + e.name));
  add("「复制路径」点了真能复制到库内路径", clip === FILE, { 剪贴板: clip, 期望: FILE });

  // ---------- 2. 置顶：在插件树菜单点「置顶」→ 到原生面板验图钉 → 在原生菜单里取消 ----------
  const row3 = await ctx.page(TREE_ROW, FILE);
  if (!row3) add("置顶用例：插件树行找不到（面板未渲染）", false);
  await ctx.click(row3.x, row3.y, "right");
  await sleep(500);
  const pinItem = (await ctx.page(ITEMS)).find((i) => i.text === "置顶");
  if (pinItem) {
    await ctx.click(Math.round(pinItem.x + pinItem.w / 2), Math.round(pinItem.y + pinItem.h / 2));
    await sleep(800);
  } else add("插件树菜单里没有「置顶」", false, (await ctx.page(ITEMS)).map((i) => i.text));

  // 图钉挂在原生树的行上，把原生面板切到前台再验（左栏同一时刻只渲染一个面板）
  await ctx.page(() => {
    const ws = window.app.workspace;
    const leaf = ws.getLeavesOfType("file-explorer")[0];
    if (ws.leftSplit?.collapsed) ws.leftSplit.expand();
    ws.revealLeaf(leaf);
    return true;
  });
  await sleep(1200);
  await ctx.page(EXPAND_CHAIN, FILE);
  await sleep(900);
  const pinned = await ctx.page((p) => {
    const s = window.app.plugins.plugins["sun-home"].settings.order.items[p];
    const row = document.querySelector(`.nav-file-title[data-path="${p}"]`);
    return { isPinned: s?.isPinned ?? null, 图钉: !!row?.querySelector(".kb-pin-indicator"), 行在: !!row };
  }, FILE);
  add("插件树菜单里的「置顶」生效（写盘 + 原生行挂上图钉）", pinned.isPinned === true && pinned.图钉 === true, pinned);

  // 在原生树的右键菜单里取消置顶（两处共用同一套菜单逻辑）
  await ctx.page(EXPAND_CHAIN, FILE);
  await sleep(900);
  const nrow = await ctx.page(NATIVE_ROW, FILE);
  if (nrow) {
    await ctx.click(nrow.x, nrow.y, "right");
    await sleep(500);
    const unpin = (await ctx.page(ITEMS)).find((i) => i.text === "取消置顶");
    if (unpin) {
      await ctx.click(Math.round(unpin.x + unpin.w / 2), Math.round(unpin.y + unpin.h / 2));
      await sleep(900);
    }
    const unpinned = await ctx.page((p) => {
      const s = window.app.plugins.plugins["sun-home"].settings.order.items[p];
      const row = document.querySelector(`.nav-file-title[data-path="${p}"]`);
      return { isPinned: s?.isPinned ?? null, 图钉: !!row?.querySelector(".kb-pin-indicator") };
    }, FILE);
    add("「取消置顶」在原生菜单里同样生效", unpinned.isPinned === false && unpinned.图钉 === false, unpinned);
  } else add("原生树里找不到该文件行", false);

  // 文件夹菜单（重新点卡片把插件树切回前台）
  const card2 = await ctx.page((box) => {
    const el = [...document.querySelectorAll(".kb-card")].find((c) => c.dataset.path === box);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, SANDBOX);
  if (card2) {
    await ctx.click(card2.x, card2.y);
    await sleep(700);
  }
  const frow = await ctx.page(TREE_ROW, FOLDER);
  await ctx.click(frow.x, frow.y, "right");
  await sleep(450);
  const folderMenu = await ctx.page(ITEMS);
  rep.文件夹菜单 = folderMenu.map((i) => `${i.text}[${i.图标}]`);
  add("文件夹右键菜单没有同名重复项", dupes(folderMenu).length === 0, rep.文件夹菜单);
  add(
    "文件夹菜单含 新建笔记/新建文件夹/重命名/删除/折叠/排序方式/置顶/隐藏",
    ["新建笔记", "新建文件夹", "重命名", "删除", "排序方式", "置顶", "隐藏"].every((t) => rep.文件夹菜单.some((x) => x.startsWith(t + "["))) &&
      rep.文件夹菜单.some((x) => x.startsWith("折叠此文件夹") || x.startsWith("展开此文件夹")),
    rep.文件夹菜单
  );
  await ctx.page(() => (document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true));
  await sleep(300);

  // ---------- 2. 卸载清理：kb-hidden / kb-indicator 归零，重新启用后恢复 ----------
  // 前提必须自己造：藏起本用例的沙箱文件，而不是指望用户库里恰好有个隐藏项
  // 正好渲染在屏幕上（之前就是靠运气过，滚动/折叠状态一变就假红）。
  await ctx.page(() => {
    const ws = window.app.workspace;
    const leaf = ws.getLeavesOfType("file-explorer")[0];
    if (ws.leftSplit?.collapsed) ws.leftSplit.expand();
    ws.revealLeaf(leaf);
    return true;
  });
  await sleep(900);
  await ctx.page(EXPAND_CHAIN, FILE);
  await sleep(700);
  const hrow = await ctx.page(NATIVE_ROW, FILE);
  if (hrow) {
    await ctx.click(hrow.x, hrow.y, "right");
    await sleep(500);
    const hideItem = (await ctx.page(ITEMS)).find((i) => i.text === "隐藏");
    if (hideItem) {
      await ctx.click(Math.round(hideItem.x + hideItem.w / 2), Math.round(hideItem.y + hideItem.h / 2));
      await sleep(1100);
    } else add("原生文件菜单里没有「隐藏」项", false, rep.文件菜单);
  } else add("隐藏这一步：原生树里找不到沙箱文件行", false, hrow);

  const HIDDEN_ROW = (p) => {
    const title = document.querySelector(
      `.nav-file-title[data-path="${p}"], .nav-folder-title[data-path="${p}"]`
    );
    const wrap = title?.closest(".nav-file, .nav-folder");
    return {
      行在: !!title,
      外层class: wrap?.className ?? null,
      kb隐藏: !!wrap?.classList.contains("kb-hidden"),
      设置: window.app.plugins.plugins["sun-home"].settings.order.items[p]?.isHidden ?? null,
    };
  };
  const hiddenNow = await ctx.page(HIDDEN_ROW, FILE);
  const beforeMarks = await ctx.page(MARKS);
  rep.禁用前 = { marks: beforeMarks, 隐藏行: hiddenNow };
  add(
    "前提成立：沙箱文件已隐藏，其原生行挂着 kb-hidden",
    hiddenNow.设置 === true && hiddenNow.kb隐藏 === true && beforeMarks.kb隐藏类 >= 1,
    rep.禁用前
  );

  await ctx.page(() => window.app.plugins.disablePlugin("sun-home"));
  await sleep(1600);
  const afterDisable = await ctx.page(MARKS);
  rep.禁用后 = afterDisable;
  add("禁用插件后 DOM 里不再有 kb-hidden 残留", afterDisable.kb隐藏类 === 0, afterDisable);
  add("禁用插件后 DOM 里不再有图钉指示器节点", afterDisable.指示器节点 === 0, afterDisable);
  add("禁用后本插件的两个面板都已摘除", afterDisable.树面板在 === false && afterDisable.卡片墙在 === false, afterDisable);

  await ctx.page(() => window.app.plugins.enablePlugin("sun-home"));
  await sleep(2200);
  await ctx.page(() => {
    const ws = window.app.workspace;
    const leaf = ws.getLeavesOfType("file-explorer")[0];
    if (ws.leftSplit?.collapsed) ws.leftSplit.expand();
    ws.revealLeaf(leaf);
    return true;
  });
  await sleep(1200);
  const afterEnable = await ctx.page(MARKS);
  const enabledRow = await ctx.page(HIDDEN_ROW, FILE);
  rep.重新启用后 = { marks: afterEnable, 隐藏行: enabledRow };
  add(
    "重新启用后隐藏标记重新挂回（清理不影响恢复）",
    afterEnable.kb隐藏类 >= 1 && afterEnable.指示器节点 > 0 && enabledRow.kb隐藏 === true,
    rep.重新启用后
  );

  // 复原：隐藏中的行是 display:none，点不到 → 先用本插件的命令临时显示出来，
  // 再取消隐藏，最后把开关关回去（别把测试造成的状态留给下一条用例和用户）。
  await ctx.page(() => window.app.commands.executeCommandById("sun-home:toggle-show-hidden"));
  await sleep(1000);
  const 显示中 = await ctx.page((p) => ({
    body类: document.body.classList.contains("kb-show-hidden"),
    行可见: (() => {
      const t = document.querySelector(`.nav-file-title[data-path="${p}"]`);
      return t ? t.getBoundingClientRect().height > 0 : false;
    })(),
  }), FILE);
  add("命令「显示 / 隐藏被隐藏的文件」能临时显示出隐藏项", 显示中.body类 === true && 显示中.行可见 === true, 显示中);

  await ctx.page(EXPAND_CHAIN, FILE);
  await sleep(600);
  const urow = await ctx.page(NATIVE_ROW, FILE);
  if (urow) {
    await ctx.click(urow.x, urow.y, "right");
    await sleep(500);
    const unhide = (await ctx.page(ITEMS)).find((i) => i.text === "取消隐藏");
    if (unhide) {
      await ctx.click(Math.round(unhide.x + unhide.w / 2), Math.round(unhide.y + unhide.h / 2));
      await sleep(1000);
    } else add("隐藏后的菜单里没有「取消隐藏」", false, await ctx.page(ITEMS).then((x) => x.map((i) => i.text)));
  } else add("取消隐藏这一步：找不到行（显示隐藏没生效？）", false, urow);

  await ctx.page(() => window.app.commands.executeCommandById("sun-home:toggle-show-hidden"));
  await sleep(900);
  const restored = await ctx.page(HIDDEN_ROW, FILE);
  const 设置复位 = await ctx.page(() => ({
    showHidden: window.app.plugins.plugins["sun-home"].settings.order.showHidden,
  }));
  add(
    "收尾：取消隐藏已生效、显示隐藏开关已关回",
    restored.设置 === false && restored.kb隐藏 === false && 设置复位.showHidden === false,
    { 行: restored, 开关: 设置复位 }
  );

  // ---------- 3. 分组：删除要有确认弹窗；右键菜单要有文字标签 ----------
  await ctx.page(() => window.app.plugins.plugins["sun-home"].openKbHome());
  await sleep(900);
  const newBtn = await ctx.page(() => {
    const b = [...document.querySelectorAll(".kb-home-btn")].find((x) => x.textContent.includes("新建分组"));
    b.scrollIntoView({ block: "nearest" });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await ctx.click(newBtn.x, newBtn.y);
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

  // 右键分组标题
  const hdr = await ctx.page((name) => {
    const h = [...document.querySelectorAll(".kb-group-name")].find((e) => e.textContent === name);
    if (!h) return null;
    h.scrollIntoView({ block: "center" });
    const r = h.closest(".kb-group-header").getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, GROUP);
  rep.分组头 = hdr;
  if (hdr) {
    await ctx.click(hdr.x, hdr.y, "right");
    await sleep(500);
    const gm = await ctx.page(ITEMS);
    rep.分组右键菜单 = gm.map((i) => i.text);
    add(
      "分组右键菜单有文字标签项（新建知识库/折叠/重命名/删除）",
      ["新建知识库", "折叠此分组", "重命名分组", "删除分组"].every((t) => rep.分组右键菜单.includes(t)),
      rep.分组右键菜单
    );
    // 折叠项真的能折叠
    const fold = gm.find((i) => i.text === "折叠此分组");
    if (fold) {
      await ctx.click(Math.round(fold.x + fold.w / 2), Math.round(fold.y + fold.h / 2));
      await sleep(500);
      const 折叠态 = await ctx.page((name) => {
        const h = [...document.querySelectorAll(".kb-group-name")].find((e) => e.textContent === name);
        return { 有放置区: !!h?.closest(".kb-group")?.querySelector(".kb-group-drop-hint") };
      }, GROUP);
      add("右键「折叠此分组」生效（出现拖入放置区）", 折叠态.有放置区 === true, 折叠态);
    }
  } else add("找不到分组标题", false);

  // 卡片右键：移入分组子菜单
  const crow = await ctx.page((box) => {
    const el = document.querySelector(`.kb-card[data-path="${box}"]`);
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, SANDBOX);
  await ctx.click(crow.x, crow.y, "right");
  await sleep(500);
  const km = await ctx.page(ITEMS);
  rep.卡片右键菜单 = km.map((i) => i.text);
  add("卡片右键菜单有「编辑信息」「移入分组」", ["编辑信息", "移入分组"].every((t) => rep.卡片右键菜单.includes(t)), rep.卡片右键菜单);
  const moveItem = km.find((i) => i.text === "移入分组");
  if (moveItem) {
    // Obsidian 的子菜单是点击展开（与「排序方式」一致），悬停不会出子项
    await ctx.click(Math.round(moveItem.x + moveItem.w / 2), Math.round(moveItem.y + moveItem.h / 2));
    await sleep(800);
    const sub = await ctx.page(ITEMS);
    rep.移入子菜单 = sub.filter((s) => !rep.卡片右键菜单.includes(s.text)).map((s) => s.text);
    const target = sub.find((s) => s.text === GROUP);
    if (target) {
      await ctx.click(Math.round(target.x + target.w / 2), Math.round(target.y + target.h / 2));
      await sleep(800);
      // 前面为验证「折叠此分组」把它折叠了；折叠时组内卡片不渲染。
      // 这是本用例自己造成的前提，直接把视图的折叠态解开（setup，不是被断言的行为）
      await ctx.page((name) => {
        const view = window.app.workspace.getLeavesOfType("kb-home-view")[0]?.view;
        const g = window.app.plugins.plugins["sun-home"].settings.groups.find((x) => x.name === name);
        if (view && g && view.collapsed.has(g.id)) {
          view.collapsed.delete(g.id);
          view.render();
        }
        return true;
      }, GROUP);
      await sleep(600);
      const st = await ctx.page((name, box) => {
        const g = window.app.plugins.plugins["sun-home"].settings.groups.find((x) => x.name === name);
        // 真实文件夹分组：移入后路径变成 GROUP/__kb自测__
        const movedPath = `${name}/${box}`;
        const card = document.querySelector(`.kb-card[data-path="${movedPath}"]`);
        return {
          组内: g ? [...g.order] : null,
          卡片在DOM: !!card,
          卡片归属: card?.closest(".kb-group")?.querySelector(".kb-group-name")?.textContent ?? null,
          新路径: movedPath,
          磁盘上: !!window.app.vault.getAbstractFileByPath(movedPath),
        };
      }, GROUP, SANDBOX);
      rep.移入结果 = st;
      add(
        "右键「移入分组」真的把知识库移进组（文件夹真实移动）",
        st.组内?.includes(st.新路径) === true &&
          st.卡片归属 === GROUP &&
          st.磁盘上 === true,
        st
      );
    } else add("移入子菜单里没有目标分组", false, rep.移入子菜单);
  }

  // 删除分组：现在必须有二次确认
  const hdr2 = await ctx.page((name) => {
    const h = [...document.querySelectorAll(".kb-group-name")].find((e) => e.textContent === name);
    if (!h) return null;
    h.scrollIntoView({ block: "center" });
    const r = h.closest(".kb-group-header").getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, GROUP);
  await ctx.move(hdr2.x, hdr2.y);
  await sleep(400);
  const xs = await ctx.page((name) => {
    const h = [...document.querySelectorAll(".kb-group-name")].find((e) => e.textContent === name);
    const x = [...h.closest(".kb-group-header").querySelectorAll(".kb-group-tool")].find((e) => e.textContent.trim() === "✕");
    const r = x.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), visible: r.width > 0 };
  }, GROUP);
  rep.删除按钮 = xs;
  if (xs?.visible) {
    await ctx.click(xs.x, xs.y);
    await sleep(600);
    const cm = await ctx.page(MODAL);
    rep.删除确认 = cm && { title: cm.title, body: cm.body, buttons: cm.buttons.map((b) => b.text) };
    add("点分组 ✕ 现在先弹确认框（不再立即删除）", !!cm && cm.title === "删除分组" && cm.buttons.some((b) => b.text === "确定"), rep.删除确认);
    if (cm) {
      const ok = cm.buttons.find((b) => b.text === "确定");
      await ctx.click(Math.round(ok.x + ok.w / 2), Math.round(ok.y + ok.h / 2));
      await sleep(1600);
      const afterDel = await ctx.page((name, box) => {
        const p = window.app.plugins.plugins["sun-home"];
        return {
          分组记录还在: p.settings.groups.some((g) => g.name === name),
          分组文件夹还在: !!window.app.vault.getAbstractFileByPath(name),
          沙箱回到根目录: !!window.app.vault.getAbstractFileByPath(box),
          沙箱还在组里: !!window.app.vault.getAbstractFileByPath(`${name}/${box}`),
        };
      }, GROUP, SANDBOX);
      rep.删除后 = afterDel;
      add(
        "确认删除后：知识库回到根目录、空分组文件夹已删除、分组记录消失",
        !afterDel.分组记录还在 && !afterDel.分组文件夹还在 && afterDel.沙箱回到根目录 && !afterDel.沙箱还在组里,
        afterDel
      );
      // 后续收尾仍会兜底
    }
  } else add("悬停后仍看不到分组 ✕", false, xs);

  // 收尾：解散测试分组（若删除按钮没走通，这里兜底把沙箱移回根目录并删空文件夹）
  const snap = await ctx.page(async (box, name) => {
    const p = window.app.plugins.plugins["sun-home"];
    const g = p.settings.groups.find((x) => x.name === name);
    if (g) await p.dissolveGroup(g);
    p.settings.groups = p.settings.groups.filter((x) => x.name !== name);
    p.settings.ungroupedOrder = [
      ...new Set([...p.settings.ungroupedOrder.filter((x) => x !== box), box]),
    ];
    for (const x of p.settings.groups) x.order = x.order.filter((v) => v !== box);
    await p.saveSettingsNow();
    return true;
  }, SANDBOX, GROUP);
  await sleep(500);
  rep.收尾后 = await ctx.page((box) => {
    const s = window.app.plugins.plugins["sun-home"].settings;
    const card = document.querySelector(`.kb-card[data-path="${box}"]`);
    return {
      groups: s.groups.map((g) => g.name),
      卡片归属: card?.closest(".kb-group")?.querySelector(".kb-group-name")?.textContent ?? null,
      未分组含沙箱: s.ungroupedOrder.includes(box),
    };
  }, SANDBOX);

  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  rep.失败项 = checks.filter((c) => c.结论 === "FAIL");
  return rep;
};
