/*
跨文件夹单击回归：当前笔记在另一个文件夹、树已滚到别处时，单击目标笔记必须一次生效。

复现条件：点击侧栏会让 active-leaf-change 夹在按下与松开之间触发；
如果自动定位此时把视口拽回旧笔记并重建行，正在按下的行会被销毁，click 丢失。
*/
const SANDBOX = "__kb自测__";
const ROOT = `${SANDBOX}/点击回归`;
const FOLDER_1 = `${ROOT}/目标文件夹`;
const FOLDER_2 = `${ROOT}/当前文件夹`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = async (box, root, folder1, folder2) => {
  const v = window.app.vault;
  const plugin = window.app.plugins.plugins["sun-home"];
  const existing = v.getAbstractFileByPath(root);
  if (existing) await v.delete(existing, true);
  if (!v.getAbstractFileByPath(box)) await v.createFolder(box);
  await v.createFolder(root);
  await v.createFolder(folder1);
  await v.createFolder(folder2);
  for (let i = 0; i < 35; i++) {
    const n = String(i).padStart(2, "0");
    await v.create(`${folder1}/目标-${n}.md`, `# 目标 ${n}\n`);
    await v.create(`${folder2}/当前-${n}.md`, `# 当前 ${n}\n`);
  }

  if (window.app.workspace.leftSplit?.collapsed) window.app.workspace.leftSplit.expand();
  await plugin.openKbTree({ path: root, name: "点击回归", docCount: 0, groupId: null });
  await new Promise((r) => setTimeout(r, 600));

  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  const body = view?.containerEl.querySelector(".kb-tree-body");
  if (!body) return { err: "没有树主体" };

  // 不依赖排序规则：先按当前渲染顺序取最上面和最下面的文件行，记路径；
  // 打开活动笔记会重绘窗口，行元素会失效，滚回顶部后必须按路径重新取。
  const fileRows = [...body.querySelectorAll(".tree-item.nav-file")]
    .map((item) => item.querySelector(":scope > .tree-item-self[data-path]"))
    .filter(Boolean);
  if (fileRows.length < 70) {
    return { err: "文件行不足", files: fileRows.length, currentPath: view.currentPath };
  }
  const target = fileRows[0].dataset.path;
  const active = fileRows[fileRows.length - 1].dataset.path;
  const targetParent = target.slice(0, target.lastIndexOf("/"));
  const activeParent = active.slice(0, active.lastIndexOf("/"));

  await plugin.openNote(v.getAbstractFileByPath(active));
  await new Promise((r) => setTimeout(r, 600));
  body.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 500));

  const rowByPath = (path) =>
    [...body.querySelectorAll(".tree-item.nav-file > .tree-item-self[data-path]")].find(
      (el) => el.dataset.path === path
    );
  const topRow = rowByPath(target);
  const bottomRow = rowByPath(active);
  if (!topRow || !bottomRow) return { err: "滚回顶部后找不到目标行", target, active };

  const probe = { events: [] };
  const push = (ev, data = {}) => probe.events.push({ t: Date.now(), ev, ...data });
  window.__clickProbe = probe;

  const oOpen = plugin.openNote.bind(plugin);
  plugin.openNote = async (file) => {
    push("openNote", { path: file.path });
    return oOpen(file);
  };

  const renderer = view.renderer;
  if (renderer) {
    const oScroll = renderer.scrollToPath.bind(renderer);
    renderer.scrollToPath = (path) => {
      push("scrollToPath", { path, inGesture: !!view.inGesture, scrollTop: body.scrollTop });
      return oScroll(path);
    };
    const oRender = renderer.render.bind(renderer);
    renderer.render = (top) => {
      push("renderer.render", { inGesture: !!view.inGesture, top, scrollTop: body.scrollTop });
      return oRender(top);
    };
  }
  const oRebuild = view.rebuild.bind(view);
  view.rebuild = () => {
    push("rebuild", { inGesture: !!view.inGesture });
    return oRebuild();
  };
  window.app.workspace.on("active-leaf-change", () => {
    push("active-leaf-change", {
      type: window.app.workspace.activeLeaf?.view?.getViewType?.() ?? null,
      active: window.app.workspace.getActiveFile()?.path ?? null,
    });
  });

  let pressed = null;
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
    document.addEventListener(
      type,
      (e) => {
        const row = e.target?.closest?.(".tree-item-self");
        if (type === "pointerdown") pressed = row;
        push(type, {
          row: row?.dataset?.path ?? null,
          samePressed: pressed ? row === pressed : null,
          pressedConnected: pressed ? pressed.isConnected : null,
        });
      },
      true
    );
  }

  const rect = topRow.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const activeTop = bottomRow.getBoundingClientRect().top;
  return {
    ok: true,
    target,
    active,
    differentFolders: targetParent !== activeParent,
    targetRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    activeOffscreen: activeTop > bodyRect.bottom || activeTop + bottomRow.offsetHeight < bodyRect.top,
    scrollTop: body.scrollTop,
    clientHeight: body.clientHeight,
  };
};

const AFTER = async (target, active) => {
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  const body = view?.containerEl.querySelector(".kb-tree-body");
  const events = window.__clickProbe?.events ?? [];
  return {
    activeFile: window.app.workspace.getActiveFile()?.path ?? null,
    expected: target,
    previous: active,
    scrollTop: body?.scrollTop ?? null,
    inGesture: !!view?.inGesture,
    events,
  };
};

const REVEAL = async (path) => {
  const plugin = window.app.plugins.plugins["sun-home"];
  const view = window.app.workspace.getLeavesOfType("kb-tree-view")[0]?.view;
  const body = view?.containerEl.querySelector(".kb-tree-body");
  const before = body?.scrollTop ?? null;
  await plugin.openNote(window.app.vault.getAbstractFileByPath(path));
  await new Promise((r) => setTimeout(r, 700));
  return { before, after: body?.scrollTop ?? null, active: window.app.workspace.getActiveFile()?.path ?? null };
};

export default async (ctx) => {
  const rep = { checks: [] };
  const add = (name, pass, evidence) =>
    rep.checks.push({ 检查: name, 结论: pass ? "PASS" : "FAIL", 证据: evidence });

  const setup = await ctx.page(SETUP, SANDBOX, ROOT, FOLDER_1, FOLDER_2);
  rep.setup = setup;
  if (!setup?.ok) {
    // 初始化失败也不能把 70 个文件留给后面的用例
    const cleaned = await ctx.page((root) => {
      const v = window.app.vault;
      return (async () => {
        const folder = v.getAbstractFileByPath(root);
        if (folder) await v.delete(folder, true);
        return !v.getAbstractFileByPath(root);
      })();
    }, ROOT);
    add("测试树就绪", false, { ...setup, 已清理: cleaned });
    rep.汇总 = "0/1 PASS";
    rep.失败项 = rep.checks;
    return rep;
  }

  add("目标笔记和当前笔记分属不同文件夹", setup.differentFolders, {
    目标: setup.target,
    当前: setup.active,
  });
  add("点前当前笔记在视口外、目标行在视口内", setup.activeOffscreen, {
    scrollTop: setup.scrollTop,
    行高: setup.targetRect.h,
  });

  const b = setup.targetRect;
  const x = Math.round(b.x + b.w / 2);
  const y = Math.round(b.y + b.h / 2);
  await ctx.move(x, y);
  await sleep(80);
  await ctx.click(x, y);
  await sleep(900);

  const after = await ctx.page(AFTER, setup.target, setup.active);
  const ev = after.events;
  const click = ev.find((e) => e.ev === "click");
  const pointerdown = ev.find((e) => e.ev === "pointerdown");
  const gestureRebuilds = ev.filter(
    (e) => ["rebuild", "renderer.render", "scrollToPath"].includes(e.ev) && e.inGesture
  );

  add("单击一次就切到目标笔记", after.activeFile === setup.target, {
    期望: setup.target,
    实际: after.activeFile,
  });
  add(
    "按下与松开落在同一行，click 到达目标",
    !!click &&
      click.row === setup.target &&
      click.samePressed === true &&
      click.pressedConnected === true &&
      pointerdown?.row === setup.target,
    { pointerdown, click }
  );
  add("手势期间没有重绘或自动定位", gestureRebuilds.length === 0, gestureRebuilds);
  add("视口没有被拽回当前笔记", Math.abs((after.scrollTop ?? 0) - setup.scrollTop) <= 2, {
    点前: setup.scrollTop,
    点后: after.scrollTop,
  });

  const reveal = await ctx.page(REVEAL, setup.active);
  add("自动定位仍有效：外部切回底部笔记会滚过去", (reveal.after ?? 0) > 400, reveal);

  const cleanup = await ctx.page((root) => {
    const v = window.app.vault;
    return (async () => {
      const folder = v.getAbstractFileByPath(root);
      if (folder) await v.delete(folder, true);
      return !v.getAbstractFileByPath(root);
    })();
  }, ROOT);
  add("收尾：测试目录已清理", cleanup === true, { 目录: ROOT });

  rep.汇总 = `${rep.checks.filter((c) => c.结论 === "PASS").length}/${rep.checks.length} PASS`;
  rep.失败项 = rep.checks.filter((c) => c.结论 === "FAIL");
  rep.结论 = rep.失败项.length
    ? "FAIL：跨文件夹单击仍可能丢失或视口被拽走"
    : "PASS：跨文件夹单击一次生效，手势期间不重建 DOM";
  return rep;
};
