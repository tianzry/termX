import { describe, expect, it } from "vitest";
import { terminalRecordingText } from "./terminalActionText";

describe("terminalRecordingText", () => {
  it("未录制时提供开始文案", () => {
    expect(terminalRecordingText(false)).toEqual({
      label: "开始录制",
      title: "开始录制脚本",
    });
  });

  it("录制中提供停止文案", () => {
    expect(terminalRecordingText(true)).toEqual({
      label: "停止录制",
      title: "停止录制并保存到脚本库",
    });
  });
});
