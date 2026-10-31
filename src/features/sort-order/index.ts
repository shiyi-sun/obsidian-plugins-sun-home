/**
 * 排序 / 置顶 / 隐藏 功能（整合自 Flexplorer），底座的第二个 Feature。
 *
 * 这块的持久化刻意分两档，别改混：
 * - 高频 vault 事件（新增/重命名/删除）→ 防抖落盘，避免事件风暴反复整份写盘
 * - 用户显式操作（右键隐藏/置顶、切换排序方式、设置页改动）→ 立即落盘，保证不丢
 *
 * 装配时机也有两条硬约束（都是出过事故的）：
 * 1. vault 事件必须在 onload 期间登记（attach 就是 onload 期间跑的）。等到
 *    onLayoutReady 再 registerEvent，Obsidian 不会把它收进插件事件表，卸载时不摘，
 *    于是留下指向已死实例的僵尸监听 → 下次启动触发异常 → 插件被判加载失败并静默禁用。
 * 2. 引擎初始化要推到 workspace 就绪之后：文件浏览器那时才挂载，patch 才有对象可打。
 */
import { Setting } from "obsidian";
import type { Feature, FeatureContext } from "../../framework/feature";
import { SortFeature } from "../../core/sort-feature";
import type { OrderSettings } from "../../core/order-types";

export class SortOrderFeature implements Feature {
  readonly id = "sort";
  readonly settingsTitle = "排序与隐藏";

  /** 引擎实例。核心视图（知识库树）的右键菜单要借它注入排序项，故对外可见 */
  engine: SortFeature | null = null;

  attach(ctx: FeatureContext): void {
    const order = (): OrderSettings => ctx.settings().order;

    this.engine = new SortFeature(
      ctx.app,
      order,
      ctx.saveDebounced,
      ctx.save
    );

    // ⚠️ 见文件头约束 1：必须此刻登记
    this.engine.registerVaultEvents((ref) => ctx.registerEvent(ref), () => ctx.refreshViews());
    // 隐藏规则此刻就要编译好：布局恢复时卡片页会在 onLayoutReady 之前就渲染，
    // 那会儿若还没 sync，glob 规则读不到，被隐藏的文件夹会混进知识库列表。
    this.engine.syncRuntimeSettings();
    // 启动静默：解除时机见 SortFeature.observeExplorer
    this.engine.suspend();
    // ⚠️ 见文件头约束 2
    ctx.onLayoutReady(() => this.engine?.init());

    ctx.addCommand({
      id: "toggle-show-hidden",
      name: "显示 / 隐藏被隐藏的文件",
      callback: async () => {
        const s = order();
        s.showHidden = !s.showHidden;
        this.engine?.syncRuntimeSettings();
        await ctx.save();
        ctx.refreshViews();
        this.engine?.sortExplorer();
      },
    });
  }

  detach(): void {
    // 解除 patch、摘除监听、还原文件浏览器、清掉残留的 kb-hidden / 指示器
    this.engine?.destroy();
    this.engine = null;
  }

  renderSettings(containerEl: HTMLElement, ctx: FeatureContext): void {
    const order = (): OrderSettings => ctx.settings().order;
    const engine = () => this.engine;

    containerEl.createEl("p", {
      cls: "kb-setting-hint",
      text: "以下功能作用于 Obsidian 原生文件浏览器。在文件/文件夹上右键即可置顶、隐藏、设置排序方式；直接拖拽条目可手动调整顺序。",
    });

    new Setting(containerEl)
      .setName("显示被隐藏的文件")
      .setDesc("打开后，被隐藏的文件会以半透明方式显示出来（仅临时查看，恢复单个文件请用下方的列表）")
      .addToggle((t) =>
        t.setValue(order().showHidden).onChange(async (v) => {
          order().showHidden = v;
          engine()?.syncRuntimeSettings();
          await ctx.save();
          ctx.refreshViews();
          engine()?.sortExplorer();
        })
      );

    this.renderHiddenItemsList(containerEl, ctx);

    new Setting(containerEl)
      .setName("新建文件插入位置")
      .setDesc("新建的文件/文件夹放在列表顶部还是底部")
      .addDropdown((d) => {
        d.addOption("top", "顶部");
        d.addOption("bottom", "底部");
        d.setValue(order().newItemPlacement).onChange(async (v) => {
          order().newItemPlacement = v as "top" | "bottom";
          await ctx.save();
          ctx.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName("增删时保持顺序")
      .setDesc("新建或删除文件后，保留其余条目的自定义顺序")
      .addToggle((t) =>
        t.setValue(order().persistOrderOnCreateDelete).onChange(async (v) => {
          order().persistOrderOnCreateDelete = v;
          await ctx.save();
          ctx.refreshViews();
        })
      );

    new Setting(containerEl).setName("隐藏规则（glob）").setHeading();
    containerEl.createEl("p", {
      cls: "kb-setting-hint",
      text: "每行一条规则，支持 gitignore 风格通配符。例如：*.tmp 隐藏所有 tmp 文件；草稿/** 隐藏「草稿」文件夹；/私密.md 只隐藏根目录下的「私密.md」。",
    });

    const patternBox = containerEl.createEl("textarea", { cls: "kb-hide-patterns" });
    patternBox.value = order().hidePatterns.join("\n");
    patternBox.rows = 6;
    patternBox.addEventListener("blur", async () => {
      order().hidePatterns = patternBox.value
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      engine()?.syncRuntimeSettings();
      await ctx.save();
      ctx.refreshViews();
      engine()?.syncIndicators();
      engine()?.sortExplorer();
    });

    new Setting(containerEl).setName("调试").setHeading();
    new Setting(containerEl)
      .setName("开启调试日志")
      .setDesc("在开发者控制台输出详细日志，排查问题时使用")
      .addToggle((t) =>
        t.setValue(order().debugMode).onChange(async (v) => {
          order().debugMode = v;
          engine()?.setDebug(v);
          await ctx.save();
          ctx.refreshViews();
        })
      );
  }

  /**
   * 「已隐藏的项目」管理区。
   * 列出所有被隐藏的文件/文件夹（含不再存在的失效项），每条可单独恢复。
   * 这样用户不必先打开全局「显示被隐藏的文件」再在半透明条目里翻找。
   */
  private renderHiddenItemsList(containerEl: HTMLElement, ctx: FeatureContext): void {
    new Setting(containerEl).setName("已隐藏的项目").setHeading();

    const items = ctx.settings().order.items;
    const hiddenPaths = Object.keys(items).filter((p) => items[p]?.isHidden);

    if (hiddenPaths.length === 0) {
      containerEl.createEl("p", {
        cls: "kb-setting-hint",
        text: "当前没有被隐藏的文件或文件夹。在原生文件浏览器里右键项目 → 「隐藏」，它就会出现在这里。",
      });
      return;
    }

    containerEl.createEl("p", {
      cls: "kb-setting-hint",
      text: `共 ${hiddenPaths.length} 项被隐藏。点「恢复」让某一项重新显示。`,
    });

    const listEl = containerEl.createDiv({ cls: "kb-hidden-list" });

    for (const path of hiddenPaths) {
      const exists = !!ctx.app.vault.getAbstractFileByPath(path);
      const basename = path.substring(path.lastIndexOf("/") + 1) || path;
      const parentPath = path.substring(0, path.lastIndexOf("/")) || "/";

      const row = new Setting(listEl)
        .setName(basename)
        .setDesc(exists ? parentPath : `（已不存在）${parentPath}`);

      row.addButton((b) =>
        b
          .setButtonText("恢复")
          .setTooltip(exists ? "取消隐藏，让此项重新显示" : "文件已不存在，仅清除隐藏记录")
          .onClick(async () => {
            items[path].isHidden = false;
            await ctx.save();
            ctx.refreshViews();
            this.engine?.syncIndicators();
            this.engine?.sortExplorer();
            ctx.rerenderSettings();
          })
      );
    }

    new Setting(containerEl)
      .setName("全部恢复")
      .setDesc("取消隐藏所有项目")
      .addButton((b) =>
        b
          .setButtonText("全部恢复")
          .setWarning()
          .onClick(async () => {
            for (const p of hiddenPaths) {
              if (items[p]) items[p].isHidden = false;
            }
            await ctx.save();
            ctx.refreshViews();
            this.engine?.syncIndicators();
            this.engine?.sortExplorer();
            ctx.rerenderSettings();
          })
      );
  }
}
