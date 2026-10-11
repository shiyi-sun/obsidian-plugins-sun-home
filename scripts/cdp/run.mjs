/*
在真实 Obsidian 里驱动/观测本插件的测试助手（不是单元测试，需要一个能用的 GUI 实例）。

用法：
  1) 退出 Obsidian，带调试端口重启（端口值必须是裸数字，写 127.0.0.1:9223 会静默不监听）：
       /opt/Obsidian/obsidian --remote-debugging-port=9223 &
  2) 跑单个测试：node scripts/cdp/run.mjs scripts/cdp/t1-click.mjs
       或全部：npm run test:live
  3) 测完用不带调试端口的原命令重启 Obsidian（调试端口对本机其他进程是开放的）。

约定：
  - 测试文件 default-export async (ctx) => report；ctx.page(fn, ...args) 把 fn 的源码
    搬到渲染进程执行，所以 fn 内只能引用页面全局与参数，不能引用 Node 闭包变量。
  - 点击一律走 Input.dispatchMouseEvent（真鼠标手势）。合成 el.click() 复现不了
    「按下与松开之间 DOM 被重建 → click 丢失」这类问题。
  - 沙箱库名硬编码 __kb自测__，测完跑 t12-cleanup.mjs 删除它并清设置痕迹。
*/
import fs from "node:fs";
import path from "node:path";

const PORT = 9223;

/** 等 Obsidian 的渲染 target 可用：上一条用例常以 Page.reload 收尾，此刻 target 会短暂缺席 */
async function waitForTarget(ms = 40000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (p) return p;
      last = "列表里没有页面 target";
    } catch (e) {
      last = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`等不到 Obsidian 调试 target（端口 ${PORT}）：${last}`);
}

const pageTarget = await waitForTarget();

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let seq = 0;
const waiting = new Map();
const consoleErrors = [];
const pageExceptions = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
    return;
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    pageExceptions.push((d.exception?.description || d.text || "").split("\n").slice(0, 4).join(" | "));
  }
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
    consoleErrors.push(
      m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 300)
    );
  }
});

const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    waiting.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalInPage(expression) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.error) {
      // 页面正在重载/上下文丢失时 CDP 会回 error，重试即可
      if (attempt < 7) {
        await sleep(500);
        continue;
      }
      throw new Error("CDP 错误: " + JSON.stringify(r.error));
    }
    if (!r.result) throw new Error("CDP 无 result: " + JSON.stringify(r).slice(0, 400));
    if (r.result.exceptionDetails) {
      throw new Error(
        "页面内异常: " +
          (r.result.exceptionDetails.exception?.description ||
            JSON.stringify(r.result.exceptionDetails).slice(0, 500))
      );
    }
    return r.result.result?.value;
  }
}

/** 把 Node 侧的函数源码搬到页面里执行（函数体只能用页面全局，不能引用 Node 闭包） */
async function page(fn, ...args) {
  const expr = `(async () => { return (${fn.toString()}).apply(null, ${JSON.stringify(args)}) })()`;
  return evalInPage(expr);
}

async function mouse(type, x, y, button = "left", clickCount = 1, modifiers = 0) {
  const buttons =
    type === "mouseReleased"
      ? 0
      : button === "left"
        ? 1
        : button === "right"
          ? 2
          : button === "middle"
            ? 4
            : 0;
  await send("Input.dispatchMouseEvent", { type, x, y, button, clickCount, buttons, modifiers });
}

const ctx = {
  progress: [],
  note: (o) => ctx.progress.push(o),
  sleep,
  evalInPage,
  page,
  /** 真实浏览器手势：pointerdown → mousedown → mouseup → click */
  /** modifiers：CDP 位掩码，Alt=1、Ctrl=2、Meta=4、Shift=8 */
  async click(x, y, button = "left", modifiers = 0) {
    await mouse("mousePressed", x, y, button, 1, modifiers);
    await sleep(30);
    await mouse("mouseReleased", x, y, button, 1, modifiers);
    await sleep(30);
  },
  async move(x, y) {
    await mouse("mouseMoved", x, y);
  },
  /** 截图留证（视觉类改动光看数字不够，得能拿出图） */
  async screenshot(file) {
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
    return file;
  },
  /** 单步派发一个原生鼠标事件（拖拽中途要读 DOM 时用） */
  async raw(type, x, y, button = "left") {
    await mouse(type, x, y, button);
  },
  async drag(from, to, steps = 12) {
    await mouse("mouseMoved", from.x, from.y);
    await mouse("mousePressed", from.x, from.y);
    for (let i = 1; i <= steps; i++) {
      await mouse(
        "mouseMoved",
        Math.round(from.x + ((to.x - from.x) * i) / steps),
        Math.round(from.y + ((to.y - from.y) * i) / steps)
      );
      await sleep(25);
    }
    await mouse("mouseReleased", to.x, to.y);
  },
  async key(key, code, vk, modifiers = 0) {
    const common = { key, code, windowsVirtualKeyCode: vk, modifiers };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...common });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  },
  /** Ctrl+A 全选后 Delete 清空，再插入文本（模拟人改输入框的做法） */
  async clearAndType(text) {
    await ctx.key("a", "KeyA", 65, 2);
    await ctx.key("Delete", "Delete", 46);
    await sleep(60);
    await send("Input.insertText", { text });
  },
  async type(text) {
    await send("Input.insertText", { text });
  },
  reloadApp: () => send("Page.reload", { ignoreCache: false }),
  get consoleErrors() {
    return consoleErrors;
  },
  get pageExceptions() {
    return pageExceptions;
  },
};

const testFile = process.argv[2];
const mod = await import("file://" + path.resolve(testFile));
let result;
try {
  result = await mod.default(ctx);
} catch (err) {
  result = { FATAL: String(err && err.message ? err.message : err), stack: String(err?.stack).split("\n").slice(0, 4) };
}
console.log(JSON.stringify({ result, progress: ctx.progress, pageExceptions, consoleErrors }, null, 2));
ws.close();
process.exit(0);
