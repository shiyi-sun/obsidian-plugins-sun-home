// 页面内注入的公共探针（这些函数会被 fn.toString() 序列化后在页面里执行，
// 因此函数体内只能引用页面全局，不能用 Node 闭包变量）
export const INSTALL = () => {
  const app = window.app;
  const plugin = app.plugins.plugins["kb-home"];
  const leaf = app.workspace.getLeavesOfType("kb-tree-view")[0];
  const view = leaf?.view;
  // 认 getViewType，不认类名：压缩后类名可能带上前缀（曾整批用例因此误判「未实体化」）
  if (view?.getViewType?.() !== "kb-tree-view")
    return { ok: false, reason: "树视图未实体化", ctor: view?.getViewType?.() ?? String(view) };

  window.__probe = { events: [] };
  const push = (e) => window.__probe.events.push({ t: Date.now(), ...e });

  const oOpen = plugin.openNote.bind(plugin);
  plugin.openNote = async (f) => {
    push({ ev: "openNote", path: f.path });
    return oOpen(f);
  };
  const oRender = view.render.bind(view);
  // 旧版（1.3.3）没有 rebuild()，render() 自身就重建 DOM；新版 render() 只是请求
  const hasRebuild = typeof view.rebuild === "function";
  view.render = () => {
    push({ ev: "render?", inGesture: !!view.inGesture, pending: !!view.pendingRender });
    if (!hasRebuild) push({ ev: "rebuild!" });
    return oRender();
  };
  if (hasRebuild) {
    const oRebuild = view.rebuild.bind(view);
    view.rebuild = () => {
      push({ ev: "rebuild!" });
      return oRebuild();
    };
  }
  const oToggle = view.toggleCollapseAll.bind(view);
  view.toggleCollapseAll = () => {
    push({ ev: "toggleCollapseAll" });
    return oToggle();
  };
  window.__probePush = push;

  for (const t of ["pointerdown", "mousedown", "mouseup", "click", "contextmenu"]) {
    document.addEventListener(
      t,
      (e) => {
        const row = e.target?.closest?.(".tree-item-self") || e.target?.closest?.(".kb-card");
        push({
          ev: t,
          rowPath: row?.dataset?.path ?? null,
          target: (e.target?.className || "").toString().split(" ")[0] || e.target?.nodeName,
          x: Math.round(e.clientX),
          y: Math.round(e.clientY),
        });
      },
      true
    );
  }
  app.workspace.on("active-leaf-change", (l) =>
    push({ ev: "leaf-change", type: l?.view?.getViewType?.() ?? null })
  );
  app.workspace.on("file-open", (f) => push({ ev: "file-open", path: f?.path ?? null }));
  return { ok: true };
};

export const RESET = () => {
  window.__probe.events = [];
};

export const EVENTS = () => window.__probe.events.slice();

export const ROWS = () => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  if (view?.getViewType?.() !== "kb-tree-view") return { err: "no kb-tree-view" };
  const order = window.app.plugins.plugins["kb-home"].settings.order.items[view.currentPath];
  return {
    currentPath: view.currentPath,
    autoReveal: view.autoReveal,
    // 排序方式与手动顺序都在与原生树共用的那一份里
    sortOrder: order?.sortOrder ?? null,
    customOrder: order?.customOrder ?? null,
    collapsed: [...view.collapsed],
    // 行结构与原生文件树一致：.tree-item(.nav-folder|.nav-file) > .tree-item-self[data-path]
    rows: [...view.containerEl.querySelectorAll(".kb-tree-body .tree-item")].map((el) => {
      const self = el.querySelector(":scope > .tree-item-self");
      const r = (self || el).getBoundingClientRect();
      return {
        path: self?.dataset?.path ?? null,
        kind: el.dataset.kind,
        active: !!self?.classList.contains("is-active"),
        hidden: el.classList.contains("kb-hidden"),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      };
    }),
  };
};

export const READY = () => {
  const app = window.app;
  return {
    新文档: typeof window.__beforeReload === "undefined",
    ready: typeof window.__beforeReload === "undefined" && !!app?.plugins?.plugins?.["kb-home"],
    cards: document.querySelectorAll(".kb-card").length,
    explorerRows: document.querySelectorAll(
      '[data-type="file-explorer"] .nav-file-title, [data-type="file-explorer"] .nav-folder-title'
    ).length,
  };
};

export const MARK_RELOAD = () => {
  window.__beforeReload = true;
  return true;
};

export const STATE = () => ({
  activeFile: window.app.workspace.getActiveFile()?.path ?? null,
  高亮行: [...document.querySelectorAll(".kb-tree-body .nav-file-title.is-active")].map(
    (e) => e.dataset.path
  ),
});

/** 单库树里某条目的行矩形（行 = .tree-item-self，与原生一样带 data-path） */
export const ROW_RECT = (path) => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  const el = view?.containerEl.querySelector(`.kb-tree-body .tree-item-self[data-path="${path}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

/** 把原生文件浏览器切到前台（左栏同一时刻只渲染一个面板，不切过去就量不到行） */
export const SHOW_EXPLORER = () => {
  const ws = window.app.workspace;
  const leaf = ws.getLeavesOfType("file-explorer")[0];
  if (!leaf) return "无 file-explorer leaf";
  if (ws.leftSplit?.collapsed) ws.leftSplit.expand();
  ws.revealLeaf(leaf);
  return true;
};

/** 把某条路径在原生树里的所有祖先文件夹展开；折叠状态下子项根本不在 DOM 里 */
export const EXPAND_CHAIN = (path) => {
  const parts = path.split("/");
  const done = [];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? acc + "/" + parts[i] : parts[i];
    const t = document.querySelector(`[data-type="file-explorer"] .nav-folder-title[data-path="${acc}"]`);
    const box = t?.closest(".nav-folder");
    if (box && box.classList.contains("is-collapsed") && t) {
      t.click();
      done.push(acc);
    }
  }
  return done;
};

export const NATIVE_ROW = (p) => {
  const el = document.querySelector(
    `[data-type="file-explorer"] .nav-file-title[data-path="${p}"], [data-type="file-explorer"] .nav-folder-title[data-path="${p}"]`
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
};
