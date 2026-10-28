/**
 * 功能底座：把「附加功能」的装配集中到一处，并让单个功能故障只降级自己。
 *
 * 设计约束（刻意保守）：
 * - 钩子只活在装配期（attach / detach / renderSettings）。运行期热路径不经过这里 ——
 *   功能要注册的编辑器扩展、markdown 后处理器一律直连 Obsidian，中间零跳板。
 * - 不做通用事件总线、不做字符串命名的 hook 表、不做运行时动态加载。
 *   本仓库现在只有三个消费方，多的那一层只会让代码没人接得了手。
 */
import type { Extension } from "@codemirror/state";
import {
  App,
  Command,
  EventRef,
  MarkdownPostProcessorContext,
  Notice,
  Plugin,
  Setting,
} from "obsidian";
import type { KbSettings } from "../data";

/** 装配期交给功能的唯一入口。功能不直接持有 Plugin 实例，避免拿到无关的私有面。 */
export interface FeatureContext {
  app: App;
  /** 读当前设置（每次调用都取最新，避免闭包过期） */
  settings: () => KbSettings;
  /** 立即落盘（不刷新视图）。用户显式操作后用这个，保证不丢 */
  save: () => Promise<void>;
  /** 防抖落盘。高频 vault 事件用这个，避免事件风暴反复整份写盘 */
  saveDebounced: () => void;
  /** 让卡片墙与树重绘 */
  refreshViews: () => void;
  /** 设置面板自我重绘（功能自己的列表项变化后需要） */
  rerenderSettings: () => void;
  /** 注册一个「等工作区就绪后再跑」的回调（文件浏览器此时才挂载） */
  onLayoutReady: (cb: () => void) => void;
  registerEditorExtension: (ext: Extension) => void;
  registerMarkdownPostProcessor: (
    fn: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void
  ) => void;
  registerEvent: (ref: EventRef) => void;
  addCommand: (cmd: Command) => void;
}

export interface Feature {
  readonly id: string;
  /** 设置页里给它的小节标题；没有设置项就不填 */
  readonly settingsTitle?: string;
  attach(ctx: FeatureContext): void;
  /** 卸载清理。Obsidian 会自动回收 register* 登记的东西，只有额外的 DOM/补丁需要实现 */
  detach?(): void;
  renderSettings?(containerEl: HTMLElement, ctx: FeatureContext): void;
}

export class FeatureRegistry {
  /** 装配失败的功能（id + 原因），供外部自检与测试断言 */
  readonly failures: { id: string; error: string }[] = [];

  constructor(
    private readonly features: readonly Feature[],
    private readonly ctx: FeatureContext
  ) {}

  attachAll(): void {
    for (const f of this.features) {
      try {
        f.attach(this.ctx);
      } catch (err) {
        // 单个功能装配失败不能带走整个插件：Obsidian 一旦看到 onload 抛错，
        // 会把插件判为「加载失败」并在下次启动静默禁用（本仓库有过这个事故）。
        const msg = String((err as Error)?.message ?? err);
        this.failures.push({ id: f.id, error: msg });
        console.error(`[知识库管理] 功能「${f.id}」装配失败，已跳过：`, err);
        new Notice(`知识库管理：功能「${f.id}」未能启用（${msg}），其余功能不受影响。`);
      }
    }
  }

  detachAll(): void {
    for (const f of [...this.features].reverse()) {
      if (!f.detach) continue;
      try {
        f.detach();
      } catch (err) {
        console.error(`[知识库管理] 功能「${f.id}」卸载清理失败：`, err);
      }
    }
  }

  /** 各功能把自己的设置小节追加到设置页末尾 */
  renderSettings(containerEl: HTMLElement): void {
    for (const f of this.features) {
      if (!f.renderSettings) continue;
      new Setting(containerEl).setName(f.settingsTitle ?? f.id).setHeading();
      try {
        f.renderSettings(containerEl, this.ctx);
      } catch (err) {
        console.error(`[知识库管理] 功能「${f.id}」设置渲染失败：`, err);
      }
    }
  }

  get(id: string): Feature | undefined {
    return this.features.find((f) => f.id === id);
  }
}

/** 底座需要的、由插件自己提供的依赖（注册口由 featureContext 从 Plugin 上接） */
export type FeatureContextDeps = Pick<
  FeatureContext,
  | "app"
  | "settings"
  | "save"
  | "saveDebounced"
  | "refreshViews"
  | "rerenderSettings"
  | "onLayoutReady"
>;

/** 把 Plugin 的登记口包一层，收成底座需要的形状 */
export function featureContext(plugin: Plugin, deps: FeatureContextDeps): FeatureContext {
  return {
    ...deps,
    registerEditorExtension: (ext) => plugin.registerEditorExtension(ext),
    registerMarkdownPostProcessor: (fn) => plugin.registerMarkdownPostProcessor(fn),
    registerEvent: (ref) => plugin.registerEvent(ref),
    addCommand: (cmd) => plugin.addCommand(cmd),
  };
}
