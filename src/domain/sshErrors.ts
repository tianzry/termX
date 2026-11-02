/**
 * SSH 错误分类（对齐 netcatty createTerminalSessionStarters 的
 * `isAuthFailureMessage`）。
 *
 * termX 后端把 AppError 序列化成 `__rssh_err__|{"code":...}` 字符串；
 * 前端先解码出 code，再回退到文本匹配（russh / OpenSSH 服务端的原文）。
 */

export function decodeAppError(raw: string): { code?: string; params?: Record<string, unknown>; message: string } {
  const marker = "__rssh_err__|";
  if (raw.startsWith(marker)) {
    try {
      const parsed = JSON.parse(raw.slice(marker.length)) as {
        code?: string;
        params?: Record<string, unknown>;
      };
      return { code: parsed.code, params: parsed.params, message: raw };
    } catch {
      return { message: raw };
    }
  }
  return { message: raw };
}

const AUTH_CODES = new Set([
  "ssh_password_auth_failed",
  "ssh_pubkey_auth_failed",
  "ssh_auth_failed",
  "ssh_interactive_requires_terminal",
]);

export function isAuthFailureMessage(raw: string): boolean {
  const { code, message } = decodeAppError(raw);
  if (code && AUTH_CODES.has(code)) return true;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all configured authentication methods failed") ||
    normalized.includes("authentication failed") ||
    normalized.includes("too many authentication failures") ||
    /permission denied\s*\(/.test(normalized) ||
    normalized.includes("no authentication methods available")
  );
}

/** 取给用户看的错误文本：解码后的错误优先保留原文（含 code 便于排查）。 */
export function userVisibleError(raw: string): string {
  return raw;
}
