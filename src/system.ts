import { FileSystemAdapter, type App } from "obsidian";

interface ElectronShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

type ElectronWindow = Window & {
  require?: (module: string) => { shell?: ElectronShell };
};

const electronShell = (): ElectronShell | null => {
  const req = (window as ElectronWindow).require;
  if (typeof req !== "function") return null;
  return req("electron")?.shell ?? null;
};

/** 桌面端返回 vault 内路径的绝对路径；移动端或非文件系统适配器返回 null */
export const absolutePath = (app: App, vaultPath: string): string | null => {
  const adapter = app.vault.adapter;
  return adapter instanceof FileSystemAdapter ? adapter.getFullPath(vaultPath) : null;
};

/** 在系统文件管理器中打开/定位；环境不支持时返回 false，由调用方提示 */
export const revealInSystem = (
  app: App,
  vaultPath: string,
  mode: "open" | "reveal"
): boolean => {
  const full = absolutePath(app, vaultPath);
  const shell = electronShell();
  if (!full || !shell) return false;
  if (mode === "reveal" && shell.showItemInFolder) {
    shell.showItemInFolder(full);
  } else {
    void shell.openPath(full);
  }
  return true;
};
