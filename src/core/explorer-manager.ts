import { initLog } from "./log";
import { mountIndicator } from "./indicator";
import type { OrderSettings } from "./order-types";

const EXPLORER_SELECTOR = '[data-type="file-explorer"] > .nav-files-container';

/** 管理文件浏览器的挂载监听与指示器同步 */
export class ExplorerManager {
  private readonly log = initLog("EXPLORER MANAGER", "#FF3B55");
  private readonly observers: MutationObserver[] = [];
  private readonly indicatorObservers = new Map<HTMLElement, MutationObserver>();

  constructor(
    private readonly getSettings: () => OrderSettings,
    private readonly getExplorerViews: () => any[],
    private readonly isPatternHidden: (path: string) => boolean
  ) {}

  /** 监听所有文件浏览器容器的挂载；watch=true 时持续观察后续新建（重建/多面板） */
  observeExplorerMount(
    onMount: (el: HTMLElement) => void,
    { checkExisting = false, watch = false }: { checkExisting?: boolean; watch?: boolean } = {}
  ): void {
    const mounted = new Set<HTMLElement>();

    const scan = (): void => {
      for (const el of [...mounted]) {
        if (!el.isConnected) mounted.delete(el);
      }
      document.querySelectorAll<HTMLElement>(EXPLORER_SELECTOR).forEach((el) => {
        if (mounted.has(el)) return;
        mounted.add(el);
        onMount(el);
      });
    };

    if (checkExisting) scan();
    if (!watch) return;

    // 文件浏览器重建时，新容器往往不是 mutation.addedNodes 里那个节点本身
    // （它可能被包在新父节点里一起插入），所以检查新增节点的子树。
    // 只有确实出现新容器、或有容器脱离文档时才重扫，避免每次 DOM 变动都查询全页。
    const observer = new MutationObserver((mutations) => {
      let changed = false;
      for (const record of mutations) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches(EXPLORER_SELECTOR) || node.querySelector(EXPLORER_SELECTOR)) {
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
      if (!changed) {
        for (const el of mounted) {
          if (!el.isConnected) {
            changed = true;
            break;
          }
        }
      }
      if (changed) scan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.observers.push(observer);
  }

  /** 同步所有面板、所有条目的置顶图钉与隐藏态 */
  syncIndicators(): void {
    const views = this.getExplorerViews();
    const settings = this.getSettings();
    let applied = 0;
    for (const view of views) {
      if (!view?.fileItems) continue;
      Object.values(view.fileItems).forEach((item: any) => {
        if (!item?.file?.path) return;
        mountIndicator(item, settings.items[item.file.path], this.isPatternHidden(item.file.path));
        applied++;
      });
    }
    this.log(`Indicators synced (${applied} items)`);
  }

  /**
   * 持续观察文件浏览器的内部变化，在条目被动态渲染出来时重新应用隐藏态。
   *
   * 为什么需要它：Obsidian 的原生树是**懒渲染/虚拟列表**的 —— 折叠的文件夹、
   * 滚动出视口的条目，都不在 DOM 里。启动瞬间调用一次 syncIndicators()
   * 往往赶在渲染完成之前，导致「重启后隐藏失效」。
   *
   * ⚠️ 这里只同步当前渲染出来的行（通常几十行），不再每次变动全量遍历
   * `view.fileItems`：上万条目时那是一次 8ms 级的整表扫描，拖拽/滚动会明显发涩。
   */
  observeIndicatorSync(el: HTMLElement): void {
    if (this.indicatorObservers.has(el)) return;

    let scheduled = false;
    const replay = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        this.syncVisibleIndicators(el);
      });
    };

    const observer = new MutationObserver(replay);
    observer.observe(el, { childList: true, subtree: true });
    this.indicatorObservers.set(el, observer);
    this.observers.push(observer);
    this.log("Indicator sync observer attached");
  }

  /** 只处理 DOM 里当前存在的行；虚拟列表滚出视口的行不需要状态 */
  private syncVisibleIndicators(container: HTMLElement): void {
    const view = this.getExplorerViews().find((v) => v?.containerEl?.contains(container));
    if (!view?.fileItems) return;

    const settings = this.getSettings();
    container.querySelectorAll<HTMLElement>(".tree-item-self[data-path]").forEach((self) => {
      const path = self.dataset.path;
      if (!path) return;
      const item = view.fileItems[path];
      if (!item) return;
      mountIndicator(item, settings.items[path], this.isPatternHidden(path));
    });
  }

  disconnectObservers(): void {
    this.observers.forEach((obs) => obs.disconnect());
    this.observers.length = 0;
    this.indicatorObservers.clear();
    this.log("Observers disconnected");
  }
}
