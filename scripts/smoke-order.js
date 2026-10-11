/**
 * 冒烟测试：验证 OrderManager.move() 的顺序计算与 onChanged 回调。
 * 直接跑 node scripts/smoke-order.js
 *
 * 它不是完整的单测（没有 Obsidian 运行环境），只覆盖纯逻辑部分：
 * - 同文件夹内换位时 customOrder 是否正确
 * - 父文件夹未变化时 onChanged 是否被调用（这是「拖拽之后无效」的修复点）
 * - 跨文件夹移动时 onChanged 不应被调用（交给 vault rename 事件处理）
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

// --- 极简 obsidian 存根 ---
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-home-stub-"));
const obsidianStub = path.join(stubDir, "obsidian.js");
fs.writeFileSync(
  obsidianStub,
  `class TFile { constructor(path){ this.path=path; this.name=path.split('/').pop(); this.extension='md'; } }
   class TFolder { constructor(path){ this.path=path; this.name=path.split('/').pop()||'/'; this.children=[]; } }
   module.exports = { TFile, TFolder, TAbstractFile: class {} };`
);

// 用 require 钩子把 "obsidian" 指到存根
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "obsidian") return obsidianStub;
  return origResolve.call(this, request, ...rest);
};

// 先把纯逻辑模块现场编出来：脚本自带构建，不留一份"得先手动跑某条命令"的产物
require("esbuild").buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "core", "order-manager.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["obsidian"],
  outfile: path.join(__dirname, "..", ".smoke-build", "order-manager.js"),
  logLevel: "silent",
});

const { OrderManager } = require("../.smoke-build/order-manager.js");

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`      期望: ${JSON.stringify(expected)}`);
    console.log(`      实际: ${JSON.stringify(actual)}`);
    failed++;
  }
};

const settings = {
  items: {
    "/": { isPinned: false, isHidden: false, customOrder: ["a.md", "b.md", "c.md"], sortOrder: "custom" },
    "a.md": { isPinned: false, isHidden: false },
    "b.md": { isPinned: false, isHidden: false },
    "c.md": { isPinned: false, isHidden: false },
    "sub": { isPinned: false, isHidden: false, customOrder: [], sortOrder: "custom" },
  },
  showHidden: false,
  hidePatterns: [],
  newItemPlacement: "bottom",
  persistOrderOnCreateDelete: true,
  debugMode: false,
};

let changedCount = 0;
const mgr = new OrderManager(
  () => settings,
  () => [],
  () => {},
  () => {
    changedCount++;
  }
);

// 场景 1：把 a.md 拖到 c.md 之后 → 期望 b, c, a
changedCount = 0;
mgr.move("a.md", "a.md", "c.md", "after");
check("同文件夹：a 移到 c 之后", settings.items["/"].customOrder, ["b.md", "c.md", "a.md"]);
check("同文件夹：触发 onChanged", changedCount, 1);

// 场景 2：把 a.md（现在在末尾）拖到最前面（b 之前）→ 期望 a, b, c
changedCount = 0;
mgr.move("a.md", "a.md", "b.md", "before");
check("同文件夹：a 移回最前", settings.items["/"].customOrder, ["a.md", "b.md", "c.md"]);
check("同文件夹：再次触发 onChanged", changedCount, 1);

// 场景 3：把 a.md 移入 sub 文件夹
changedCount = 0;
settings.items["sub"].customOrder = [];
mgr.move("a.md", "sub/a.md", undefined, undefined);
check(
  "跨文件夹：从根目录移除 a.md",
  settings.items["/"].customOrder,
  ["b.md", "c.md"]
);
check("跨文件夹：a.md 加入 sub", settings.items["sub"].customOrder, ["a.md"]);
check("跨文件夹：不触发 onChanged（交给 vault rename 事件）", changedCount, 0);

// 场景 4：不存在的路径不应崩溃、也不应触发
changedCount = 0;
mgr.move("nope.md", "nope.md", "b.md", "before");
check("不存在的源路径：不触发 onChanged", changedCount, 0);

fs.rmSync(stubDir, { recursive: true, force: true });

console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
