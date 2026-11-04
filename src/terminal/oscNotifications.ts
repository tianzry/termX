/**
 * OSC 桌面通知解析（对照 Netcatty domain/terminalOscNotifications.ts）。
 * 支持 OSC 9 / OSC 777 notify / kitty OSC 99；纯函数，单测见同目录 test。
 */

export type OscNotificationMode = "always" | "unfocused" | "off";

export interface OscNotification {
  title: string;
  body: string;
  protocol: "osc9" | "osc777" | "osc99";
}

export const OSC_NOTIFICATION_TITLE_MAX = 120;
export const OSC_NOTIFICATION_BODY_MAX = 500;
export const DEFAULT_OSC_NOTIFICATION_TITLE = "termX";

const CONEMU_OSC9_COMMAND = /^\d+(?:;|$)/;
const OSC99_PENDING_TTL_MS = 10_000;
const OSC99_PENDING_MAX = 16;

function isForbiddenChar(code: number): boolean {
  return (
    code <= 8 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f
  );
}

export function sanitizeOscNotificationText(value: string, max: number): string {
  if (typeof value !== "string" || max <= 0) return "";
  let cleaned = "";
  for (const char of value) {
    if (!isForbiddenChar(char.charCodeAt(0))) cleaned += char;
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** 组装最终标题 / 正文：空标题回落默认标题，空正文时把标题当正文。 */
export function resolveOscNotificationPresentation(
  notification: OscNotification,
  fallbackTitle = DEFAULT_OSC_NOTIFICATION_TITLE,
): { title: string; body: string } {
  const fallback =
    sanitizeOscNotificationText(fallbackTitle, OSC_NOTIFICATION_TITLE_MAX) ||
    DEFAULT_OSC_NOTIFICATION_TITLE;
  const title = sanitizeOscNotificationText(notification.title, OSC_NOTIFICATION_TITLE_MAX);
  const body = sanitizeOscNotificationText(notification.body, OSC_NOTIFICATION_BODY_MAX);
  if (title && body) return { title, body };
  if (body) return { title: fallback, body };
  if (title) return { title: fallback, body: title };
  return { title: fallback, body: "" };
}

export function shouldShowOscNotification(
  mode: OscNotificationMode | undefined,
  windowFocused: boolean,
): boolean {
  if (mode === "off") return false;
  if (mode === "unfocused") return !windowFocused;
  return true;
}

/** OSC 9：正文即通知内容；9;n（ConEmu 进度）不算通知。 */
export function parseOsc9Payload(data: string): OscNotification | null {
  if (typeof data !== "string") return null;
  const payload = data.trim();
  if (!payload) return null;
  if (CONEMU_OSC9_COMMAND.test(payload)) return null;
  return { title: "", body: payload, protocol: "osc9" };
}

/** OSC 777：`notify;title;body`（title 可省略）。 */
export function parseOsc777Payload(data: string): OscNotification | null {
  if (typeof data !== "string") return null;
  const match = data.match(/^notify;(.*)$/i);
  if (!match) return null;
  const rest = match[1] ?? "";
  const separator = rest.indexOf(";");
  if (separator < 0) {
    const body = rest.trim();
    if (!body) return null;
    return { title: "", body, protocol: "osc777" };
  }
  const title = rest.slice(0, separator).trim();
  const body = rest.slice(separator + 1).trim();
  if (!title && !body) return null;
  return { title, body, protocol: "osc777" };
}

type Osc99Pending = { title: string; body: string; updatedAt: number };

function decodeOsc99Payload(payload: string, encoded: boolean): string {
  if (!encoded) return payload;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function parseOsc99Metadata(metadata: string): {
  id: string;
  part: "title" | "body";
  done: boolean;
  encoded: boolean;
  close: boolean;
} {
  const fields = {
    id: "",
    part: "title" as "title" | "body",
    done: true,
    encoded: false,
    close: false,
  };
  if (!metadata.trim()) return fields;
  for (const token of metadata.split(":")) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (key === "i") fields.id = value;
    else if (key === "p" && (value === "title" || value === "body")) fields.part = value;
    else if (key === "d") fields.done = value !== "0";
    else if (key === "e") fields.encoded = value === "1";
    else if ((key === "p" || key === "a") && value === "close") fields.close = true;
  }
  return fields;
}

/** kitty OSC 99 分片组装（i=id / p=title|body / d=0 未完成 / e=1 base64）。 */
export class Osc99Assembler {
  private readonly pending = new Map<string, Osc99Pending>();

  consume(data: string, now = Date.now()): OscNotification | null {
    if (typeof data !== "string") return null;
    this.prune(now);

    const separator = data.indexOf(";");
    const metadata = separator < 0 ? "" : data.slice(0, separator);
    const rawPayload = separator < 0 ? data : data.slice(separator + 1);
    const fields = parseOsc99Metadata(metadata);
    if (fields.close) {
      if (fields.id) this.pending.delete(fields.id);
      return null;
    }

    const payload = decodeOsc99Payload(rawPayload, fields.encoded);
    const current = this.pending.get(fields.id) ?? { title: "", body: "", updatedAt: now };
    if (fields.part === "body") current.body += payload;
    else current.title += payload;
    current.updatedAt = now;

    if (!fields.done) {
      this.pending.set(fields.id, current);
      this.evictOldest();
      return null;
    }

    this.pending.delete(fields.id);
    if (!current.title.trim() && !current.body.trim()) return null;
    return { title: current.title, body: current.body, protocol: "osc99" };
  }

  private prune(now: number): void {
    for (const [id, entry] of this.pending) {
      if (now - entry.updatedAt > OSC99_PENDING_TTL_MS) this.pending.delete(id);
    }
  }

  private evictOldest(): void {
    while (this.pending.size > OSC99_PENDING_MAX) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) return;
      this.pending.delete(oldest);
    }
  }
}
