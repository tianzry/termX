import { describe, expect, it } from "vitest";

import { deriveToolbarCapabilities } from "./toolbarCapabilities";

describe("deriveToolbarCapabilities", () => {
  it("SSH 显示全部能力", () => {
    const caps = deriveToolbarCapabilities("ssh");
    expect(caps).toMatchObject({
      history: true,
      systemMonitor: true,
      copyHost: true,
      sftp: true,
      forward: true,
      menuHistory: true,
      menuOsc7: true,
      menuEncoding: true,
    });
  });

  it("本地 shell 隐藏 SSH 专属能力（历史 / SFTP / 监控 / 目录追踪 / 复制地址）", () => {
    const caps = deriveToolbarCapabilities("pty");
    expect(caps.history).toBe(false);
    expect(caps.menuHistory).toBe(false);
    expect(caps.systemMonitor).toBe(false);
    expect(caps.sftp).toBe(false);
    expect(caps.forward).toBe(false);
    expect(caps.copyHost).toBe(false);
    expect(caps.menuOsc7).toBe(false);
    expect(caps.menuEncoding).toBe(false);
    expect(caps.sessionLog).toBe(true);
    expect(caps.scripts).toBe(true);
  });

  it("串口隐藏 SFTP / 历史 / 编码，但保留日志与脚本", () => {
    const caps = deriveToolbarCapabilities("serial");
    expect(caps.sftp).toBe(false);
    expect(caps.forward).toBe(false);
    expect(caps.history).toBe(false);
    expect(caps.menuEncoding).toBe(false);
    expect(caps.copyHost).toBe(true);
    expect(caps.sessionLog).toBe(true);
    expect(caps.scripts).toBe(true);
  });

  it("Telnet 保留编码切换与复制地址，隐藏 SFTP / 历史 / 监控", () => {
    const caps = deriveToolbarCapabilities("telnet");
    expect(caps.menuEncoding).toBe(true);
    expect(caps.sftp).toBe(false);
    expect(caps.history).toBe(false);
    expect(caps.systemMonitor).toBe(false);
    expect(caps.copyHost).toBe(true);
  });
});
