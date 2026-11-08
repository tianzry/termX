import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEditorKeymap, ScriptCodeEditor } from "./ScriptCodeEditor";

describe("ScriptCodeEditor", () => {
  it("挂载后展示源码，外部 value 变化会同步到编辑器", async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ScriptCodeEditor value="nct.log('one');" onChange={onChange} />,
    );

    const content = container.querySelector(".cm-content");
    expect(content?.textContent).toContain("nct.log('one');");

    rerender(<ScriptCodeEditor value="nct.log('two');" onChange={onChange} />);
    await waitFor(() => {
      expect(container.querySelector(".cm-content")?.textContent).toContain("nct.log('two');");
    });
  });

  it("按键映射包含 Mod-Enter 运行与 Tab 缩进", () => {
    const onRun = vi.fn();
    const bindings = createEditorKeymap(onRun);
    expect(bindings.map((b) => b.key)).toEqual(["Mod-Enter", "Tab"]);

    const run = bindings[0].run as () => boolean;
    expect(run()).toBe(true);
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});
