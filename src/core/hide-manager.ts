import { initLog } from "./log";

/**
 * 隐藏管理器：支持「手动隐藏」+「glob 规则隐藏」。
 * 移植自 flexplorer（MIT License, kh4f）。
 */
export class HideManager {
  private readonly log = initLog("HIDE MANAGER", "#3ddc84");
  private regexes: RegExp[] = [];
  private patterns: string[] = [];

  /** 重新编译规则（hidePatterns 变化时必须调用） */
  syncRegexes(patterns: string[]): void {
    this.patterns = patterns;
    this.regexes = patterns
      .map((p) => p.trim())
      .filter(Boolean)
      .map((glob) => this.globToRegex(glob));
    this.log("Synced hide patterns", patterns);
  }

  /** 是否被 glob 规则命中（注意：不含手动 isHidden） */
  isPatternHidden(path: string): boolean {
    return this.regexes.some((regex) => regex.test(path));
  }

  /** gitignore 风格 glob → 正则（匹配完整 vault 路径） */
  private globToRegex(glob: string): RegExp {
    const isRootAnchored = glob.startsWith("/");
    if (isRootAnchored) glob = glob.slice(1);

    let source = "";
    for (let i = 0; i < glob.length; i++) {
      const char = glob[i];
      if (char === "*") {
        if (glob[i + 1] === "*") {
          i++;
          if (i === glob.length - 1) {
            // `templates/**` 也要匹配文件夹自身
            if (source.endsWith("/")) source = source.slice(0, -1);
            source += "(?:|/.*)";
          } else if (glob[i + 1] === "/") {
            source += "(?:[^/]*/)*";
            i++;
          } else {
            source += "(?:[^/]*/)*";
          }
        } else {
          source += "[^/]*";
        }
      } else if (char === "?") {
        source += "[^/]";
      } else if ("\\^$.|+()[]{}".includes(char)) {
        source += `\\${char}`;
      } else {
        source += char;
      }
    }

    const containsSlash = glob.includes("/");
    return new RegExp(`^${isRootAnchored || containsSlash ? "" : "(?:[^/]*/)*"}${source}$`);
  }
}
