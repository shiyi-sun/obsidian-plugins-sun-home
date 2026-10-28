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

  let indicatorEl = item.coverEl.querySelector<HTMLElement>(".kb-indicator");
  if (!indicatorEl) {
    indicatorEl = item.coverEl.createDiv({ cls: "kb-indicator" });
  }

  const isPinned = itemSettings?.isPinned ?? false;

  // 只在状态变化时重建，避免频繁 setIcon
  const current = indicatorEl.dataset.state;
  const next = isPinned ? "pinned" : "none";
  if (current !== next) {
    indicatorEl.dataset.state = next;
    indicatorEl.empty();
    if (isPinned) {
      const pinEl = indicatorEl.createDiv({ cls: "kb-pin-indicator" });
      setIcon(pinEl, "pin");
    }
  }

  // 隐藏态
  const isHidden = (itemSettings?.isHidden ?? false) || isPatternHidden;
  item.el.toggleClass("kb-hidden", isHidden);
}
