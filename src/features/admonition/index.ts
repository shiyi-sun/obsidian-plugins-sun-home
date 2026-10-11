/**
 * 提示块功能（原 admonition-blocks 插件整合进来，作为底座的第一个 Feature）。
 *
 * 语法：
 *   :::tip 标题          内容可含 Markdown、列表、嵌套块
 *   :::
 *   :::tip+ 可折叠（默认展开）      :::tip- 默认收起
 */
import { MarkdownPostProcessorContext, Setting } from "obsidian";
import type { Feature, FeatureContext } from "../../framework/feature";
import { buildEditorExtension, refreshEditors } from "./editor";
import type { EditorProbe } from "./editor";
import { renderAdmonitionsInSection, refreshPreviews } from "./reading";

export interface AdmonitionConfig {
  /** 阅读视图渲染 */
  inReading: boolean;
  /** 实时预览渲染 */
  inEditor: boolean;
}

/** 阅读侧计数：证明闸门到底跳没跳，跳了几段 */
export interface ReadingProbe {
  /** 后处理器被调到的段数 */
  sectionsSeen: number;
  /** 因为「整段源码里没有 :::」而直接跳过的段数 */
  sectionsSkipped: number;
  /** getSectionInfo 拿不到信息的次数（编辑器 widget 内部的二次渲染就是这样） */
  sectionInfoNull: number;
}

export const DEFAULT_ADMONITION: AdmonitionConfig = {
  inReading: true,
  inEditor: true,
};

export class AdmonitionFeature implements Feature {
  readonly id = "admonition";
  readonly settingsTitle = "提示块（::: 语法）";

  /** 供实机测试读取：证明「沿用缓存」这条便宜路径真的在跑，而不是永远全文重扫 */
  readonly editorProbe: EditorProbe = { scanAll: 0, reuse: 0, fromCache: 0, widgetDoms: 0 };
  readonly readingProbe: ReadingProbe = {
    sectionsSeen: 0,
    sectionsSkipped: 0,
    sectionInfoNull: 0,
  };

  attach(ctx: FeatureContext): void {
    const cfg = (): AdmonitionConfig => ctx.settings().admonition;

    ctx.registerEditorExtension(
      buildEditorExtension({ app: ctx.app, getSettings: cfg, probe: this.editorProbe })
    );

    ctx.registerMarkdownPostProcessor(
      (el: HTMLElement, mctx: MarkdownPostProcessorContext) => {
        if (!cfg().inReading) return;
        this.readingProbe.sectionsSeen++;

        // 闸门：整段源码里压根没有 ::: 就什么都不做。
        // getSectionInfo 拿不到信息时不跳过 —— 宁可多做一次遍历，也不能漏渲染。
        const info = mctx.getSectionInfo(el);
        if (!info) {
          this.readingProbe.sectionInfoNull++;
        } else if (!info.text.includes(":::")) {
          this.readingProbe.sectionsSkipped++;
          return;
        }

        // 纯 DOM 归组，同步做完即可：不产生需要回收的子对象
        renderAdmonitionsInSection(el);
      }
    );
  }

  renderSettings(containerEl: HTMLElement, ctx: FeatureContext): void {
    const cfg = (): AdmonitionConfig => ctx.settings().admonition;

    containerEl.createEl("p", {
      cls: "kb-setting-hint",
      text: "在笔记里用 :::tip / :::note / :::info / :::warning / :::danger 包裹内容即渲染成提示块；:::tip+ 可折叠，:::tip- 默认收起；:::tip[方括号] 与「:::tip 空格」都能写标题。",
    });

    new Setting(containerEl)
      .setName("实时预览中渲染")
      .setDesc("光标移入块内会临时回退成源码以便编辑，移出后重新渲染。")
      .addToggle((t) =>
        t.setValue(cfg().inEditor).onChange(async (v) => {
          ctx.settings().admonition.inEditor = v;
          await ctx.save();
          refreshEditors(ctx.app);
        })
      );

    new Setting(containerEl)
      .setName("阅读视图渲染")
      .setDesc("关闭后显示为普通文本。")
      .addToggle((t) =>
        t.setValue(cfg().inReading).onChange(async (v) => {
          ctx.settings().admonition.inReading = v;
          await ctx.save();
          refreshPreviews(ctx.app);
        })
      );
  }
}
