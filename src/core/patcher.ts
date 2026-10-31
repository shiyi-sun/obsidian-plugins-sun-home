import { Vault, TFolder } from "obsidian";
import { initLog } from "./log";
import { isFolderSettings } from "./order-types";
import type { OrderSettings, FolderSettings } from "./order-types";
import { OrderManager } from "./order-manager";

/**
 * 补丁器：拦截原生文件浏览器的行为，让自定义排序/置顶/隐藏生效。
 * 移植自 flexplorer（MIT License, kh4f）。
 *
 * ⚠️ 这里 patch 的是 Obsidian 私有 API，大版本升级可能失效。
 */
export class Patcher {
  private readonly log = initLog("PATCHER", "#988bff");

  private unpatchExplorerSorting: (() => void) | null = null;
  private unpatchVaultCopy: (() => void) | null = null;

  constructor(
    private readonly getSettings: () => OrderSettings,
    private readonly orderManager: OrderManager,
    private readonly getExplorerViews: () => any[],
    private readonly onExplorerSorted: () => void
  ) {}

  /** patch Vault.copy：复制文件时同步顺序状态 */
  patchVaultCopy(): void {
    const { log, orderManager, onExplorerSorted } = this;
    const vaultProto = Vault.prototype as any;
    const origCopy = vaultProto.copy;

    vaultProto.copy = async function (file: any, newPath: string) {
      log(`Item copied: '${file.path}' -> '${newPath}'`);
      orderManager.stageCopyState(file.path, newPath);
      const copy = await origCopy.call(this, file, newPath);
      onExplorerSorted();
      return copy;
    };

    this.unpatchVaultCopy = () => {
      vaultProto.copy = origCopy;
    };
    this.log("Vault copy patched");
  }

  /** patch 文件浏览器的排序函数——这是「自定义顺序影响原生树」的核心 */
  patchExplorerSorting(): void {
    const explorerView = this.getExplorerViews()[0];
    if (!explorerView) return this.log("Explorer view not found, skipping patch");

    const { getSettings, orderManager } = this;
    const explorerProto = Object.getPrototypeOf(explorerView) as any;
    const origGetSortedFolderItems = explorerProto.getSortedFolderItems;
    if (typeof origGetSortedFolderItems !== "function") {
      return this.log("getSortedFolderItems not found, skipping patch");
    }

    explorerProto.getSortedFolderItems = function (folder: TFolder) {
      const origSorted = origGetSortedFolderItems.call(this, folder);
      const folderSettings = getSettings().items[folder.path] as
        | FolderSettings
        | undefined;
      // 文件夹路径上可能只有置顶/隐藏条目，没有 customOrder；
      // 直接当 FolderSettings 用会让原生树排序抛异常。
      if (!isFolderSettings(folderSettings)) return origSorted;
      return orderManager.getSortedItems(folderSettings, origSorted);
    };

    this.unpatchExplorerSorting = () => {
      explorerProto.getSortedFolderItems = origGetSortedFolderItems;
    };
    this.log("Explorer patched");
  }

  /** 调用所有原生文件浏览器实例重新排序（侧栏可能同时存在多个 Files 面板） */
  sortExplorer(): void {
    for (const view of this.getExplorerViews()) {
      try {
        view?.sort?.();
      } catch (err) {
        this.log("sortExplorer failed", err);
      }
    }
  }

  unpatch(): void {
    this.unpatchExplorerSorting?.();
    this.unpatchVaultCopy?.();
    this.log("Patches removed");
  }
}
