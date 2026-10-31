import type { TAbstractFile } from "obsidian";
import type { NativeTreeSurface } from "../tree/native-surface";
import type { TreeDndController } from "../tree/tree-dnd";

/**
 * 原生树拖拽入口的兼容门面。
 * 真正的规则在 src/tree/tree-dnd.ts，DOM 适配在 src/tree/native-surface.ts；
 * 这里只保留旧字段供回归用例读取。
 */
export class DndEngine {
  constructor(
    private readonly controller: TreeDndController,
    private readonly surface: NativeTreeSurface
  ) {}

  attach(): void {
    this.controller.attach();
  }

  detach(): void {
    this.controller.detach();
  }

  get draggedItem(): TAbstractFile | null {
    return this.controller.draggedItem;
  }

  get dropSibling(): HTMLElement | null {
    const path = this.controller.dropSiblingPath;
    return path ? this.surface.elementForSibling(path) : null;
  }

  get dropFolder(): HTMLElement | null {
    const path = this.controller.dropFolderPath;
    return path ? this.surface.elementForFolder(path) : null;
  }
}
