import { setIcon } from "obsidian";
import type { ItemSettings } from "./order-types";

/**
 * 在原生文件树的每个条目上挂「置顶图钉」，并处理隐藏态 class。
 * 原版用 React 实现，这里改为原生 DOM，去除 react 依赖。
 */
export function mountIndicator(
  item: { el: HTMLElement; coverEl: HTMLElement },
  itemSettings: ItemSettings | undefined,
  isPatternHidden: boolean
): void {
  if (!item?.coverEl) return;

  const isPinned = itemSettings?.isPinned ?? false;
  const isHidden = (itemSettings?.isHidden ?? false) || isPatternHidden;
  let indicatorEl = item.coverEl.querySelector<HTMLElement>(".kb-indicator");

  // 普通可见条目不建空占位节点（上万条目时是纯负担）；
  // 置顶或隐藏的条目保留节点，供图钉/测试与 CSS 使用。
  if (!isPinned && !isHidden) {
    indicatorEl?.remove();
  } else if (!indicatorEl) {
    indicatorEl = item.coverEl.createDiv({ cls: "kb-indicator" });
  }

  if (indicatorEl) {
    const pinEl = indicatorEl.querySelector<HTMLElement>(".kb-pin-indicator");
    if (isPinned && !pinEl) {
      indicatorEl.dataset.state = "pinned";
      setIcon(indicatorEl.createDiv({ cls: "kb-pin-indicator" }), "pin");
    } else if (!isPinned && pinEl) {
      indicatorEl.empty();
      indicatorEl.dataset.state = "none";
    }
  }

  // 隐藏态：只有确实需要变化时才碰 class
  if (isHidden) item.el.addClass("kb-hidden");
  else if (item.el.classList.contains("kb-hidden")) item.el.removeClass("kb-hidden");
}
