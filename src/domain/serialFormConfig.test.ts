import { describe, expect, it } from "vitest";
import {
  SERIAL_FORM_DEFAULTS,
  isCustomBaudRate,
  isSerialConnectDisabled,
  isSerialEndpointPath,
  isWindowsNamedPipePath,
  resolveSerialForm,
  serialFlowControlToBackend,
  serialFormErrors,
  serialPortDisplayName,
  serialPortError,
  toSerialConfig,
} from "./serialFormConfig";

describe("串口表单默认值与合并", () => {
  it("默认值逐项对齐 Netcatty", () => {
    expect(SERIAL_FORM_DEFAULTS).toEqual({
      port: "",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      localEcho: false,
      lineMode: false,
      backspaceBehavior: "default",
      byteOrientedBackspace: false,
      charset: "UTF-8",
    });
  });

  it("缺字段回落到默认值", () => {
    const form = resolveSerialForm({ port: "COM3" });
    expect(form.baudRate).toBe(115200);
    expect(form.charset).toBe("UTF-8");
    expect(form.port).toBe("COM3");
  });

  it("非法枚举回落到默认项，ctrl-h 保留", () => {
    const form = resolveSerialForm({
      dataBits: 7,
      stopBits: 2,
      parity: "even",
      flowControl: "rts/cts",
      backspaceBehavior: "ctrl-h",
    });
    expect(form.dataBits).toBe(7);
    expect(form.stopBits).toBe(2);
    expect(form.parity).toBe("even");
    expect(form.flowControl).toBe("rts/cts");
    expect(form.backspaceBehavior).toBe("ctrl-h");

    const junk = resolveSerialForm({
      dataBits: 9 as 5,
      stopBits: 3 as 1,
      parity: "garbage" as "none",
      flowControl: "junk" as "none",
      backspaceBehavior: "x" as "default",
    });
    expect(junk.dataBits).toBe(8);
    expect(junk.stopBits).toBe(1);
    expect(junk.parity).toBe("none");
    expect(junk.flowControl).toBe("none");
    expect(junk.backspaceBehavior).toBe("default");
  });

  it("空字符集回落到 UTF-8", () => {
    expect(resolveSerialForm({ charset: "" }).charset).toBe("UTF-8");
  });
});

describe("串口路径识别与校验", () => {
  it("识别 Windows 命名管道", () => {
    expect(isWindowsNamedPipePath("\\\\.\\pipe\\vmware")).toBe(true);
    expect(isWindowsNamedPipePath("\\\\?\\pipe\\qemu")).toBe(true);
    expect(isWindowsNamedPipePath("COM3")).toBe(false);
  });

  it("端点判定与 Netcatty 一致", () => {
    expect(isSerialEndpointPath("/dev/ttyUSB0")).toBe(true);
    expect(isSerialEndpointPath("COM3")).toBe(true);
    expect(isSerialEndpointPath("\\\\.\\COM4")).toBe(true);
    expect(isSerialEndpointPath("\\\\.\\pipe\\name")).toBe(true);
    expect(isSerialEndpointPath("ttyS0")).toBe(false);
  });

  it("命名管道在 termX 明确报错（crate 无法打开）", () => {
    expect(serialPortError("\\\\.\\pipe\\qemu")).toContain("命名管道");
  });

  it("合法与非法端口", () => {
    expect(serialPortError("COM3")).toBeUndefined();
    expect(serialPortError("/dev/ttyUSB0")).toBeUndefined();
    expect(serialPortError("ttyS0")).toContain("无法识别");
    expect(serialPortError("  ")).toContain("请选择");
  });

  it("字段错误包含端口与波特率", () => {
    expect(serialFormErrors({ ...SERIAL_FORM_DEFAULTS, port: "", baudRate: 0 })).toEqual({
      port: "请选择或输入串口",
      baudRate: "波特率必须是正整数",
    });
    expect(
      serialFormErrors({ ...SERIAL_FORM_DEFAULTS, port: "COM3", baudRate: 115200 }),
    ).toEqual({});
  });
});

describe("禁用条件与自定义波特率", () => {
  it("空端口 / 非法波特率 / 命名管道禁用", () => {
    expect(isSerialConnectDisabled(SERIAL_FORM_DEFAULTS)).toBe(true);
    expect(
      isSerialConnectDisabled({ ...SERIAL_FORM_DEFAULTS, port: "COM3", baudRate: 115200 }),
    ).toBe(false);
    expect(
      isSerialConnectDisabled({ ...SERIAL_FORM_DEFAULTS, port: "COM3", baudRate: 0 }),
    ).toBe(true);
    expect(
      isSerialConnectDisabled({
        ...SERIAL_FORM_DEFAULTS,
        port: "\\\\.\\pipe\\qemu",
        baudRate: 115200,
      }),
    ).toBe(true);
  });

  it("非 12 档标准值才提示自定义", () => {
    expect(isCustomBaudRate(115200)).toBe(false);
    expect(isCustomBaudRate(250000)).toBe(true);
    expect(isCustomBaudRate(0)).toBe(false);
  });
});

describe("提交后端的配置映射", () => {
  it("流控取值映射", () => {
    expect(serialFlowControlToBackend("none")).toBe("none");
    expect(serialFlowControlToBackend("xon/xoff")).toBe("software");
    expect(serialFlowControlToBackend("rts/cts")).toBe("hardware");
  });

  it("嵌套字段 snake_case 且默认不携带自动登录", () => {
    const config = toSerialConfig({
      ...SERIAL_FORM_DEFAULTS,
      port: "COM3",
      baudRate: 9600,
      dataBits: 7,
      stopBits: 2,
      parity: "even",
      flowControl: "xon/xoff",
      charset: "GBK",
    });
    expect(config).toEqual({
      baud_rate: 9600,
      data_bits: 7,
      parity: "even",
      stop_bits: 2,
      flow_control: "software",
      charset: "GBK",
    });
    expect(config.username).toBeUndefined();
    expect(config.password).toBeUndefined();
  });

  it("自动登录任一非空即携带，空密码保留为空串", () => {
    const config = toSerialConfig(SERIAL_FORM_DEFAULTS, {
      username: "root",
      password: "",
    });
    expect(config.username).toBe("root");
    expect(config.password).toBe("");
  });
});

describe("端口显示名", () => {
  it("取路径末段", () => {
    expect(serialPortDisplayName("/dev/ttyUSB0")).toBe("ttyUSB0");
    expect(serialPortDisplayName("COM3")).toBe("COM3");
    expect(serialPortDisplayName("\\\\.\\COM4")).toBe("COM4");
  });
});
