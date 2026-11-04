import { describe, expect, it } from "vitest";
import Zmodem from "zmodem.js";
import { createZmodemController } from "./zmodem";

function header(name: string, ...args: unknown[]): Uint8Array {
  const hex = (Zmodem as any).Header.build(name, ...args).to_hex();
  return new Uint8Array(hex);
}

function makeController() {
  const terminal: number[] = [];
  const remote: number[] = [];
  const events: string[] = [];
  const controller = createZmodemController({
    writeToTerminal: (bytes) => terminal.push(...bytes),
    writeToRemote: (bytes) => remote.push(...bytes),
    saveDownload: async () => "unused",
    onEvent: (event) => events.push(`${event.phase}:${event.direction}`),
  });
  return { controller, terminal, remote, events };
}

describe("ZMODEM 接管器", () => {
  it("检测到 ZRQINIT 后确认下载会话并回 ZRINIT", () => {
    const { controller, remote } = makeController();
    controller.consume(header("ZRQINIT"));
    // 下载端 start() 会向远端发送 ZRINIT；协议字节被 Sentry 接管即成功。
    expect(remote.length).toBeGreaterThan(0);
    controller.dispose();
  });

  it("检测到 4 字节 ZRINIT 后进入上传会话，无待传文件时报错", () => {
    const { controller, events } = makeController();
    controller.consume(header("ZRINIT", ["CANFDX", "CANOVIO", "CANFC32"], 0));
    expect(events).toContain("error:upload");
    controller.dispose();
  });

  it("dispose 后不再向终端 / 远端写字节", () => {
    const { controller, terminal, remote } = makeController();
    controller.consume(new Uint8Array([104, 105]));
    expect(terminal).toEqual([104, 105]);
    controller.dispose();
    controller.consume(new Uint8Array([120, 121]));
    expect(terminal).toEqual([104, 105]);
    expect(remote).toEqual([]);
  });
});
