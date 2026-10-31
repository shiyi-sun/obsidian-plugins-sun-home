import { INSTALL, RESET, EVENTS, ROWS, READY, STATE, MARK_RELOAD } from "./lib.mjs";

const SANDBOX = "__kb自测__";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });

async function waitReady(ctx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await ctx.page(READY);
    if (r.新文档 && r.ready && r.cards > 0) return r;
    await sleep(700);
  }
  throw new Error("等待重载后的新文档超时");
}

// ---------- 页面侧小工具 ----------
const RECT = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

const TOOLBAR = () =>
  [...document.querySelectorAll(".kb-tree-toolbar .nav-action-button")].map((b, i) => {
    const r = b.getBoundingClientRect();
    return { i, label: b.getAttribute("title"), active: b.classList.contains("is-active"), rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });

const MENU = () =>
  [...document.querySelectorAll(".menu .menu-item")].map((mi) => ({
    text: mi.querySelector(".menu-item-title")?.textContent ?? mi.textContent.trim(),
    section: mi.querySelector(".menu-item-icon svg")?.parentElement?.parentElement?.className ?? "",
    rect: (() => {
      const r = mi.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })(),
  }));

const SORT_OF = (folderPath) =>
  window.app.plugins.plugins["sun-home"].settings.order.items[folderPath]?.sortOrder ?? null;

const CUSTOM_OF = (folderPath) =>
  window.app.plugins.plugins["sun-home"].settings.order.items[folderPath]?.customOrder ?? null;

/** 某文件夹的直接子行显示顺序（只取该层，按 DOM 顺序） */
const CHILD_ORDER = (folderPath) => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  if (!view) return [];
  const prefix = folderPath + "/";
  return [...view.containerEl.querySelectorAll(".kb-tree-body .tree-item-self[data-path]")]
    .map((el) => el.dataset.path)
    .filter((p) => p && p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .map((p) => p.slice(prefix.length));
};

/** 库根空白点：最后一行下方的 padding 里 */
const BLANK_POINT = () => {
  const body = document.querySelector(".kb-tree-body");
  if (!body) return null;
  const cr = body.getBoundingClientRect();
  const rows = [...body.querySelectorAll(".tree-item-self[data-path]")]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.height > 0 && r.bottom > cr.top && r.top < cr.bottom);
  const y = rows.length ? Math.max(...rows.map((r) => r.bottom)) + 10 : cr.top + 20;
  if (y > cr.bottom - 6) return { x: Math.round(cr.right - 4), y: Math.round(cr.top + cr.height / 2), w: 1, h: 1 };
  return { x: Math.round(cr.x + 60), y: Math.round(y), w: 1, h: 1 };
};

const RENAME_STATE = () => {
  const el = document.querySelector(".kb-tree-body .is-being-renamed");
  return {
    renaming: !!el,
    text: el?.querySelector(".tree-item-inner")?.textContent ?? null,
    editable: document.activeElement?.getAttribute?.("contenteditable") ?? null,
  };
};

const NOTICES = () => [...document.querySelectorAll(".notice")].map((n) => n.textContent.trim());

const MODAL = () => {
  const m = document.querySelector(".modal");
  if (!m) return null;
  const input = m.querySelector("input");
  const r = (input || m).getBoundingClientRect();
  return {
    title: m.querySelector("h3")?.textContent ?? null,
    desc: m.querySelector(".kb-modal-desc")?.textContent ?? null,
    hasInput: !!input,
    buttons: [...m.querySelectorAll("button")].map((b) => ({
      text: b.textContent.trim(),
      rect: (() => {
        const r = b.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })(),
    })),
    inputRect: input ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
  };
};

const ROWRECT = (path) => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  const el = view.containerEl.querySelector(`.kb-tree-body .tree-item-self[data-path="${path}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, connected: document.contains(el) };
};

const EXISTS = (p) => !!window.app.vault.getAbstractFileByPath(p);

const VAULT_LIST = (prefix) =>
  window.app.vault
    .getFiles()
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => f.path)
    .sort();

const OPEN_VIA_LINK = (p) => {
  // 模拟「从别处打开这篇笔记」（不是点树行），用来验自动定位
  window.app.workspace.openLinkText(p, "", false);
  return window.app.workspace.getActiveFile()?.path ?? null;
};

async function clickRow(ctx, path, label) {
  const r = await ctx.page(ROWRECT, path);
  if (!r) return { label, FAIL: `行不存在: ${path}` };
  const p = center(r);
  await ctx.move(p.x, p.y);
  await sleep(50);
  await ctx.click(p.x, p.y);
  await sleep(380);
  return { label, ok: true };
}

async function clickToolbar(ctx, idx, label) {
  const bar = await ctx.page(TOOLBAR);
  const b = bar[idx];
  if (!b) return { label, FAIL: "工具条按钮缺失", bar };
  const p = center(b.rect);
  await ctx.click(p.x, p.y);
  await sleep(350);
  return { label, 按钮: b.label, active: b.active };
}

async function menuAndPick(ctx, pickText, label) {
  const items = await ctx.page(MENU);
  let hit = items.find((m) => m.text === pickText) || items.find((m) => m.text.includes(pickText));
  if (!hit) return { label, FAIL: `菜单里没有「${pickText}」`, 菜单项: items.map((i) => i.text) };
  const p = center(hit.rect);
  await ctx.click(p.x, p.y);
  await sleep(350);
  return { label, ok: true };
}

/** 打开某个文件夹的行右键菜单，再点开「排序方式」子菜单 */
async function openRowSort(ctx, folderPath) {
  const r = await ctx.page(ROWRECT, folderPath);
  if (!r) return { ok: false, reason: "找不到文件夹行" };
  const p = center(r);
  await ctx.click(p.x, p.y, "right");
  await sleep(420);
  const items = await ctx.page(MENU);
  const sortItem = items.find((i) => i.text === "排序方式");
  if (!sortItem) return { ok: false, reason: "菜单里没有排序方式", items: items.map((i) => i.text) };
  await ctx.click(center(sortItem.rect).x, center(sortItem.rect).y);
  await sleep(650);
  return { ok: true };
}

/** 库根空白右键 → 排序方式子菜单 */
async function openRootSort(ctx) {
  const bp = await ctx.page(BLANK_POINT);
  if (!bp) return { ok: false, reason: "找不到库根空白" };
  await ctx.click(bp.x, bp.y, "right");
  await sleep(420);
  const items = await ctx.page(MENU);
  const sortItem = items.find((i) => i.text === "排序方式");
  if (!sortItem) return { ok: false, reason: "空白菜单里没有排序方式", items: items.map((i) => i.text) };
  await ctx.click(center(sortItem.rect).x, center(sortItem.rect).y);
  await sleep(650);
  return { ok: true };
}

export default async (ctx) => {
  const rep = {};
  const checks = [];
  const add = (name, pass, detail) => checks.push({ 检查: name, 结论: pass ? "PASS" : "FAIL", ...(detail ? { 证据: detail } : {}) });
  const stamp = (Date.now() % 100000).toString();
  const noteName = "未命名";
  const renamedTo = `改名后的笔记${stamp}`;
  const notePath = `${SANDBOX}/${noteName}.md`;
  const renamedPath = `${SANDBOX}/${renamedTo}.md`;

  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  rep.ready = await waitReady(ctx);

  // 进树
  await ctx.page(
    (p) => {
      const el = [...document.querySelectorAll(".kb-card")].find((c) => c.dataset.path === p);
      el?.scrollIntoView({ block: "center" });
      return !!el;
    },
    SANDBOX
  );
  const cardRect = await ctx.page(RECT, `.kb-card[data-path="${SANDBOX}"]`);
  await ctx.click(center(cardRect).x, center(cardRect).y);
  await sleep(500);
  await ctx.page(INSTALL);

  // ---------- 1. 工具条清单 ----------
  const bar = await ctx.page(TOOLBAR);
  rep.工具条 = bar.map((b) => `${b.i}:${b.label}${b.active ? "[激活]" : ""}`);
  add(
    "工具条 5 个按钮齐全（新建笔记/新建文件夹/自动定位/折叠全部/刷新），不含全库排序",
    bar.length === 5 && !bar.some((b) => b.label.includes("排序")),
    rep.工具条
  );

  // ---------- 2. 单击折叠 / 展开文件夹 ----------
  const before = await ctx.page(ROWS);
  const subA = `${SANDBOX}/子文件夹A`;
  const nBefore = before.rows.length;
  await clickRow(ctx, subA, "折叠 子文件夹A");
  const collapsedOnce = await ctx.page(ROWS);
  await clickRow(ctx, subA, "展开 子文件夹A");
  const expandedOnce = await ctx.page(ROWS);
  add(
    "单击文件夹行即可折叠（子项消失）",
    collapsedOnce.collapsed.includes(subA) && collapsedOnce.rows.length < nBefore,
    { 折叠前: nBefore, 折叠后: collapsedOnce.rows.length, collapsed: collapsedOnce.collapsed }
  );
  add(
    "再单击即展开（行数复原、无卡住）",
    !expandedOnce.collapsed.includes(subA) && expandedOnce.rows.length === nBefore,
    { 展开后: expandedOnce.rows.length }
  );

  // ---------- 3. 折叠全部 / 展开全部 ----------
  const foldBtnIdx = bar.findIndex((b) => b.label.includes("折叠全部"));
  await clickToolbar(ctx, foldBtnIdx, "折叠全部");
  const allCollapsed = await ctx.page(ROWS);
  await clickToolbar(ctx, foldBtnIdx, "展开全部");
  const allExpanded = await ctx.page(ROWS);
  add(
    "折叠全部：所有文件夹进入 collapsed",
    allCollapsed.collapsed.length >= 2 && allCollapsed.rows.length < nBefore,
    { collapsed: allCollapsed.collapsed, rows: allCollapsed.rows.length }
  );
  add("展开全部：collapsed 清空", allExpanded.collapsed.length === 0 && allExpanded.rows.length === nBefore, {
    rows: allExpanded.rows.length,
  });

  // ---------- 4. 排序方式：按文件夹右键，只影响该文件夹 ----------
  const 期望值 = {
    "名称 A → Z": "byNameAsc",
    "名称 Z → A": "byNameDesc",
    "创建时间 新 → 旧": "byCreatedTimeDesc",
    "创建时间 旧 → 新": "byCreatedTimeAsc",
    "修改时间 新 → 旧": "byModifiedTimeDesc",
    "修改时间 旧 → 新": "byModifiedTimeAsc",
    "自定义顺序": "custom",
  };
  const sortProbe = [];
  for (const [want, key] of Object.entries(期望值)) {
    const opened = await openRowSort(ctx, subA);
    if (!opened.ok) {
      sortProbe.push({ want, 打开失败: opened });
      continue;
    }
    const items = await ctx.page(MENU);
    if (sortProbe.length === 0) rep.排序菜单项 = items.map((i) => i.text);
    const hit = items.find((i) => i.text.startsWith(want));
    const probe = { want, 在菜单里: !!hit };
    sortProbe.push(probe);
    if (hit) {
      await ctx.click(center(hit.rect).x, center(hit.rect).y);
      await sleep(500);
      probe.sortOrder = await ctx.page(SORT_OF, subA);
      probe.对上了 = probe.sortOrder === key;
    }
  }
  rep.排序切换 = sortProbe;
  add(
    "文件夹右键排序菜单 7 种都能点，且写入该文件夹的 sortOrder",
    sortProbe.length === 7 && sortProbe.every((s) => s.在菜单里 && s.对上了),
    sortProbe
  );

  // 显式「将当前顺序保存为自定义顺序」：固化的就是当前屏幕顺序
  const descOpened = await openRowSort(ctx, subA);
  if (descOpened.ok) await menuAndPick(ctx, "名称 Z → A", "文件夹 A 切到名称 Z → A");
  const beforeSave = await ctx.page(CHILD_ORDER, subA);
  const saveOpened = await openRowSort(ctx, subA);
  let savePicked = { ok: false };
  if (saveOpened.ok) {
    savePicked = await menuAndPick(ctx, "将当前顺序保存为自定义顺序", "点保存为自定义顺序");
    await sleep(400);
    if (savePicked.ok) {
      const cm = await ctx.page(MODAL);
      const okBtn = cm?.buttons?.find((b) => b.text === "确定");
      if (okBtn) {
        await ctx.click(center(okBtn.rect).x, center(okBtn.rect).y);
        await sleep(650);
      }
    }
  }
  const savedCustom = await ctx.page(CUSTOM_OF, subA);
  const savedOrder = await ctx.page(CHILD_ORDER, subA);
  const savedSort = await ctx.page(SORT_OF, subA);
  add(
    "「将当前顺序保存为自定义顺序」固化当前屏幕顺序",
    savePicked.ok &&
      savedSort === "custom" &&
      JSON.stringify(savedCustom) === JSON.stringify(beforeSave) &&
      JSON.stringify(savedOrder) === JSON.stringify(beforeSave),
    { beforeSave, savedSort, savedCustom, savedOrder }
  );

  // 库根空白右键的排序只改库根
  const rootBefore = await ctx.page(SORT_OF, SANDBOX);
  const rootOpened = await openRootSort(ctx);
  add("库根空白右键有排序方式", rootOpened.ok, rootOpened);
  if (rootOpened.ok) await menuAndPick(ctx, "名称 Z → A", "库根切到名称 Z → A");
  const rootAfter = await ctx.page(SORT_OF, SANDBOX);
  add(
    "库根空白右键排序只改库根",
    rootAfter === "byNameDesc" && rootAfter !== rootBefore,
    { rootBefore, rootAfter }
  );

  // 还原：文件夹 A 和库根都回名称升序
  const resetA = await openRowSort(ctx, subA);
  if (resetA.ok) await menuAndPick(ctx, "名称 A → Z", "文件夹 A 还原名称升序");
  const resetRoot = await openRootSort(ctx);
  if (resetRoot.ok) await menuAndPick(ctx, "名称 A → Z", "库根还原名称升序");
  const backToName = await ctx.page(ROWS);
  rep.sortOrder最终 = backToName.sortOrder;

  // ---------- 5. 自动定位：折叠祖先 → 从别处打开该笔记 → 树自动展开 ----------
  await clickRow(ctx, `${SANDBOX}/子文件夹A`, "折叠 子文件夹A（为自动定位铺场景）");
  const stateBeforeReveal = await ctx.page(ROWS);
  await ctx.page(OPEN_VIA_LINK, `${SANDBOX}/子文件夹A/笔记A2.md`);
  await sleep(600);
  const stateAfterReveal = await ctx.page(ROWS);
  const activePaths = (rowsObj) => rowsObj.rows.filter((r) => r.active).map((r) => r.path);
  add(
    "自动定位：祖先折叠时从别处打开笔记，树自动展开并高亮该笔记",
    !stateAfterReveal.collapsed.includes(`${SANDBOX}/子文件夹A`) &&
      activePaths(stateAfterReveal).includes(`${SANDBOX}/子文件夹A/笔记A2.md`),
    {
      展开前collapsed: stateBeforeReveal.collapsed,
      展开后collapsed: stateAfterReveal.collapsed,
      高亮: activePaths(stateAfterReveal),
      activeFile: (await ctx.page(STATE)).activeFile,
    }
  );

  // 关掉自动定位后再验一次：不应自动展开
  const autoIdx = bar.findIndex((b) => b.label.includes("自动定位"));
  await clickToolbar(ctx, autoIdx, "关闭自动定位");
  const autoOff = await ctx.page(TOOLBAR);
  await clickRow(ctx, `${SANDBOX}/子文件夹A`, "折叠 子文件夹A");
  await ctx.page(OPEN_VIA_LINK, `${SANDBOX}/子文件夹A/笔记A1.md`);
  await sleep(550);
  const stillCollapsed = await ctx.page(ROWS);
  add(
    "自动定位关闭后：不再强制展开（按钮态同步）",
    stillCollapsed.collapsed.includes(`${SANDBOX}/子文件夹A`) &&
      autoOff[autoIdx].active === false,
    { collapsed: stillCollapsed.collapsed, 按钮active: autoOff[autoIdx].active }
  );
  await clickToolbar(ctx, autoIdx, "重新打开自动定位");
  const autoOn = await ctx.page(TOOLBAR);
  add("自动定位可再开启且按钮高亮", autoOn[autoIdx].active === true);

  // 工具条新建位置跟原生一致：活动笔记所在文件夹；先把活动笔记切到库根
  await ctx.page(OPEN_VIA_LINK, `${SANDBOX}/说明.md`);
  await sleep(600);

  // ---------- 6. 新建笔记：应与原生文件树一致，点一下就建好（不弹名字框）----------
  const newNoteIdx = bar.findIndex((b) => b.label === "新建笔记");
  await ctx.page(() => (window.__probe.events = []));
  await clickToolbar(ctx, newNoteIdx, "点新建笔记");
  await sleep(900);
  const created1 = await ctx.page(EXISTS, `${SANDBOX}/未命名.md`);
  const st1 = await ctx.page(STATE);
  const modalAfter = await ctx.page(() => !!document.querySelector(".modal"));
  rep.新建笔记 = { 文件存在: created1, activeFile: st1.activeFile, 有弹窗: modalAfter };
  add("点「新建笔记」不弹名字框，直接建好并打开", modalAfter === false && created1 === true && st1.activeFile === `${SANDBOX}/未命名.md`, rep.新建笔记);

  // 再点一次：自动避让重名（原生的做法）
  await clickToolbar(ctx, newNoteIdx, "再点一次新建笔记");
  await sleep(900);
  const created2 = await ctx.page(EXISTS, `${SANDBOX}/未命名 1.md`);
  add("连续再点一次得到「未命名 1.md」（自动避让重名）", created2 === true, { 未命名1存在: created2 });

  // 文件夹右键里的「新建笔记」也应直接建
  const frow = await ctx.page(ROWRECT, `${SANDBOX}/子文件夹A`);
  if (frow) {
    const p = center(frow);
    await ctx.click(p.x, p.y, "right");
    await sleep(420);
    await menuAndPick(ctx, "新建笔记", "文件夹菜单点新建笔记");
    await sleep(900);
    const stray = `${SANDBOX}/子文件夹A/未命名.md`;
    const inFolder = await ctx.page(EXISTS, stray);
    add("文件夹右键「新建笔记」也直接建在该文件夹里", inFolder === true, { 文件: inFolder });
    // 用例自己建的测试文件要自己收掉，否则后续用例的子项数量会被改变
    await ctx.page((f) => {
      const f0 = window.app.vault.getAbstractFileByPath(f);
      return f0 ? window.app.vault.trash(f0, true).then(() => true) : false;
    }, stray);
    await sleep(400);
  } else add("文件夹菜单新建笔记：找不到文件夹行", false);

  // 清掉多余的那篇（保留 未命名.md 给后面的重命名/删除用例用）
  await ctx.page((p) => {
    const f = window.app.vault.getAbstractFileByPath(p);
    return f ? window.app.vault.trash(f, true).then(() => true) : false;
  }, `${SANDBOX}/未命名 1.md`);
  await sleep(500);

  // ---------- 7. 文件右键菜单 ----------
  await ctx.page(ROWRECT, notePath);
  let r = await ctx.page(ROWRECT, notePath);
  if (!r) {
    // 若被自动定位/重绘影响，重进一次库
    await ctx.page((p) => {
      const plugin = window.app.plugins.plugins["sun-home"];
      return plugin.openKbTree({ path: p, name: p.split("/").pop(), docCount: 0, groupId: null });
    }, SANDBOX);
    await sleep(500);
    r = await ctx.page(ROWRECT, notePath);
  }
  if (r) {
    const p = center(r);
    await ctx.move(p.x, p.y);
    await ctx.click(p.x, p.y, "right");
    await sleep(400);
    const items = await ctx.page(MENU);
    rep.文件右键菜单 = items.map((i) => i.text);
    const need = [
      "在新标签页中打开",
      "创建副本",
      "将文件移动到…",
      "复制路径",
      "在系统资源管理器中显示",
      "置顶",
      "隐藏",
      "重命名",
      "删除",
    ];
    add(
      "文件右键菜单按原生分组补齐核心项",
      need.every((n) => items.some((i) => i.text === n)),
      rep.文件右键菜单
    );
    // 复制路径：应弹 Notice（插件自带与 Obsidian 注入的同名项都算）
    await menuAndPick(ctx, "复制路径", "点复制路径");
    const notices = await ctx.page(NOTICES);
    add("菜单项「复制路径」有反馈 Notice", notices.some((t) => t.includes("复制")), notices);

    // 重命名：行内 contenteditable，Enter 提交
    await ctx.click(p.x, p.y, "right");
    await sleep(380);
    const picked = await menuAndPick(ctx, "重命名", "点重命名");
    await sleep(450);
    const renState = await ctx.page(RENAME_STATE);
    add("右键重命名进入行内编辑", picked.ok && renState.renaming && renState.editable === "true", renState);
    if (renState.renaming) {
      await ctx.clearAndType(renamedTo);
      await sleep(100);
      await ctx.key("Enter", "Enter", 13);
      await sleep(800);
    }
    const renamed = await ctx.page(EXISTS, renamedPath);
    const oldStill = await ctx.page(EXISTS, notePath);
    add("右键重命名生效（磁盘名真的变了）", renamed === true && oldStill === false, {
      新文件存在: renamed,
      旧文件仍存在: oldStill,
      期望新名: renamedPath,
      目录清单: await ctx.page(VAULT_LIST, `${SANDBOX}/`),
    });

    // 删除：走原生确认框，点破坏性按钮
    let r2 = await ctx.page(ROWRECT, renamedPath);
    if (r2) {
      const p2 = center(r2);
      await ctx.click(p2.x, p2.y, "right");
      await sleep(380);
      await menuAndPick(ctx, "删除", "点删除");
      await sleep(500);
      const cm = await ctx.page(MODAL);
      rep.删除确认弹窗 = cm && { title: cm.title, buttons: cm.buttons.map((b) => b.text) };
      const okBtn = cm?.buttons?.find((b) => /删除|确定/.test(b.text));
      if (okBtn) {
        await ctx.click(center(okBtn.rect).x, center(okBtn.rect).y);
        await sleep(700);
      }
      const gone = await ctx.page(EXISTS, renamedPath);
      add("右键删除经确认后真的删掉文件", gone === false, { 仍存在: gone });
    } else add("右键删除：目标行找不到", false);
  } else add("文件右键菜单：找不到行", false);

  // ---------- 8. 文件夹右键菜单 ----------
  const fr = await ctx.page(ROWRECT, `${SANDBOX}/子文件夹B`);
  if (fr) {
    const p = center(fr);
    await ctx.click(p.x, p.y, "right");
    await sleep(400);
    const items = await ctx.page(MENU);
    rep.文件夹右键菜单 = items.map((i) => i.text);
    const need = [
      "新建笔记",
      "新建文件夹",
      "创建副本",
      "将文件夹移动到…",
      "在文件夹中查找",
      "排序方式",
      "置顶",
      "隐藏",
      "重命名",
      "删除",
      "在系统资源管理器中显示",
      "复制路径",
    ];
    add(
      "文件夹右键菜单按原生分组补齐",
      need.every((n) => items.some((i) => i.text === n)),
      rep.文件夹右键菜单
    );
    await ctx.page(() => document.body.click()); // 关菜单
    await sleep(150);
  } else add("文件夹右键菜单：找不到 子文件夹B", false);

  // ---------- 9. 返回全部知识库 ----------
  const backRect = await ctx.page(RECT, ".kb-tree-back");
  if (backRect) {
    await ctx.click(center(backRect).x, center(backRect).y);
    await sleep(600);
    const home = await ctx.page(() => ({
      activeLeafType: window.app.workspace.activeLeaf?.view?.getViewType?.() ?? null,
      activeFilePath: window.app.workspace.getActiveFile()?.path ?? null,
      homeLeaves: window.app.workspace.getLeavesOfType("kb-home-view").length,
      cards: document.querySelectorAll(".kb-card").length,
    }));
    add("「← 全部知识库」单击即回到卡片墙", home.cards > 0 && home.homeLeaves >= 1, home);
  } else add("返回入口缺失", false);

  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  rep.失败项 = checks.filter((c) => c.结论 === "FAIL");
  return rep;
};
