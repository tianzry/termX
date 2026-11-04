/**
 * ZMODEM（rz / sz）前端接管层。
 *
 * 对齐 Netcatty `electron/bridges/zmodemHelper.cjs` 的做法：把同一份下行字节流
 * 先喂给 `Zmodem.Sentry`，检测到 `rz`/`sz` 的 ZRINIT / ZRQINIT 头之后，
 * 协议字节走 `sender`（写回 SSH 通道），其余字节继续送到终端。
 *
 * 与 Netcatty 的差异（见 changelogs）：协议引擎跑在渲染进程里（zmodem.js 0.1.10），
 * 下载目标固定为 `~/Downloads`（Netcatty 用 Electron 目录选择框），无传输队列 /
 * 断点续传 / 拖出桌面；YMODEM 未移植。
 */

import Zmodem from "zmodem.js";

export type ZmodemDirection = "upload" | "download";

export interface ZmodemEvent {
  phase: "detect" | "progress" | "complete" | "error";
  direction: ZmodemDirection;
  filename?: string;
  transferred?: number;
  total?: number;
  message?: string;
  /** 下载完成后的本地绝对路径。 */
  savedPath?: string;
}

export interface ZmodemCallbacks {
  /** 送往终端显示的普通字节。 */
  writeToTerminal: (bytes: Uint8Array) => void;
  /** 写回远端通道的协议字节（必须原样二进制写入）。 */
  writeToRemote: (bytes: Uint8Array) => void;
  /** 下载完成落盘；返回实际写入路径。 */
  saveDownload: (filename: string, bytes: Uint8Array) => Promise<string>;
  onEvent?: (event: ZmodemEvent) => void;
}

export interface ZmodemController {
  consume: (bytes: Uint8Array) => void;
  /** 拖拽上传：先记录待传文件，随后终端发送 `rz`，检测到 ZRINIT 后开始发送。 */
  startUpload: (files: File[]) => void;
  abort: () => void;
  dispose: () => void;
  active: () => boolean;
}

const UPLOAD_CHUNK = 4096;
const PROGRESS_INTERVAL_MS = 120;

function toOctets(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return Uint8Array.from(value as ArrayLike<number>);
}

function concatPayloads(payloads: Array<unknown>): Uint8Array {
  const parts = payloads.map(toOctets);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 创建一个 ZMODEM 接管器。仅 SSH 会话使用；不接管的传输（本地 PTY / 串口 /
 * Telnet）不创建，字节流保持原样。
 */
export function createZmodemController(cb: ZmodemCallbacks): ZmodemController {
  let session: any = null;
  let direction: ZmodemDirection | null = null;
  let pendingFiles: File[] | null = null;
  let disposed = false;
  let lastProgressAt = 0;

  function emit(event: ZmodemEvent) {
    if (!disposed) cb.onEvent?.(event);
  }

  function emitProgress(
    event: ZmodemEvent,
    force = false,
  ): void {
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    emit(event);
  }

  function release() {
    session = null;
    direction = null;
  }

  async function beginReceive(zs: any) {
    zs.on("offer", (offer: any) => {
      const details = offer.get_details();
      const name = String(details?.name ?? "download.bin");
      const total = typeof details?.size === "number" ? details.size : undefined;
      let transferred = 0;

      emit({
        phase: "detect",
        direction: "download",
        filename: name,
        total,
      });

      offer.on("input", (payload: unknown) => {
        transferred += toOctets(payload).length;
        emitProgress({
          phase: "progress",
          direction: "download",
          filename: name,
          transferred,
          total,
        });
      });

      offer
        .accept()
        .then(async (payloads: Array<unknown>) => {
          // zmodem.js 0.1.10 的 accept() 直接 resolve 为 payload 数组
          // （旧文档里的 offer.get_payloads() 在此版本不存在）。
          const bytes = concatPayloads(payloads ?? []);
          const savedPath = await cb.saveDownload(name, bytes);
          emit({
            phase: "complete",
            direction: "download",
            filename: name,
            transferred: bytes.length,
            total,
            savedPath,
          });
        })
        .catch((err: unknown) => {
          emit({
            phase: "error",
            direction: "download",
            filename: name,
            message: String((err as Error)?.message ?? err),
          });
        });
    });

    zs.on("session_end", () => release());
    zs.start();
  }

  async function beginSend(zs: any) {
    const files = pendingFiles;
    pendingFiles = null;
    if (!files || files.length === 0) {
      emit({
        phase: "error",
        direction: "upload",
        message: "没有待上传的文件",
      });
      try {
        zs.abort();
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      let remaining = files.reduce((n, f) => n + f.size, 0);
      for (let i = 0; i < files.length; i++) {
        if (disposed) return;
        const file = files[i];
        const bytes = new Uint8Array(await file.arrayBuffer());
        remaining -= bytes.length;

        emit({
          phase: "detect",
          direction: "upload",
          filename: file.name,
          total: bytes.length,
        });

        const xfer = await zs.send_offer({
          name: file.name,
          size: bytes.length,
          mtime: new Date(file.lastModified),
          files_remaining: files.length - i,
          bytes_remaining: remaining,
        });
        if (!xfer) continue;

        let offset = 0;
        while (offset + UPLOAD_CHUNK < bytes.length) {
          if (disposed) return;
          xfer.send(bytes.subarray(offset, offset + UPLOAD_CHUNK));
          offset += UPLOAD_CHUNK;
          emitProgress({
            phase: "progress",
            direction: "upload",
            filename: file.name,
            transferred: offset,
            total: bytes.length,
          });
          await nextTick();
        }

        const tail = bytes.subarray(offset);
        await xfer.end(tail);
        emit({
          phase: "complete",
          direction: "upload",
          filename: file.name,
          transferred: bytes.length,
          total: bytes.length,
        });
      }

      await zs.close();
    } catch (err) {
      emit({
        phase: "error",
        direction: "upload",
        message: String((err as Error)?.message ?? err),
      });
      try {
        zs.abort();
      } catch {
        /* ignore */
      }
    } finally {
      release();
    }
  }

  const sentry = new Zmodem.Sentry({
    to_terminal: (octets: unknown) => {
      if (disposed) return;
      cb.writeToTerminal(toOctets(octets));
    },
    sender: (octets: unknown) => {
      if (disposed) return;
      cb.writeToRemote(toOctets(octets));
    },
    on_detect: (detection: any) => {
      if (disposed) return;
      if (session) {
        // 已有传输在跑：拒绝新的检测，避免两个会话互相踩字节。
        detection.deny();
        return;
      }
      const zs = detection.confirm();
      session = zs;
      direction = zs.type === "send" ? "upload" : "download";
      if (direction === "upload") void beginSend(zs);
      else void beginReceive(zs);
    },
    on_retract: () => {
      /* 误报：sentry 已自动恢复直通，不打扰用户。 */
    },
  });

  return {
    consume(bytes: Uint8Array) {
      if (disposed) return;
      sentry.consume(bytes);
    },
    startUpload(files: File[]) {
      pendingFiles = files.slice();
    },
    abort() {
      if (session) {
        try {
          session.abort();
        } catch {
          /* ignore */
        }
      }
      pendingFiles = null;
      release();
    },
    dispose() {
      disposed = true;
      if (session) {
        try {
          session.abort();
        } catch {
          /* ignore */
        }
      }
      session = null;
      pendingFiles = null;
    },
    active() {
      return session !== null || pendingFiles !== null;
    },
  };
}
