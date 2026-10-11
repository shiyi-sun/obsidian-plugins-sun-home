/*
建（或补齐）测试沙箱知识库 __kb自测__，让整套用例可以反复跑。
结构：根笔记1/2/3.md、说明.md、子文件夹A(笔记A1/A2.md)、子文件夹B(笔记B1.md)
*/
import { READY, MARK_RELOAD } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENSURE = (box) =>
  (async () => {
    const v = window.app.vault;
    const exists = (p) => !!v.getAbstractFileByPath(p);
    const put = async (p, text) => {
      if (exists(p)) return "已有";
      await v.create(p, text);
      return "新建";
    };
    const out = {};
    if (!exists(box)) {
      await v.createFolder(box);
      out[box] = "新建文件夹";
    }
    for (const f of ["说明.md", "根笔记1.md", "根笔记2.md", "根笔记3.md"]) out[f] = await put(`${box}/${f}`, `# ${f.replace(".md", "")}\n\n插件实测沙箱文件，可安全删除。\n`);
    for (const d of ["子文件夹A", "子文件夹B"]) if (!exists(`${box}/${d}`)) await v.createFolder(`${box}/${d}`);
    out["A/笔记A1"] = await put(`${box}/子文件夹A/笔记A1.md`, "# A1\n");
    out["A/笔记A2"] = await put(`${box}/子文件夹A/笔记A2.md`, "# A2\n");
    out["B/笔记B1"] = await put(`${box}/子文件夹B/笔记B1.md`, "# B1\n");
    // 剪掉上一轮其他用例留下的多余文件，保证每轮起点一致
    const expect = new Set([
      `${box}/说明.md`, `${box}/根笔记1.md`, `${box}/根笔记2.md`, `${box}/根笔记3.md`,
      `${box}/子文件夹A/笔记A1.md`, `${box}/子文件夹A/笔记A2.md`, `${box}/子文件夹B/笔记B1.md`,
    ]);
    const pruned = [];
    for (const f of v.getFiles()) {
      if (f.path.startsWith(box + "/") && !expect.has(f.path)) {
        await v.trash(f, true);
        pruned.push(f.path);
      }
    }
    return { 结果: out, 清掉的多余文件: pruned, 文件清单: v.getFiles().filter((f) => f.path.startsWith(box + "/")).map((f) => f.path).sort() };
  })();

const EXPECT_COUNT = 7;

export default async (ctx) => {
  const rep = {};
  ctx.progress.push(rep);
  await ctx.page(MARK_RELOAD);
  await ctx.reloadApp();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const r = await ctx.page(READY);
    if (r.新文档 && r.ready) break;
    await sleep(700);
  }
  rep.沙箱 = await ctx.page(ENSURE, "__kb自测__");
  await sleep(1200);
  rep.卡片在不在 = await ctx.page((box) => {
    const el = [...document.querySelectorAll(".kb-card")].find((c) => c.dataset.path === box);
    return { 有卡片: !!el, 库数: document.querySelectorAll(".kb-card").length };
  }, "__kb自测__");
  const checks = [
    {
      检查: `沙箱齐备 ${EXPECT_COUNT} 个文件`,
      结论: rep.沙箱.文件清单.length === EXPECT_COUNT ? "PASS" : "FAIL",
      证据: rep.沙箱,
    },
    {
      检查: "沙箱卡片出现在知识库列表",
      结论: rep.卡片在不在.有卡片 ? "PASS" : "FAIL",
      证据: rep.卡片在不在,
    },
  ];
  rep.checks = checks;
  rep.汇总 = `${checks.filter((c) => c.结论 === "PASS").length}/${checks.length} PASS`;
  rep.失败项 = checks.filter((c) => c.结论 === "FAIL");
  rep.结论 = rep.失败项.length ? "沙箱未就绪" : "沙箱就绪";
  return rep;
};
