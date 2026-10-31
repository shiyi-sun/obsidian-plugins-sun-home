import { initLog } from "./log";
import { mountIndicator } from "./indicator";
import type { OrderSettings } from "./order-types";

const EXPLORER_SELECTOR = '[data-type="file-explorer"] > .nav-files-container';

/** 管理文件浏览器的挂载监听与指示器同步 */
export class ExplorerManager {
  private readonly log = initLog("EXPLORER MANAGER", "#FF3B55");
  private readonly observers: MutationObserver[] = [];

  constructor(
    private readonly getSettings: () => OrderSettings,
    private readonly getExplorerView: () => any,
    private readonly isPatternHidden: (path: string) => boolean
  ) {}

  /** 监听文件浏览器的挂载。checkExisting=true 时先查已存在的；watch=true 时重复监听 */
  observeExplorerMount(
    onMount: (el: HTMLElement) => void,
    { checkExisting = false, watch = false }: { checkExisting?: boolean; watch?: boolean } = {}
  ): void {
    let mountedEl: HTMLElement | null = null;

    if (checkExisting) {
      const explorerEl = document.querySelector<HTMLElement>(EXPLORER_SELECTOR);
      if (explorerEl) {
        mountedEl = explorerEl;
        onMount(explorerEl);
        if (!watch) return;
      }
    }

    // 文件浏览器重建时，新容器往往不是 mutation.addedNodes 里那个节点本身
    // （它可能被包在新父节点里一起插入），所以不能只匹配直接新增节点。
    // 旧容器一脱离文档就重新查当前容器；正常渲染期间旧容器仍在文档里，直接跳过。
    const observer = new MutationObserver(() => {
      if (mountedEl?.isConnected) return;
      const explorerEl = document.querySelector<HTMLElement>(EXPLORER_SELECTOR);
      if (!explorerEl) return;
      mountedEl = explorerEl;
      onMount(explorerEl);
      if (!watch) this.disconnectObserver(observer);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.observers.push(observer);
  }

  /** 同步所有条目的置顶图钉与隐藏态 */
  syncIndicators(): void {
    const view = this.getExplorerView();
    if (!view?.fileItems) return;
    const settings = this.getSettings();
    let applied = 0;
    Object.values(view.fileItems).forEach((item: any) => {
      if (!item?.file?.path) return;
      mountIndicator(item, settings.items[item.file.path], this.isPatternHidden(item.file.path));
      applied++;
    });
    this.log(`Indicators synced (${applied} items)`);
  }

  /**
   * 持续观察文件浏览器的内部变化，在条目被动态渲染出来时重新应用隐藏态。
   *
   * 为什么需要它：Obsidian 的原生树是**懒渲染**的 —— 折叠的文件夹、或启动时
   * 尚未渲染完的条目，都不在 `view.fileItems` 里。启动瞬间调用一次 syncIndicators()
   * 往往赶在渲染完成之前，导致「重启后隐藏失效」（条目显示出来却没人给它加 .kb-hidden）。
   * 这里用 MutationObserver 监听容器子树变化，节流地重放隐藏态即可补齐。
   */
  observeIndicatorSync(el: HTMLElement): void {
    let scheduled = false;
    const replay = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        this.syncIndicators();
      });
    };

    const observer = new MutationObserver(replay);
    observer.observe(el, { childList: true, subtree: true });
    this.observers.push(observer);
    this.log("Indicator sync observer attached");
  }

  disconnectObservers(): void {
    this.observers.forEach((obs) => obs.disconnect());
    this.observers.length = 0;
    this.log("Observers disconnected");
  }

  private disconnectObserver(observer: MutationObserver): void {
    observer.disconnect();
    const idx = this.observers.indexOf(observer);
    if (idx !== -1) this.observers.splice(idx, 1);
  }
}
