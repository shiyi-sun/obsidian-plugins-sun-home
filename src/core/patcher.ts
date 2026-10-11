import { Menu, Vault, TFolder, TFile } from "obsidian";
import { initLog } from "./log";
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
    private readonly getExplorerView: () => any,
    private readonly onExplorerSorted: () => void
  ) {}

  /** patch Vault.copy：复制文件时同步顺序状态 */
  patchVaultCopy(): void {
    const plugin = this;
    const vaultProto = Vault.prototype as any;
    const origCopy = vaultProto.copy;

    vaultProto.copy = async function (file: any, newPath: string) {
      plugin.log(`Item copied: '${file.path}' -> '${newPath}'`);
      plugin.orderManager.stageCopyState(file.path, newPath);
      const copy = await origCopy.call(this, file, newPath);
      plugin.onExplorerSorted();
      return copy;
    };

    this.unpatchVaultCopy = () => {
      vaultProto.copy = origCopy;
    };
    this.log("Vault copy patched");
  }

  /** patch 文件浏览器的排序函数——这是「自定义顺序影响原生树」的核心 */
  patchExplorerSorting(): void {
    const explorerView = this.getExplorerView();
    if (!explorerView) return this.log("Explorer view not found, skipping patch");

    const self = this;
    const explorerProto = Object.getPrototypeOf(explorerView) as any;
    const origGetSortedFolderItems = explorerProto.getSortedFolderItems;
    if (typeof origGetSortedFolderItems !== "function") {
      return this.log("getSortedFolderItems not found, skipping patch");
    }

    explorerProto.getSortedFolderItems = function (folder: TFolder) {
      const origSorted = origGetSortedFolderItems.call(this, folder);
      const folderSettings = self.getSettings().items[folder.path] as
        | FolderSettings
        | undefined;
      if (!folderSettings) return origSorted;
      return self.orderManager.getSortedItems(folderSettings, origSorted);
    };

    this.unpatchExplorerSorting = () => {
      explorerProto.getSortedFolderItems = origGetSortedFolderItems;
    };
    this.log("Explorer patched");
  }

  /** 调用原生文件浏览器重新排序 */
  sortExplorer(): void {
    try {
      this.getExplorerView()?.sort?.();
    } catch (err) {
      this.log("sortExplorer failed", err);
    }
  }

  unpatch(): void {
    this.unpatchExplorerSorting?.();
    this.unpatchVaultCopy?.();
    this.log("Patches removed");
  }
}
