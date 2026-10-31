import {
  App,
  FuzzySuggestModal,
  Menu,
  Notice,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import { revealInSystem } from "../system";

export interface KbTreeMenuHost {
  app: App;
  scopeRootPath: string;
  /** 置顶 / 隐藏 / 文件夹排序方式（复用原生树那一套） */
  addPluginItems(menu: Menu, file: TAbstractFile): void;
  /** 只加排序方式，用于库根空白右键 */
  addSortOnly(menu: Menu, folder: TFolder): void;
  refresh(): void;
  beginRename(file: TAbstractFile): void;
  createNote(folder: TFolder): void;
  createFolder(folder: TFolder): void;
  createFolderWithSelection(files: TAbstractFile[]): void;
  deleteFiles(files: TAbstractFile[]): void;
  selectedFiles(): TAbstractFile[];
  clearSelection(): void;
}

/**
 * 按原生 section 顺序分组；没有 addSections 的旧版本退回手动分隔线。
 */
class MenuBuilder {
  private readonly sections: boolean;
  private lastSection: string | null = null;

  constructor(
    private readonly menu: Menu,
    sectionNames: string[]
  ) {
    const addSections = (menu as any).addSections;
    this.sections = typeof addSections === "function";
    if (this.sections) addSections.call(menu, sectionNames);
  }

  item(
    section: string,
    title: string,
    icon: string,
    onClick: () => void,
    warning = false
  ): void {
    if (!this.sections && this.lastSection !== null && this.lastSection !== section) {
      this.menu.addSeparator();
    }
    this.lastSection = section;
    this.menu.addItem((entry) => {
      if (this.sections) entry.setSection(section);
      entry.setTitle(title).setIcon(icon).onClick(onClick);
      if (warning) entry.setWarning(true);
    });
  }

  /** 之后插入的是不带 section 的条目（本插件置顶/隐藏/排序，或第三方项） */
  externalGroup(): void {
    if (!this.sections && this.lastSection !== null) this.menu.addSeparator();
    this.lastSection = "";
  }
}

async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    new Notice("已复制路径");
  } catch {
    new Notice("复制路径失败");
  }
}

function reveal(host: KbTreeMenuHost, file: TAbstractFile): void {
  if (!revealInSystem(host.app, file.path, "reveal")) {
    new Notice("当前环境不支持在资源管理器中打开");
  }
}

async function openInNewTab(app: App, file: TFile): Promise<void> {
  await app.workspace.getLeaf("tab").openFile(file);
}

async function openInNewTabGroup(app: App, file: TFile): Promise<void> {
  await app.workspace.getLeaf("split").openFile(file);
}

async function openInNewWindow(app: App, file: TFile): Promise<void> {
  try {
    const leaf = (app.workspace as any).openPopoutLeaf?.();
    if (!leaf) {
      new Notice("当前环境不支持在新窗口中打开");
      return;
    }
    await leaf.openFile(file);
  } catch (err) {
    new Notice(`无法在新窗口中打开：${String((err as Error)?.message ?? err)}`);
  }
}

async function openWithDefaultApp(app: App, file: TFile): Promise<void> {
  const open = (app as any).openWithDefaultApp;
  if (typeof open !== "function") {
    new Notice("当前环境不支持使用默认应用打开");
    return;
  }
  try {
    await open.call(app, file.path);
  } catch (err) {
    new Notice(`无法使用默认应用打开：${String((err as Error)?.message ?? err)}`);
  }
}

async function duplicate(app: App, file: TAbstractFile): Promise<void> {
  try {
    // 插件的 vault.copy 补丁会同步排序数据并重排原生树
    const extension = file instanceof TFile ? file.extension : "";
    const base = extension ? file.path.slice(0, -(extension.length + 1)) : file.path;
    const available = (app.vault as any).getAvailablePath;
    const newPath =
      typeof available === "function"
        ? available.call(app.vault, base, extension)
        : file.path + " 1";
    await (app.vault as any).copy(file, newPath);
    new Notice(`已创建副本：${newPath}`);
  } catch (err) {
    new Notice(`创建副本失败：${String((err as Error)?.message ?? err)}`);
  }
}

function searchInFolder(app: App, folder: TFolder): void {
  const instance = (app as any).internalPlugins?.getPluginById?.("global-search")
    ?.instance;
  if (typeof instance?.openGlobalSearch === "function") {
    instance.openGlobalSearch(`path:"${folder.path}/" `);
    return;
  }
  new Notice("当前环境不支持在文件夹中查找");
}

function collectFolders(root: TFolder, exclude?: TFolder): TFolder[] {
  const out: TFolder[] = [root];
  const walk = (folder: TFolder): void => {
    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;
      if (
        exclude &&
        (child.path === exclude.path || child.path.startsWith(exclude.path + "/"))
      ) {
        continue;
      }
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function nextAvailablePath(app: App, path: string, extension = ""): string {
  const existing = app.vault.getAbstractFileByPath(path);
  if (!existing) return path;
  const available = (app.vault as any).getAvailablePath;
  if (typeof available !== "function") return path;
  const base = extension ? path.slice(0, -(extension.length + 1)) : path;
  return available.call(app.vault, base, extension);
}

async function moveFiles(
  app: App,
  files: TAbstractFile[],
  target: TFolder
): Promise<void> {
  for (const file of files) {
    if (!app.vault.getAbstractFileByPath(file.path)) continue;
    const wanted = target.path === "/" ? file.name : `${target.path}/${file.name}`;
    if (file.path === wanted) continue;

    const extension = file instanceof TFile ? file.extension : "";
    const newPath = nextAvailablePath(app, wanted, extension);
    if (newPath === file.path) continue;
    if (app.vault.getAbstractFileByPath(newPath)) {
      new Notice(`已存在：${newPath}`);
      continue;
    }
    try {
      await app.fileManager.renameFile(file, newPath);
    } catch (err) {
      new Notice(`移动失败：${String((err as Error)?.message ?? err)}`);
    }
  }
}

class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private readonly folders: TFolder[],
    private readonly rootPath: string,
    private readonly onPick: (folder: TFolder) => void
  ) {
    super(app);
    this.setPlaceholder("选择目标文件夹");
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(folder: TFolder): string {
    if (folder.path === this.rootPath) return `${folder.name}（库根）`;
    const prefix = this.rootPath === "/" ? "" : this.rootPath + "/";
    return folder.path.startsWith(prefix)
      ? folder.path.slice(prefix.length)
      : folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onPick(folder);
  }
}

function pickFolder(
  host: KbTreeMenuHost,
  files: TAbstractFile[],
  anchor: TAbstractFile
): void {
  const root = host.app.vault.getAbstractFileByPath(host.scopeRootPath);
  if (!(root instanceof TFolder)) return;
  const exclude = anchor instanceof TFolder ? anchor : undefined;
  const folders = collectFolders(root, exclude);
  new FolderPickerModal(host.app, folders, root.path, (target) => {
    void moveFiles(host.app, files, target).then(() => host.refresh());
  }).open();
}

export function showFileContextMenu(
  host: KbTreeMenuHost,
  file: TFile,
  event: MouseEvent
): void {
  const menu = new Menu();
  const builder = new MenuBuilder(menu, [
    "title",
    "open",
    "action-primary",
    "action",
    "info",
    "info.copy",
    "view",
    "system",
    "",
    "danger",
  ]);

  builder.item("open", "在新标签页中打开", "file-plus", () =>
    void openInNewTab(host.app, file)
  );
  builder.item("open", "在新标签组中打开", "separator-vertical", () =>
    void openInNewTabGroup(host.app, file)
  );
  builder.item("open", "在新窗口中打开", "picture-in-picture-2", () =>
    void openInNewWindow(host.app, file)
  );
  builder.item("action", "创建副本", "files", () => void duplicate(host.app, file));
  builder.item("action", "将文件移动到…", "folder-tree", () =>
    pickFolder(host, [file], file)
  );
  builder.item("info", "复制路径", "clipboard", () => void copyPath(file.path));
  builder.item("system", "使用默认应用打开", "arrow-up-right", () =>
    void openWithDefaultApp(host.app, file)
  );
  builder.item("system", "在系统资源管理器中显示", "arrow-up-right", () =>
    reveal(host, file)
  );

  builder.externalGroup();
  host.addPluginItems(menu, file);

  builder.item("danger", "重命名", "edit-3", () => host.beginRename(file));
  builder.item("danger", "删除", "trash-2", () => host.deleteFiles([file]), true);

  menu.showAtMouseEvent(event);
}

export function showFolderContextMenu(
  host: KbTreeMenuHost,
  folder: TFolder,
  event: MouseEvent
): void {
  const menu = new Menu();
  const builder = new MenuBuilder(menu, [
    "title",
    "action-primary",
    "action",
    "info",
    "view",
    "system",
    "",
    "danger",
  ]);

  builder.item("action-primary", "新建笔记", "edit", () => host.createNote(folder));
  builder.item("action-primary", "新建文件夹", "folder-open", () =>
    host.createFolder(folder)
  );
  builder.item("action", "创建副本", "files", () => void duplicate(host.app, folder));
  builder.item("action", "将文件夹移动到…", "folder-tree", () =>
    pickFolder(host, [folder], folder)
  );
  builder.item("action", "在文件夹中查找", "folder-search", () =>
    searchInFolder(host.app, folder)
  );
  builder.item("info", "复制路径", "clipboard", () => void copyPath(folder.path));
  builder.item("system", "在系统资源管理器中显示", "arrow-up-right", () =>
    reveal(host, folder)
  );

  builder.externalGroup();
  host.addPluginItems(menu, folder);

  builder.item("danger", "重命名", "edit-3", () => host.beginRename(folder));
  builder.item("danger", "删除", "trash-2", () => host.deleteFiles([folder]), true);

  menu.showAtMouseEvent(event);
}

export function showMultiContextMenu(
  host: KbTreeMenuHost,
  target: TAbstractFile,
  event: MouseEvent
): void {
  const selected = host.selectedFiles();
  if (selected.length < 2) {
    if (target instanceof TFolder) showFolderContextMenu(host, target, event);
    else showFileContextMenu(host, target as TFile, event);
    return;
  }

  const menu = new Menu();
  const builder = new MenuBuilder(menu, [
    "title",
    "action-primary",
    "action",
    "danger",
  ]);
  const count = selected.length;
  const onlyFiles = selected.every((file) => file instanceof TFile);

  builder.item("action-primary", `使用选中的 ${count} 个对象创建新文件夹`, "folder-plus", () => {
    host.createFolderWithSelection(selected);
  });
  builder.item(
    "action",
    onlyFiles ? `将 ${count} 个文件移动到…` : `将 ${count} 个项目移动到…`,
    "folder-tree",
    () => pickFolder(host, selected, target)
  );
  builder.item("danger", "删除", "trash-2", () => host.deleteFiles(selected), true);

  // 原生 files-menu 会再加一份“移动到…”并列出全库目录，和单库作用域冲突；
  // 多选菜单保持完整复刻，不触发该事件。
  menu.showAtMouseEvent(event);
}

export function showBlankContextMenu(
  host: KbTreeMenuHost,
  root: TFolder,
  event: MouseEvent
): void {
  const menu = new Menu();
  const builder = new MenuBuilder(menu, ["title", "action-primary", "action", ""]);

  builder.item("action-primary", "新建笔记", "edit", () => host.createNote(root));
  builder.item("action-primary", "新建文件夹", "folder-open", () =>
    host.createFolder(root)
  );
  builder.item("action", "在文件夹中查找", "folder-search", () =>
    searchInFolder(host.app, root)
  );

  builder.externalGroup();
  host.addSortOnly(menu, root);

  menu.showAtMouseEvent(event);
}
