/**
 * 关键字高亮选色：工具栏弹层与设置页共用的同一套控件。
 *
 * 11 个标准色块 + 「自定义」原生取色；标准色块选中态带勾。
 * `HighlightColorPicker` 是内嵌面板（工具栏弹层直接用）；
 * `HighlightColorField` 是「色块按钮 + 浮层」形态（设置页行内用），
 * 浮层用 fixed 定位挂到 body，避免被设置页滚动容器裁切。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icons";

/**
 * 常用标准色块：黑/红/绿/黄/蓝/品红/青/白 + 橙/紫/灰。
 * 深浅主题下都选中间明度，避免纯黑/纯白在另一种主题里糊成一片。
 */
export const HIGHLIGHT_COLOR_SWATCHES: { name: string; color: string }[] = [
  { name: "黑", color: "#111111" },
  { name: "红", color: "#F87171" },
  { name: "绿", color: "#34D399" },
  { name: "黄", color: "#FBBF24" },
  { name: "蓝", color: "#3B82F6" },
  { name: "品红", color: "#EC4899" },
  { name: "青", color: "#22CCCC" },
  { name: "白", color: "#FFFFFF" },
  { name: "橙", color: "#FB923C" },
  { name: "紫", color: "#A78BFA" },
  { name: "灰", color: "#94A3B8" },
];

/** 色块选中对勾的对比色：浅色块配深勾，深色块配白勾。 */
function highlightCheckTone(hex: string): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return "#FFFFFF";
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#111111" : "#FFFFFF";
}

const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/**
 * 颜色选择：一排标准色块点选；自定义取色是补充入口（原生取色器），
 * 不再作为唯一方式。当前值不命中标准色时「自定义」块高亮并显示该颜色值。
 */
export function HighlightColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const normalized = value.toUpperCase();
  const isStandard = HIGHLIGHT_COLOR_SWATCHES.some(
    (swatch) => swatch.color.toUpperCase() === normalized,
  );
  const chipsRef = useRef<Array<HTMLButtonElement | null>>([]);

  /** 方向键在标准色块间移动焦点，Enter/Space 选中（与工具栏弹层一致）。 */
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!ARROW_KEYS.has(event.key)) return;
    const current = chipsRef.current.findIndex((chip) => chip === document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const next = (current + delta + chipsRef.current.length) % chipsRef.current.length;
    chipsRef.current[next]?.focus();
  };

  return (
    <div className="term-highlight-color-picker">
      <div
        className="term-highlight-color-swatches"
        role="radiogroup"
        aria-label="规则颜色"
        onKeyDown={moveFocus}
      >
        {HIGHLIGHT_COLOR_SWATCHES.map((swatch, index) => {
          const selected = swatch.color.toUpperCase() === normalized;
          return (
            <button
              key={swatch.color}
              ref={(node) => {
                chipsRef.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={swatch.name}
              title={swatch.name}
              className={`term-highlight-color-chip${selected ? " is-selected" : ""}`}
              style={{ background: swatch.color }}
              onClick={() => onChange(swatch.color)}
            >
              {selected && (
                <Icon name="check" size={11} style={{ color: highlightCheckTone(swatch.color) }} />
              )}
            </button>
          );
        })}
        <label
          className={`term-highlight-color-custom${isStandard ? "" : " is-active"}`}
          title="自定义颜色"
        >
          <input
            type="color"
            value={normalized}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            aria-label="自定义颜色"
          />
          {isStandard ? (
            <Icon name="pencil" size={11} />
          ) : (
            <span className="term-highlight-color-dot" style={{ background: normalized }} />
          )}
          <span className="term-highlight-color-custom-text">
            {isStandard ? "自定义" : normalized}
          </span>
        </label>
      </div>
    </div>
  );
}

/**
 * 设置页行内色块：点击弹出与工具栏相同的选色面板。
 * 面板挂到 body，点击外部 / Esc 关闭；选中颜色立即回写，不改变行高。
 */
export function HighlightColorField({
  value,
  onChange,
  open,
  onOpenChange,
  title,
  large = false,
}: {
  value: string;
  onChange: (color: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  large?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPosition(null);
      return;
    }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 240;
      const height = 132;
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
      const below = rect.bottom + 6;
      const top =
        below + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : below;
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onOpenChange(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={"nc-set-rule-color" + (large ? " is-lg" : "")}
        style={{ background: value }}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      />
      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            className="nc-set-color-popover term-highlight-menu"
            style={{ left: position.left, top: position.top }}
            role="dialog"
            aria-label={title}
          >
            <HighlightColorPicker
              value={value}
              onChange={(color) => onChange(color.toUpperCase())}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
