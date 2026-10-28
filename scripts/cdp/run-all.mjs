/*
依次跑 scripts/cdp 下的实测用例（前提见 run.mjs 顶部说明：Obsidian 需带调试端口启动）。
任何一条失败都会如实反映在退出码上（1 = 有用例未跑成或断言未通过）。
*/
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const cases = [
  "t0-sandbox.mjs", // 先建好沙箱库，保证整套用例可反复跑
  "t1-click.mjs", // 单击切换笔记（本次修复的回归点）
  "t2-toolbar-menu.mjs", // 树工具条 + 右键菜单 + 新建/重命名/删除
  "t4-menus-lifecycle.mjs", // 菜单去重 / 卸载清残留 / 分组删除确认
  "t3-dnd.mjs", // 树内拖拽调序 / 移入文件夹 / 卡片墙拖拽
  "t5-cardwall.mjs", // 卡片墙拖拽：同级重排 + 拖进折叠分组放置区
  "t11-native2.mjs", // 原生文件浏览器的自定义顺序 / 排序菜单 / 置顶
  "t8-persistence.mjs", // 落盘、重启恢复、ribbon 与命令
  "t14-migration.mjs", // 旧虚拟分组 → 真实文件夹迁移 + 路径状态迁移
  "t15-group-order.mjs", // 分组标题拖拽调整分组之间的显示顺序
  "t13-admonition.mjs", // 提示块渲染 + 增量重算探针 + 设置页开关
  "t12-cleanup.mjs", // 删除沙箱库并清掉测试写入的设置
];

const outDir = path.join(os.tmpdir(), "kb-home-cdp");
fs.mkdirSync(outDir, { recursive: true });
const results = [];
for (const c of cases) {
  const r = spawnSync(process.execPath, [path.join(dir, "run.mjs"), path.join(dir, c)], {
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(outDir, c + ".json"), r.stdout || "");
  let 摘要 = null;
  let 失败项 = null;
  let 异常 = null;
  let 告警 = null;
  let 致命 = null;
  let 无断言 = false;
  try {
    const d = JSON.parse(r.stdout);
    摘要 = d.result?.汇总 ?? d.result?.结论 ?? null;
    致命 = d.result?.FATAL ? "FATAL: " + d.result.FATAL : null;
    // 失败项有两种来源：显式的 失败项 数组，或从 checks 里挑出非 PASS/SKIP 的条目。
    // 以前只看 失败项，导致只写 checks（或只写 结论）的用例就算全 FAIL 也是绿的。
    const checks = Array.isArray(d.result?.checks) ? d.result.checks : null;
    失败项 =
      d.result?.失败项?.map((x) => x.检查) ??
      checks?.filter((x) => x.结论 !== "PASS" && x.结论 !== "SKIP").map((x) => x.检查) ??
      null;
    无断言 = !checks && !d.result?.失败项;
    // 未捕获的页面异常判红；控制台 warning 多是 Obsidian 自身噪音，只报告
    异常 = (d.pageExceptions || []).slice(0, 3);
    告警 = (d.consoleErrors || []).slice(0, 3);
  } catch (e) {
    // 不吞子进程的真实报错：没解析出 JSON 时把 stderr / signal / 退出码原样带出来
    异常 = [
      `退出码=${r.status} signal=${r.signal || "无"} err=${r.error?.message || "无"}`,
      "stderr: " + String(r.stderr || "").slice(-600),
      "stdout: " + String(r.stdout || "").slice(0, 200),
    ];
  }
  results.push({
    用例: c,
    退出码: r.status,
    汇总: 摘要 ?? 致命,
    失败项,
    异常,
    告警,
    无断言,
  });
  console.log(`\n### ${c} → 退出码 ${r.status}${摘要 ? " | " + 摘要 : ""}${致命 ? " | " + 致命 : ""}`);
  if (失败项?.length) console.log("   未通过：", 失败项.join("；"));
  if (无断言) console.log("   ⚠ 这条用例没有 checks/失败项，断言没被执行到也算绿 → 判红");
  if (异常?.length) console.log("   页面异常：", 异常.join(" | "));
  if (告警?.length) console.log("   控制台告警（不判红）：", 告警.join(" | "));
}

// run.mjs 无论断言过没过都 exit(0)，所以「绿」必须同时满足：
// 子进程正常退出 + 没有断言 FAIL + 没有 FATAL + 没有未捕获的页面异常。
const bad = results.filter(
  (x) =>
    x.退出码 !== 0 ||
    x.失败项?.length ||
    x.汇总?.startsWith("FATAL") ||
    x.汇总?.startsWith("FAIL") ||
    x.无断言 ||
    x.异常?.length
);
const 断言未过 = results.filter((x) => x.失败项?.length);
console.log(`完整输出：${outDir}/<用例>.json`);
console.log(
  `\n总计 ${results.length} 条用例，${results.length - bad.length} 条通过，${bad.length} 条不通过` +
    (断言未过.length ? `（其中 ${断言未过.length} 条有断言 FAIL）` : "")
);
process.exit(bad.length ? 1 : 0);
