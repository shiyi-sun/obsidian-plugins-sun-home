/*
 P0 的树对等采样层。

 这里只放“怎么观察”和“怎么准备样本”，不放某条用例的期望。
 原生树和单库树共用同一组函数，差别只有 tree = "native" | "kb"。

 约定：
 - 页面函数会被 run.mjs 序列化后在渲染进程执行，函数体内只能用浏览器全局和参数。
 - 所有行都以 .tree-item-self[data-path] 为准；两棵树现在和统一后都应满足。
 - 不改生产代码；测试沙箱由本层创建和清理。
*/

export const SANDBOX = "__kb统一自测__";
export const PERF_SANDBOX = "__kb性能自测__";
export const FOLDER_A = `${SANDBOX}/文件夹A`;
export const FOLDER_B = `${SANDBOX}/文件夹B`;
export const EMPTY_FOLDER = `${SANDBOX}/空文件夹`;
export const ATTACHMENT = `${SANDBOX}/附件.png`;
export const ROOT_A = `${SANDBOX}/根笔记A.md`;
export const ROOT_B = `${SANDBOX}/根笔记B.md`;
export const ROOT_C = `${SANDBOX}/根笔记C.md`;
export const A1 = `${FOLDER_A}/笔记A1.md`;
export const A2 = `${FOLDER_A}/笔记A2.md`;
export const B1 = `${FOLDER_B}/笔记B1.md`;
export const B2 = `${FOLDER_B}/笔记B2.md`;

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });

export const WAIT_READY = () => {
  const app = window.app;
  return {
    新文档: typeof window.__beforeReload === "undefined",
    ready: typeof window.__beforeReload === "undefined" && !!app?.plugins?.plugins?.["sun-home"],
    cards: document.querySelectorAll(".kb-card").length,
    explorerRows: document.querySelectorAll(
      '[data-type="file-explorer"] .nav-file-title, [data-type="file-explorer"] .nav-folder-title'
    ).length,
  };
};

export async function waitReady(ctx, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await ctx.page(WAIT_READY);
    if (r.新文档 && r.ready) return r;
    await sleep(600);
  }
  throw new Error("超时：sun-home 未就绪");
}

const ENSURE_SANDBOX = async (box, folderA, folderB, emptyFolder, attachment, rootA, rootB, rootC, a1, a2, b1, b2, png) => {
  const v = window.app.vault;
  const p = window.app.plugins.plugins["sun-home"];
  const old = v.getAbstractFileByPath(box);
  if (old) await v.delete(old, true);
  await v.createFolder(box);
  await v.createFolder(folderA);
  await v.createFolder(folderB);
  await v.createFolder(emptyFolder);
  for (const [path, text] of [
    [rootA, "# 根笔记A\n"],
    [rootB, "# 根笔记B\n"],
    [rootC, "# 根笔记C\n"],
    [a1, "# A1\n"],
    [a2, "# A2\n"],
    [b1, "# B1\n"],
    [b2, "# B2\n"],
  ]) {
    await v.create(path, text);
  }
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  await v.createBinary(attachment, bytes.buffer);

  const s = p.settings;
  for (const key of Object.keys(s.order.items || {})) {
    if (key === box || key.startsWith(box + "/")) delete s.order.items[key];
  }
  s.overrides = Object.fromEntries(
    Object.entries(s.overrides || {}).filter(([k]) => k !== box && !k.startsWith(box + "/"))
  );
  if (s.ungroupedOrder) s.ungroupedOrder = s.ungroupedOrder.filter((x) => x !== box);
  for (const g of s.groups || []) g.order = g.order.filter((x) => x !== box);
  p.sortFeature.orderManager.syncItems((path) => !!v.getAbstractFileByPath(path), v.getRoot());
  for (const folder of [box, folderA, folderB, emptyFolder]) {
    const f = p.sortFeature.ensureFolderSettings(folder);
    f.sortOrder = "byNameAsc";
    f.customOrder = [];
  }
  await p.saveSettingsNow();
  p.sortFeature.syncRuntimeSettings();
  p.sortFeature.syncIndicators();
  p.sortFeature.sortExplorer();
  return {
    files: v.getFiles().filter((f) => f.path.startsWith(box + "/")).map((f) => f.path).sort(),
    folders: v
      .getAllLoadedFiles()
      .filter((f) => f.children && f.path.startsWith(box + "/"))
      .map((f) => f.path)
      .sort(),
  };
};

export async function ensureSandbox(ctx) {
  return ctx.page(
    ENSURE_SANDBOX,
    SANDBOX,
    FOLDER_A,
    FOLDER_B,
    EMPTY_FOLDER,
    ATTACHMENT,
    ROOT_A,
    ROOT_B,
    ROOT_C,
    A1,
    A2,
    B1,
    B2,
    PNG_1X1
  );
}

export const SHOW_TREE = async (tree) => {
  const ws = window.app.workspace;
  if (ws.leftSplit?.collapsed) ws.leftSplit.expand();
  if (tree === "native") {
    const leaf = ws.getLeavesOfType("file-explorer")[0];
    if (!leaf) return { ok: false, reason: "无原生 File Explorer" };
    ws.revealLeaf(leaf);
    ws.setActiveLeaf(leaf, { focus: true });
    return { ok: true };
  }
  const leaf = ws.getLeavesOfType("kb-tree-view")[0];
  if (!leaf) return { ok: false, reason: "无单库树视图" };
  ws.revealLeaf(leaf);
  ws.setActiveLeaf(leaf, { focus: false });
  return { ok: true };
};

export async function showTree(ctx, tree) {
  const r = await ctx.page(SHOW_TREE, tree);
  await sleep(700);
  return r;
}

export const OPEN_KB = async (path) => {
  const p = window.app.plugins.plugins["sun-home"];
  const name = path.split("/").pop();
  await p.openKbTree({ path, name, docCount: 0, groupId: null });
  await new Promise((r) => setTimeout(r, 700));
  return true;
};

export async function openKb(ctx, path) {
  await ctx.page(OPEN_KB, path);
  await sleep(500);
}

export const ENSURE_EXPANDED = async (tree, paths) => {
  const ws = window.app.workspace;
  if (tree === "native") {
    const view = ws.getLeavesOfType("file-explorer")[0]?.view;
    for (const path of paths) view?.fileItems?.[path]?.setCollapsed?.(false, true);
  } else {
    const view = ws.getLeavesOfType("kb-tree-view")[0]?.view;
    for (const path of paths) {
      view?.collapsed?.delete(path);
    }
    view?.render?.();
  }
  await new Promise((r) => setTimeout(r, 500));
  return true;
};

export async function ensureExpanded(ctx, tree, paths) {
  await ctx.page(ENSURE_EXPANDED, tree, paths);
  await sleep(500);
}

export const ENSURE_COLLAPSED = async (tree, paths) => {
  const ws = window.app.workspace;
  if (tree === "native") {
    const view = ws.getLeavesOfType("file-explorer")[0]?.view;
    for (const path of paths) view?.fileItems?.[path]?.setCollapsed?.(true, true);
  } else {
    const view = ws.getLeavesOfType("kb-tree-view")[0]?.view;
    for (const path of paths) view?.collapsed?.add(path);
    view?.render?.();
  }
  await new Promise((r) => setTimeout(r, 500));
  return true;
};

export async function ensureCollapsed(ctx, tree, paths) {
  await ctx.page(ENSURE_COLLAPSED, tree, paths);
  await sleep(500);
}

export const SNAPSHOT = (tree) => {
  const sel = tree === "native" ? {
    container: '[data-type="file-explorer"] .nav-files-container',
    row: '[data-type="file-explorer"] .tree-item-self[data-path]',
  } : {
    container: ".kb-tree-body",
    row: ".kb-tree-body .tree-item-self[data-path]",
  };
  const container = document.querySelector(sel.container);
  if (!container) return { tree, err: "容器不存在" };
  const all = [...container.querySelectorAll(".tree-item-self[data-path]")];
  const cr = container.getBoundingClientRect();
  const visible = all.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > cr.top && r.top < cr.bottom;
  });
  const rows = visible.slice(0, 80).map((el) => {
    const r = el.getBoundingClientRect();
    const cr = el.querySelector(".tree-item-inner")?.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      path: el.dataset.path,
      kind: el.classList.contains("nav-folder-title") ? "folder" : "file",
      text: el.querySelector(".tree-item-inner")?.textContent ?? null,
      cls: el.className,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: +r.height.toFixed(2) },
      contentX: cr ? Math.round(cr.x) : null,
      paddingLeft: cs.paddingLeft,
      marginBottom: cs.marginBottom,
      inlineStyle: el.getAttribute("style"),
      isActive: el.classList.contains("is-active"),
      isSelected: el.classList.contains("is-selected"),
    };
  });
  const heightMarkers = [...container.querySelectorAll("div")]
    .filter((el) => !el.className && el.style && el.style.height && parseFloat(el.style.height) <= 1)
    .slice(0, 8)
    .map((el) => ({ style: el.getAttribute("style"), h: el.getBoundingClientRect().height }));
  return {
    tree,
    totalRows: all.length,
    visibleRows: visible.length,
    containerRect: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    heightMarkers,
    rows,
  };
};

export async function snapshot(ctx, tree) {
  return ctx.page(SNAPSHOT, tree);
}

export const ROW_COUNTS = (tree) => {
  const container = document.querySelector(
    tree === "native" ? '[data-type="file-explorer"] .nav-files-container' : ".kb-tree-body"
  );
  if (!container) return { err: "容器不存在" };
  return {
    totalRows: container.querySelectorAll(".tree-item-self[data-path]").length,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    containerRect: (() => {
      const r = container.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })(),
  };
};

export async function rowCounts(ctx, tree) {
  return ctx.page(ROW_COUNTS, tree);
}

export const SCROLL_BOTTOM = async (tree) => {
  const container = document.querySelector(
    tree === "native" ? '[data-type="file-explorer"] .nav-files-container' : ".kb-tree-body"
  );
  if (!container) return { err: "容器不存在" };
  const t0 = performance.now();
  container.scrollTop = container.scrollHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 150));
  return {
    ms: +(performance.now() - t0).toFixed(1),
    totalRows: container.querySelectorAll(".tree-item-self[data-path]").length,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  };
};

export async function scrollBottom(ctx, tree) {
  return ctx.page(SCROLL_BOTTOM, tree);
}

export const SCROLL_MID = async (tree) => {
  const container = document.querySelector(
    tree === "native" ? '[data-type="file-explorer"] .nav-files-container' : ".kb-tree-body"
  );
  if (!container) return { err: "容器不存在" };
  const t0 = performance.now();
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = max * 0.5;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 150));
  return {
    ms: +(performance.now() - t0).toFixed(1),
    totalRows: container.querySelectorAll(".tree-item-self[data-path]").length,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  };
};

export async function scrollMid(ctx, tree) {
  return ctx.page(SCROLL_MID, tree);
}

export const EXPAND_NATIVE_MEASURE = async (path) => {
  const view = window.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
  const container = document.querySelector('[data-type="file-explorer"] .nav-files-container');
  if (!view || !container) return { err: "原生树不可用" };
  const item = view.fileItems?.[path];
  if (!item) return { err: "找不到性能文件夹" };
  // 先收起，拿到未展开基线；否则“已渲染的行数 > 0”会立刻满足，测不到展开耗时
  item.setCollapsed?.(true, true);
  await new Promise((r) => setTimeout(r, 220));
  const before = {
    rows: container.querySelectorAll(".tree-item-self[data-path]").length,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  };
  const t0 = performance.now();
  item.setCollapsed?.(false, true);
  let rows = before.rows;
  while (performance.now() - t0 < 5000) {
    rows = container.querySelectorAll(".tree-item-self[data-path]").length;
    if (container.scrollHeight > before.scrollHeight + 100 && rows > 0) break;
    await new Promise((r) => requestAnimationFrame(r));
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return {
    ms: +(performance.now() - t0).toFixed(1),
    before,
    totalRows: rows,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  };
};

export async function expandNativeMeasure(ctx, path) {
  return ctx.page(EXPAND_NATIVE_MEASURE, path);
}

export const ROW_RECT = async (tree, path) => {
  const sel = tree === "native"
    ? '[data-type="file-explorer"] .tree-item-self[data-path]'
    : ".kb-tree-body .tree-item-self[data-path]";
  const containerSel = tree === "native"
    ? '[data-type="file-explorer"] .nav-files-container'
    : ".kb-tree-body";
  const container = document.querySelector(containerSel);
  if (!container) return null;
  let el = document.querySelector(`${sel.replace("[data-path]", `[data-path="${path}"]`)}`);
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  await new Promise((r) => setTimeout(r, 120));
  el = document.querySelector(`${sel.replace("[data-path]", `[data-path="${path}"]`)}`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: +r.height.toFixed(2),
    visible: r.bottom > cr.top && r.top < cr.bottom,
  };
};

export async function rowRect(ctx, tree, path) {
  return ctx.page(ROW_RECT, tree, path);
}

export const TREE_RECT = (tree) => {
  const el = document.querySelector(
    tree === "native" ? '[data-type="file-explorer"] .nav-files-container' : ".kb-tree-body"
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
};

export async function treeRect(ctx, tree) {
  return ctx.page(TREE_RECT, tree);
}

export const BLANK_POINT = (tree) => {
  const container = document.querySelector(
    tree === "native" ? '[data-type="file-explorer"] .nav-files-container' : ".kb-tree-body"
  );
  if (!container) return null;
  const cr = container.getBoundingClientRect();
  if (tree === "native") {
    // 原生树右侧内边距在行内容盒之外，且不会碰到滚动条；P0 起一直用这个点
    return { x: Math.round(cr.right - 14), y: Math.round(cr.top + 20), w: 1, h: 1 };
  }
  const rows = [...container.querySelectorAll(".tree-item-self[data-path]")]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.height > 0 && r.bottom > cr.top && r.top < cr.bottom);
  if (!rows.length) {
    return { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + 24), w: 1, h: 1 };
  }
  const maxBottom = Math.max(...rows.map((r) => r.bottom));
  const y = maxBottom + 12;
  if (y > cr.bottom - 8) {
    // 行铺满视口时没有“末行下方”的空白，退到容器右侧内边距；
    // 这里必须取在行内容盒之外，否则会落进某一行自己的落点区。
    return { x: Math.round(cr.right - 4), y: Math.round(cr.top + cr.height / 2), w: 1, h: 1 };
  }
  return { x: Math.round(cr.x + 60), y: Math.round(y), w: 1, h: 1 };
};

export async function blankPoint(ctx, tree) {
  return ctx.page(BLANK_POINT, tree);
}

export const DROP_STATE = (tree) => {
  const container = document.querySelector(
    tree === "native" ? '[data-type="file-explorer"] .nav-files-container' : ".kb-tree-body"
  );
  if (!container) return { err: "容器不存在" };
  const self = (el) =>
    el?.matches?.(".tree-item")
      ? el.querySelector(":scope > .tree-item-self") ?? el
      : el;
  const rows = [...container.querySelectorAll("[data-kb-drop-sibling], [data-kb-drop-folder]")].map((el) => ({
    path: self(el)?.dataset?.path ?? el.dataset?.path ?? "?",
    side: el.dataset.kbDropSibling ?? "folder",
    tag: el.tagName,
  }));
  const dragged = [...container.querySelectorAll(".is-being-dragged")].map(
    (el) => self(el)?.dataset?.path ?? el.dataset?.path ?? "?"
  );
  return {
    rows,
    指示线: container.querySelectorAll("[data-kb-drop-sibling]").length,
    移入高亮: container.querySelectorAll("[data-kb-drop-folder]").length,
    dragged,
    bodyClass: document.body.classList.contains("kb-dragging"),
  };
};

export async function dropState(ctx, tree) {
  return ctx.page(DROP_STATE, tree);
}

async function dragToPoint(ctx, tree, from, to, holdMs = 180) {
  await ctx.page(RESET_DRAG_IMAGES);
  await ctx.raw("mouseMoved", from.x, from.y);
  await sleep(60);
  await ctx.raw("mousePressed", from.x, from.y);
  await sleep(80);
  for (const [dx, dy] of [
    [3, 1],
    [7, 2],
    [11, 3],
    [15, 5],
    [20, 7],
  ]) {
    await ctx.raw("mouseMoved", from.x + dx, from.y + dy);
    await sleep(35);
  }
  for (let i = 1; i <= 12; i++) {
    await ctx.raw(
      "mouseMoved",
      Math.round(from.x + ((to.x - from.x) * i) / 12),
      Math.round(from.y + ((to.y - from.y) * i) / 12)
    );
    await sleep(30);
  }
  await ctx.raw("mouseMoved", to.x, to.y);
  await sleep(holdMs);
  const during = await dropState(ctx, tree);
  const dragImages = await ctx.page(READ_DRAG_IMAGES);
  return { ...during, dragImages };
}

/** 在页面里记录拖拽时 setDragImage 的调用，用于确认浏览器默认拖拽快照已被抑制 */
export const INSTALL_DRAG_IMAGE_PROBE = () => {
  window.__kbDragImages = [];
  if (!window.__kbDragImagePatched) {
    const proto = DataTransfer.prototype;
    const orig = proto.setDragImage;
    proto.setDragImage = function (img, x, y) {
      window.__kbDragImages.push({
        tag: img?.tagName ?? null,
        w: img?.width ?? null,
        h: img?.height ?? null,
        x,
        y,
      });
      return orig.call(this, img, x, y);
    };
    window.__kbDragImagePatched = true;
  }
  return true;
};

const RESET_DRAG_IMAGES = () => {
  window.__kbDragImages = [];
  return true;
};

const READ_DRAG_IMAGES = () => window.__kbDragImages || [];

/** 拖到落点、读指示、移到树外松手取消；不会改动顺序 */
export async function dragProbe(ctx, tree, src, dst, ratio = 0.5) {
  const from = center(src);
  const to = { x: Math.round(dst.x + dst.w / 2), y: Math.round(dst.y + dst.h * ratio) };
  const during = await dragToPoint(ctx, tree, from, to);
  const tr = await treeRect(ctx, tree);
  if (tr) {
    await ctx.raw("mouseMoved", Math.round(tr.right + 80), Math.round(tr.y + 20));
    await sleep(90);
  }
  await ctx.raw("mouseReleased", Math.round((tr?.right ?? to.x) + 80), Math.round((tr?.y ?? to.y) + 20));
  await sleep(300);
  return during;
}

/** 拖到落点并松手，返回落点状态；调用方负责还原 */
export async function dragCommit(ctx, tree, src, dst, ratio = 0.5) {
  const from = center(src);
  const to = { x: Math.round(dst.x + dst.w / 2), y: Math.round(dst.y + dst.h * ratio) };
  const during = await dragToPoint(ctx, tree, from, to);
  await ctx.raw("mouseReleased", to.x, to.y);
  await sleep(650);
  return during;
}

export const READ_ORDER = (tree, parentPath) => {
  const container = document.querySelector(
    tree === "native" ? '[data-type="file-explorer"] .nav-files-container' : ".kb-tree-body"
  );
  if (!container) return { err: "容器不存在" };
  const prefix = parentPath === "/" ? "" : parentPath + "/";
  const rows = [...container.querySelectorAll(".tree-item-self[data-path]")]
    .map((el) => ({ el, path: el.dataset.path, r: el.getBoundingClientRect() }))
    .filter((x) => x.path.startsWith(prefix) && !x.path.slice(prefix.length).includes("/"))
    .sort((a, b) => a.r.y - b.r.y)
    .map((x) => x.path);
  return rows;
};

export async function readOrder(ctx, tree, parentPath) {
  return ctx.page(READ_ORDER, tree, parentPath);
}

export const READ_SETTINGS = (folderPath) => {
  const p = window.app.plugins.plugins["sun-home"];
  const it = p.settings.order.items[folderPath] || {};
  return {
    sortOrder: it.sortOrder ?? null,
    customOrder: it.customOrder ?? null,
    pinned: Object.fromEntries(
      Object.entries(p.settings.order.items)
        .filter(([k, v]) => k.startsWith(folderPath + "/") && v?.isPinned)
        .map(([k]) => [k, true])
    ),
    hidden: Object.fromEntries(
      Object.entries(p.settings.order.items)
        .filter(([k, v]) => k.startsWith(folderPath + "/") && v?.isHidden)
        .map(([k]) => [k, true])
    ),
  };
};

export async function readSettings(ctx, folderPath) {
  return ctx.page(READ_SETTINGS, folderPath);
}

export const SET_MODE = async (folderPath, mode, order) => {
  const p = window.app.plugins.plugins["sun-home"];
  const f = p.sortFeature.ensureFolderSettings(folderPath);
  f.sortOrder = mode;
  if (Array.isArray(order)) f.customOrder = order;
  await p.saveSettingsNow();
  p.sortFeature.sortExplorer();
  const v = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  v?.render?.();
  await new Promise((r) => setTimeout(r, 300));
  return true;
};

export async function setMode(ctx, folderPath, mode, order = []) {
  await ctx.page(SET_MODE, folderPath, mode, order);
  await sleep(450);
}

export const EXISTS = (path) => !!window.app.vault.getAbstractFileByPath(path);

export async function exists(ctx, path) {
  return ctx.page(EXISTS, path);
}

export const MOVE_FILE = async (from, to) => {
  const v = window.app.vault;
  const f = v.getAbstractFileByPath(from);
  if (!f) return { ok: false, reason: "源不存在" };
  try {
    await window.app.fileManager.renameFile(f, to);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
};

export async function moveFile(ctx, from, to) {
  const r = await ctx.page(MOVE_FILE, from, to);
  await sleep(350);
  return r;
}

export const RESTORE_BY_NAME = async (box, name, to) => {
  const v = window.app.vault;
  const file = v.getFiles().find((f) => f.path.startsWith(box + "/") && f.name === name);
  if (!file || file.path === to) return { ok: true, moved: false };
  try {
    await window.app.fileManager.renameFile(file, to);
    return { ok: true, moved: true, from: file.path };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
};

export async function restoreByName(ctx, box, name, to) {
  const r = await ctx.page(RESTORE_BY_NAME, box, name, to);
  await sleep(350);
  return r;
}

export const RESET_SANDBOX_ORDERS = async (box, folders) => {
  const p = window.app.plugins.plugins["sun-home"];
  for (const path of folders) {
    const f = p.sortFeature.ensureFolderSettings(path);
    f.sortOrder = "byNameAsc";
    f.customOrder = [];
  }
  await p.saveSettingsNow();
  p.sortFeature.sortExplorer();
  const v = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  v?.render?.();
  return true;
};

export async function resetSandboxOrders(ctx, folders = [SANDBOX, FOLDER_A, FOLDER_B, EMPTY_FOLDER]) {
  await ctx.page(RESET_SANDBOX_ORDERS, SANDBOX, folders);
  await sleep(400);
}

export const CLEANUP_SANDBOX = async (box) => {
  const ws = window.app.workspace;
  for (const leaf of [...ws.getLeavesOfType("markdown")]) {
    const path = leaf.getViewState?.()?.state?.file ?? leaf.view?.file?.path ?? null;
    if (path && path.startsWith(box + "/")) leaf.detach();
  }
  const v = window.app.vault;
  const f = v.getAbstractFileByPath(box);
  if (f) await v.delete(f, true);
  const p = window.app.plugins.plugins["sun-home"];
  const s = p.settings;
  for (const key of Object.keys(s.order.items || {})) {
    if (key === box || key.startsWith(box + "/")) delete s.order.items[key];
  }
  s.overrides = Object.fromEntries(
    Object.entries(s.overrides || {}).filter(([k]) => k !== box && !k.startsWith(box + "/"))
  );
  if (s.ungroupedOrder) s.ungroupedOrder = s.ungroupedOrder.filter((x) => x !== box);
  for (const g of s.groups || []) g.order = g.order.filter((x) => x !== box);
  await p.saveSettingsNow();
  p.sortFeature.syncRuntimeSettings();
  p.sortFeature.syncIndicators();
  p.sortFeature.sortExplorer();
  return true;
};

export async function cleanupSandbox(ctx, box = SANDBOX) {
  await ctx.page(CLEANUP_SANDBOX, box);
  await sleep(700);
}

export const COLLECT_MENU = async (tree, path) => {
  const row = document.querySelector(
    (tree === "native"
      ? '[data-type="file-explorer"] .tree-item-self[data-path]'
      : ".kb-tree-body .tree-item-self[data-path]"
    ).replace("[data-path]", `[data-path="${path}"]`)
  );
  if (!row) return { err: "找不到行", path };
  row.scrollIntoView({ block: "center" });
  await new Promise((r) => setTimeout(r, 120));
  const r = row.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
};

export async function collectMenu(ctx, tree, path) {
  const pos = await ctx.page(COLLECT_MENU, tree, path);
  if (pos.err) return pos;
  await ctx.click(pos.x, pos.y, "right");
  await sleep(350);
  const menu = await ctx.page(() => {
    const menus = [...document.querySelectorAll(".menu")];
    const m = menus[menus.length - 1];
    if (!m) return { err: "菜单没有出现" };
    return {
      items: [...m.querySelectorAll(".menu-item")].map((el) => ({
        title: el.querySelector(".menu-item-title")?.textContent ?? el.textContent?.trim() ?? "",
        section: el.dataset.section ?? null,
        warning: el.classList.contains("is-warning"),
      })),
    };
  });
  await ctx.key("Escape", "Escape", 27);
  await sleep(180);
  return menu;
}

export const CLICK_ROW = (tree, path, modifiers = 0) => {
  const row = document.querySelector(
    (tree === "native"
      ? '[data-type="file-explorer"] .tree-item-self[data-path]'
      : ".kb-tree-body .tree-item-self[data-path]"
    ).replace("[data-path]", `[data-path="${path}"]`)
  );
  if (!row) return null;
  row.scrollIntoView({ block: "center" });
  const r = row.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
};

export async function clickRow(ctx, tree, path, modifiers = 0) {
  const pos = await ctx.page(CLICK_ROW, tree, path, modifiers);
  if (!pos) return { ok: false, reason: "找不到行" };
  await ctx.click(pos.x, pos.y, "left", modifiers);
  await sleep(350);
  return { ok: true, ...pos };
}

export const SELECTION = (tree) => {
  const container = document.querySelector(
    tree === "native" ? '[data-type="file-explorer"] .nav-files-container' : ".kb-tree-body"
  );
  const rows = container ? [...container.querySelectorAll(".tree-item-self[data-path]")] : [];
  return {
    selected: rows.filter((el) => el.classList.contains("is-selected")).map((el) => el.dataset.path),
    active: rows.filter((el) => el.classList.contains("is-active")).map((el) => el.dataset.path),
    重命名中: !!document.querySelector(".is-being-renamed"),
    markdownLeaves: window.app.workspace.getLeavesOfType("markdown").length,
    activeFile: window.app.workspace.getActiveFile()?.path ?? null,
  };
};

export async function selection(ctx, tree) {
  return ctx.page(SELECTION, tree);
}

export const KEY_FOCUS = async (tree, path) => {
  if (tree === "native") {
    const view = window.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    const item = view?.fileItems?.[path];
    if (!view?.tree?.containerEl || !item) return { ok: false };
    view.tree.containerEl.focus();
    view.tree.setFocusedItem(item, true);
    return {
      ok: true,
      focused: view.tree.focusedItem?.file?.path ?? null,
      activeElement: document.activeElement?.className ?? null,
    };
  }
  const row = document.querySelector(
    `.kb-tree-body .tree-item-self[data-path="${path}"]`
  );
  if (!row) return { ok: false };
  row.focus();
  return { ok: document.activeElement === row, activeElement: document.activeElement?.className ?? null };
};

export async function focusRow(ctx, tree, path) {
  return ctx.page(KEY_FOCUS, tree, path);
}

export const CREATE_PERF_SANDBOX = async (box, count) => {
  const v = window.app.vault;
  const p = window.app.plugins.plugins["sun-home"];
  const old = v.getAbstractFileByPath(box);
  if (old) await v.delete(old, true);
  await v.createFolder(box);
  p.sortFeature.setSuspended(true);
  try {
    const batch = 80;
    for (let start = 0; start < count; start += batch) {
      const jobs = [];
      const end = Math.min(count, start + batch);
      for (let i = start; i < end; i++) {
        const name = `笔记${String(i).padStart(5, "0")}.md`;
        jobs.push(v.create(`${box}/${name}`, `# ${name}\n`));
      }
      await Promise.all(jobs);
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    p.sortFeature.setSuspended(false);
  }
  p.sortFeature.orderManager.syncItems((path) => !!v.getAbstractFileByPath(path), v.getRoot());
  const f = p.sortFeature.ensureFolderSettings(box);
  f.sortOrder = "byNameAsc";
  f.customOrder = [];
  await p.saveSettingsNow();
  p.sortFeature.sortExplorer();
  return { count: v.getFiles().filter((x) => x.path.startsWith(box + "/")).length };
};

export async function createPerfSandbox(ctx, count, box = PERF_SANDBOX) {
  const r = await ctx.page(CREATE_PERF_SANDBOX, box, count);
  await sleep(900);
  return r;
}

export const OPEN_KB_PERF = async (box) => {
  const r = document.querySelector('[data-type="file-explorer"] .nav-files-container');
  if (r) {
    // 原生树先展开，避免“打开单库树前原生树还没渲染”导致测量对象混淆
    const view = window.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    view?.fileItems?.[box]?.setCollapsed?.(false, true);
  }
  const p = window.app.plugins.plugins["sun-home"];
  await p.openKbTree({ path: box, name: box, docCount: 0, groupId: null });
  return true;
};

export async function measureOpenKb(ctx, box) {
  const t0 = Date.now();
  await ctx.page(OPEN_KB_PERF, box);
  let found = false;
  while (Date.now() - t0 < 15000) {
    const n = await ctx.page((b) => {
      const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
      if (!view || view.currentPath !== b) return 0;
      return view.containerEl.querySelectorAll(".kb-tree-body .tree-item-self[data-path]").length;
    }, box);
    if (n > 0) {
      found = true;
      break;
    }
    await sleep(100);
  }
  return { ms: Date.now() - t0, found };
}

export function summarize(checks) {
  const pass = checks.filter((c) => c.结论 === "PASS").length;
  const fail = checks.filter((c) => c.结论 === "FAIL");
  const pending = checks.filter((c) => c.结论 === "PENDING");
  return {
    checks,
    汇总: `${pass}/${checks.length} PASS${pending.length ? `，${pending.length} PENDING` : ""}`,
    失败项: fail,
    待实现: pending,
  };
}

export function parityCheck(checks, name, nativePass, singlePass, evidence) {
  if (nativePass !== true) {
    checks.push({ 检查: `${name}（原生基准）`, 结论: "FAIL", 证据: evidence });
    return;
  }
  checks.push({
    检查: name,
    结论: singlePass ? "PASS" : "PENDING",
    证据: evidence,
    说明: singlePass ? undefined : "单库树尚未统一，按方案 P2/P3/P4 实现",
  });
}
