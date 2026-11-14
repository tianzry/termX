/**
 * OSC 7 目录追踪「首连自动弹确认框」的每主机记忆。
 *
 * 「跳到终端目录 / 跟随终端目录」依赖远端 shell 的 OSC 7 钩子，未配置前
 * SFTP 侧栏对应按钮只能置灰（终端目录未知）。为免去手动找「更多 → 配置
 * 目录追踪」，SSH 连接建立后若一段时间未收到 OSC 7 上报且该主机未被用户
 * 明确取消过，自动弹出既有确认对话框；用户取消即按主机记住「不再自动弹」
 * （手动入口始终保留在「更多」菜单）。
 */

const DISMISSED_PREFIX = "termx.osc7prompt.dismissed.";

/** 连接建立后等待首帧 OSC 7 上报的宽限时长：已装钩子的主机不会误弹。 */
export const OSC7_AUTO_PROMPT_DELAY_MS = 2000;

export function osc7PromptDismissedKey(profileId: string): string {
  return `${DISMISSED_PREFIX}${profileId}`;
}

export function isOsc7PromptDismissed(profileId: string): boolean {
  try {
    return window.localStorage.getItem(osc7PromptDismissedKey(profileId)) === "1";
  } catch {
    return false;
  }
}

export function dismissOsc7Prompt(profileId: string): void {
  try {
    window.localStorage.setItem(osc7PromptDismissedKey(profileId), "1");
  } catch {
    // 存储不可用时仅本次不记忆，下次连接仍会按流程判断。
  }
}
