import { Menu, Modal, App, TAbstractFile, TFolder } from "obsidian";
import type {
  FolderSettings,
  ItemSettings,
  OrderSettings,
  SortOrder,
} from "./order-types";

/** 排序方式取值表（原生树右键菜单与单库树工具条菜单共用） */
export const SORT_OPTIONS: [string, SortOrder][] = [
  ["自定义顺序", "custom"],
  ["名称 A → Z", "byNameAsc"],
  ["名称 Z → A", "byNameDesc"],
  ["创建时间 新 → 旧", "byCreatedTimeDesc"],
  ["创建时间 旧 → 新", "byCreatedTimeAsc"],
  ["修改时间 新 → 旧", "byModifiedTimeDesc"],
  ["修改时间 旧 → 新", "byModifiedTimeAsc"],
];

export interface MenuHost {
  settings: OrderSettings;
  /** 取（必要时补出）该条目的设置：以前"没条目就直接不注入"，导致菜单里凭空少三项 */
  ensureItemSettings: (file: TAbstractFile) => ItemSettings;
  app: App;
  orderManager: { move: (a: string, b: string) => void; getSortedItems: (s: any, i: any) => any };
  sortExplorer: () => void;
  syncIndicators: () => void;
  /** 立即写盘（用户显式操作使用，保证不丢） */
  saveSettingsNow: () => void | Promise<void>;
  /** 置顶/隐藏/排序变化后通知调用方刷新自己的视图 */
  onChanged?: () => void;
}

/** 往文件和文件夹的右键菜单里加「置顶 / 隐藏 / 排序」 */
export function populateFileMenu(menu: Menu, file: TAbstractFile, host: MenuHost): void {
  const fileSettings = host.ensureItemSettings(file);

  if (file instanceof TFolder) {
    const folderSettings = fileSettings as FolderSettings;
    menu.addItem((item) => {
      item.setTitle("排序方式").setIcon("sort-asc");
      // setSubmenu 属于较新 API，用 any 断言保证兼容
      const submenu: Menu = (item as any).setSubmenu?.() ?? menu;
      populateSortMenu(submenu, folderSettings.sortOrder, host, file.path, folderSettings);
    });
  }

  menu.addItem((item) =>
    item
      .setTitle(fileSettings.isPinned ? "取消置顶" : "置顶")
      .setIcon(fileSettings.isPinned ? "pin-off" : "pin")
      .onClick(() => {
        fileSettings.isPinned = !fileSettings.isPinned;
        if (fileSettings.isPinned) host.orderManager.move(file.path, file.path);
        // 用户显式操作 → 立即写盘，不走防抖（避免"改了没保存"）
        void host.saveSettingsNow();
        host.sortExplorer();
        host.syncIndicators();
        host.onChanged?.();
      })
  );

  menu.addItem((item) =>
    item
      .setTitle(fileSettings.isHidden ? "取消隐藏" : "隐藏")
      .setIcon(fileSettings.isHidden ? "eye" : "eye-off")
      .onClick(() => {
        fileSettings.isHidden = !fileSettings.isHidden;
        // 用户显式操作 → 立即写盘，不走防抖
        void host.saveSettingsNow();
        host.syncIndicators();
        host.onChanged?.();
      })
  );
}

export function populateSortMenu(
  menu: Menu,
  currentSortOrder: SortOrder,
  host: MenuHost,
  folderPath: string,
  folderSettings: FolderSettings
): Menu {
  SORT_OPTIONS.forEach(([title, sortOrder]) => {
    menu.addItem((item) =>
      item
        .setTitle(title)
        .setChecked(currentSortOrder === sortOrder)
        .onClick(() => {
          folderSettings.sortOrder = sortOrder;
          void host.saveSettingsNow();
          host.sortExplorer();
          host.onChanged?.();
        })
    );
  });

  menu.addSeparator().addItem((item) =>
    item.setTitle("将当前顺序保存为自定义顺序").onClick(() => {
      new OrderConfirmModal(host.app, (isConfirmed) => {
        if (folderSettings.sortOrder === "custom" || !isConfirmed) return;
        const folder = host.app.vault.getAbstractFileByPath(folderPath);
        if (!(folder instanceof TFolder)) return;
        // 单库树显示时原生 Files 面板并不在前台，不能依赖它的 getSortedFolderItems；
        // 直接对文件夹全部子项按当前显示规则排序再固化。
        const sortedItems = host.orderManager.getSortedItems(
          folderSettings,
          folder.children.map((file) => ({ file }))
        );
        folderSettings.customOrder = sortedItems.map((i: any) => i.file.name);
        folderSettings.sortOrder = "custom";
        void host.saveSettingsNow();
        host.sortExplorer();
        host.onChanged?.();
      }).open();
    })
  );

  return menu;
}

/** 简单的确认弹窗 */
class OrderConfirmModal extends Modal {
  constructor(
    app: App,
    private onResult: (ok: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "保存为自定义顺序" });
    contentEl.createEl("p", {
      cls: "kb-modal-desc",
      text: "将当前排序结果固化为自定义顺序，之后可用拖拽手动调整。",
    });
    const btns = contentEl.createDiv({ cls: "kb-modal-buttons" });
    btns.createEl("button", { text: "确定", cls: "mod-cta" }).onclick = () => {
      this.close();
      this.onResult(true);
    };
    btns.createEl("button", { text: "取消" }).onclick = () => {
      this.close();
      this.onResult(false);
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
