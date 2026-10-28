/** 轻量日志工具（默认静默，可在设置里开启调试） */
export const logger = { level: "silent" as "silent" | "debug" };

export const initLog =
  (scope: string, color: string) =>
  (...args: unknown[]): void => {
    if (logger.level === "silent") return;
    window.console.log(`%c${scope}`, buildStyles(color), ...args);
  };

const buildStyles = (color: string): string => `
  color: ${color};
  background: #1d2131;
  border: 1px solid ${color};
  border-radius: 10px;
  font-family: consolas, monospace;
  font-size: 10px;
  padding: 0px 4px;
`;
