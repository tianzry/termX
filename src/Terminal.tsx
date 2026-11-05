import { useEffect, useRef, useState } from "react";
import {
  Terminal,
  type IDecoration,
  type IDisposable,
  type IMarker,
  type ITerminalOptions,
  type ITheme,
} from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import { resolveInlineImageAddonOptions } from "./terminal/inlineImages";
import { resolveCursorLineHighlightBackground } from "./terminal/cursorLineHighlight";
import {
  Osc99Assembler,
  parseOsc777Payload,
  parseOsc9Payload,
  resolveOscNotificationPresentation,
  shouldShowOscNotification,
  type OscNotification,
} from "./terminal/oscNotifications";
import "@xterm/xterm/css/xterm.css";
import * as api from "./backend/client";
import { isFindShortcut, linkModifierAllows } from "./terminal/linkActivation";
import { terminalInsetsStyle } from "./terminal/terminalInsets";
import {
  formatTerminalTimestamp,
  pruneTerminalTimestampLines,
  resolveTerminalTimestampGutterWidth,
  resolveVisibleTerminalTimestampRows,
  stampTerminalTimestampLines,
} from "./terminal/terminalTimestamps";
import type { AppSettings } from "./settings/settingsModel";
import {
  clampCursorBarWidth,
  clampLinePadding,
  clampScrollback,
  resolveXtermScrollback,
} from "./settings/settingsModel";
import { getSettings, resolvedThemeMode, subscribeSettings } from "./settings/settingsStore";

export interface TerminalController {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
}

interface Props {
  onReady: (controller: TerminalController) => void;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  /** OSC 7 上报的当前目录（`file://host/path`），用于目录追踪。 */
  onOsc7?: (payload: string) => void;
  /** Cmd/Ctrl+F：打开终端搜索条（对照 Netcatty searchTerminal 热键）。 */
  onFindShortcut?: () => void;
  /** 显示每行输出左侧时间戳 gutter（对照 Netcatty 工具栏时钟开关）。 */
  showTimestamps?: boolean;
}

const DEFAULT_FONT_STACK = "Menlo, Monaco, Consolas, 'Courier New', monospace";

/** Option+方向键映射仅对 macOS 生效（对照 Netcatty optionArrowWordJump 的 isMac 门控）。 */
const IS_MAC_PLATFORM =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);

/** 终端主字体解析：auto → 默认栈；否则选中字体 + CJK 回退字体。 */
function resolveFontFamily(s: AppSettings): string {
  const base =
    s.terminalFontFamilyId && s.terminalFontFamilyId !== "auto"
      ? `'${s.terminalFontFamilyId}', `
      : "";
  const cjk = s.terminal.fallbackFont ? `'${s.terminal.fallbackFont}', ` : "";
  return `${base}${cjk}${DEFAULT_FONT_STACK}`;
}

const TERM_THEME_DARK: ITheme = {
  background: "#16181d",
  foreground: "#dfe3ea",
  cursor: "#6aa1ff",
  cursorAccent: "#16181d",
  selectionBackground: "rgba(106, 161, 255, 0.28)",
  brightCyan: "#56d4dd",
};

const TERM_THEME_LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#16202b",
  cursor: "#0a84ff",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(10, 132, 255, 0.22)",
  brightCyan: "#0e7490",
};

/** 是否使用深色终端配色（跟随应用主题 / 固定深色）。 */
export function isDarkTerminal(s: AppSettings): boolean {
  return !s.terminal.followAppTheme || resolvedThemeMode(s) === "dark";
}

/** 由设置中心（终端 tab）构建 xterm 选项；导出供单测。 */
export function buildXtermOptions(s: AppSettings): ITerminalOptions {
  const t = s.terminal;
  const dark = isDarkTerminal(s);
  return {
    convertEol: false,
    allowProposedApi: true,
    cursorBlink: t.cursorBlink,
    cursorStyle: t.cursorShape,
    cursorWidth: clampCursorBarWidth(t.cursorBarWidth),
    fontSize: s.terminalFontSize,
    fontFamily: resolveFontFamily(s),
    fontWeight: t.fontWeight as ITerminalOptions["fontWeight"],
    fontWeightBold: t.fontWeightBold as ITerminalOptions["fontWeightBold"],
    lineHeight: 1 + clampLinePadding(t.linePadding) / 10,
    scrollback: resolveXtermScrollback(clampScrollback(t.scrollback)),
    wordSeparator: t.wordSeparators,
    // xterm 的 Alt-as-Meta 仅 macOS 可配（Windows 下 Alt 由系统 / Win32 输入处理）。
    macOptionIsMeta: t.altAsMeta,
    scrollOnUserInput: t.scrollOnInput,
    smoothScrollDuration: t.smoothScrolling ? 120 : 0,
    ignoreBracketedPasteMode: t.disableBracketedPaste,
    theme: dark ? TERM_THEME_DARK : TERM_THEME_LIGHT,
  };
}

/** 字体平滑 / 连字是 xterm 元素级 CSS（xterm 无对应 option）。 */
function applyFontVisuals(container: HTMLDivElement, s: AppSettings): void {
  container.classList.toggle("term-ligatures", s.terminal.fontLigatures);
  container.classList.toggle("term-no-smoothing", !s.terminal.fontSmoothing);
}

/**
 * 终端底色跟随当前主题：fit 计算会留出不足一行的余量，
 * xterm 的 viewport 默认底色是黑色，浅色主题下会在底部露一条黑边。
 * viewport 在 styles.css 里改为透明，这里把容器底色设为主题背景。
 */
function applyTermBackground(container: HTMLDivElement, s: AppSettings): void {
  const theme = isDarkTerminal(s) ? TERM_THEME_DARK : TERM_THEME_LIGHT;
  container.style.backgroundColor = theme.background ?? "";
}

/** 光标行底色：主题背景混入选区色，并保证与前景色的对比度（对照 Netcatty）。 */
function resolveCursorLineColor(s: AppSettings): string {
  const theme = isDarkTerminal(s) ? TERM_THEME_DARK : TERM_THEME_LIGHT;
  return resolveCursorLineHighlightBackground({
    background: theme.background ?? "",
    foreground: theme.foreground ?? "",
    selection: theme.selectionBackground ?? "",
  });
}

/**
 * 高亮光标所在行（对照 Netcatty cursorLineHighlight.ts）：
 * 用 decoration 给默认背景单元格铺一层淡色底，保留 ANSI 背景与前景。
 */
class CursorLineHighlighter {
  private enabled = false;
  private backgroundColor = "#263449";
  private marker: IMarker | null = null;
  private decorations: IDecoration[] = [];
  private disposeListeners: IDisposable[] = [];
  private activeKey = "";
  private pending = false;
  /** 跟踪的 marker / decorations 是否仍被 xterm 持有（clear/reset 后需要自愈）。 */
  private tracking = false;
  private readonly disposables: IDisposable[] = [];

  constructor(private readonly term: Terminal) {
    this.disposables.push(
      term.onCursorMove(() => (this.pending = true)),
      term.onWriteParsed(() => (this.pending = true)),
      term.onRender(() => {
        const dirty = this.pending;
        this.pending = false;
        if (!this.enabled) return;
        // 写入 / 光标移动等渲染；xterm 也可能在 clear/reset 时直接销毁 decoration
        // 而不派发事件，所以每帧都校验跟踪集合是否还有效，失效即重建。
        if (dirty || !this.tracking) this.refresh();
      }),
      term.onSelectionChange(() => this.refresh(true)),
      term.onResize(() => this.refresh(true)),
      term.buffer.onBufferChange(() => this.refresh(true)),
    );
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      if (enabled) this.refresh();
      return;
    }
    this.enabled = enabled;
    if (!enabled) this.clear();
    else this.refresh(true);
  }

  setBackgroundColor(color: string): void {
    if (color === this.backgroundColor) return;
    this.backgroundColor = color;
    if (this.enabled) this.refresh(true);
  }

  dispose(): void {
    this.clear();
    this.disposables.forEach((d) => d.dispose());
  }

  private refresh(force = false): void {
    if (!this.enabled) return;
    this.pending = false;
    if (this.term.hasSelection()) {
      this.clear();
      return;
    }
    const buffer = this.term.buffer.active;
    if (buffer.type === "alternate") {
      this.clear();
      return;
    }
    const row = buffer.baseY + buffer.cursorY;
    const cols = Math.max(1, this.term.cols);
    const line = buffer.getLine(row);
    const cell = buffer.getNullCell();
    const ranges: Array<{ x: number; width: number }> = [];
    let start: number | null = null;
    let contentEnd = 0;
    for (let x = 0; x < cols; x += 1) {
      const c = line?.getCell(x, cell);
      if (c && (c.getChars() !== "" || !c.isAttributeDefault())) {
        contentEnd = Math.min(cols, x + Math.max(1, c.getWidth()));
      }
      const highlightable = !c || (c.isBgDefault() && !c.isInverse());
      if (highlightable && start === null) start = x;
      if ((!highlightable || x === cols - 1) && start !== null) {
        const end = highlightable && x === cols - 1 ? x + 1 : x;
        ranges.push({ x: start, width: end - start });
        start = null;
      }
    }
    // 行内容之后的空白单独铺一条尾段（对齐 Netcatty getTailRanges），
    // 避免正文范围受行尾默认属性单元格影响而缩短。
    const clipped = ranges
      .map((r) => {
        const end = Math.min(r.x + r.width, contentEnd);
        return { x: r.x, width: end - r.x };
      })
      .filter((r) => r.width > 0);
    const tailRanges =
      contentEnd < cols ? [{ x: contentEnd, width: cols - contentEnd }] : [];
    const key = `${row}:${cols}:${this.backgroundColor}:${clipped
      .map((r) => `${r.x},${r.width}`)
      .join("|")}#${tailRanges.map((r) => `${r.x},${r.width}`).join("|")}`;
    if (!force && key === this.activeKey && this.marker && !this.marker.isDisposed) return;

    const previousMarker = this.marker;
    const previousDecorations = this.decorations;
    const previousListeners = this.disposeListeners;
    const marker = this.term.registerMarker(0);
    if (!marker) {
      this.clear();
      return;
    }
    const decorations: IDecoration[] = [];
    for (const r of [...clipped, ...tailRanges]) {
      const d = this.term.registerDecoration({
        marker,
        x: r.x,
        width: r.width,
        backgroundColor: this.backgroundColor,
        layer: "bottom",
      });
      if (d) decorations.push(d);
    }
    this.marker = marker;
    this.decorations = decorations;
    this.tracking = true;
    this.disposeListeners = decorations.map((d) =>
      d.onDispose(() => {
        if (this.decorations.includes(d)) {
          this.activeKey = "";
          this.tracking = false;
        }
      }),
    );
    this.activeKey = key;
    this.clearOwned(previousMarker, previousDecorations, previousListeners);
  }

  private clear(): void {
    this.clearOwned(this.marker, this.decorations, this.disposeListeners);
    this.marker = null;
    this.decorations = [];
    this.disposeListeners = [];
    this.activeKey = "";
    this.tracking = false;
  }

  private clearOwned(
    marker: IMarker | null,
    decorations: IDecoration[],
    listeners: IDisposable[],
  ): void {
    listeners.forEach((d) => d.dispose());
    decorations.forEach((d) => d.dispose());
    marker?.dispose();
  }
}

/** 解析 Shift+Enter 发送文本的反斜杠转义（\\e / \\x1b / \\n / \\r / \\t / \\\\）。 */
export function decodeTerminalTextEscapes(text: string): string {
  return text.replace(/\\(x1b|e|n|r|t|\\|0)/g, (_all, code: string) => {
    switch (code) {
      case "e":
      case "x1b":
        return "\u001b";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "0":
        return "\0";
      default:
        return "\\";
    }
  });
}

/**
 * 复制规范化（对照 Netcatty normalizeTextOnCopy）：
 * 去掉显示用行尾填充空格，并把软换行拼回逻辑行。
 */
export function normalizeTerminalSelection(term: Terminal): string {
  const range = term.getSelectionPosition();
  if (!range) return term.getSelection().trimEnd();
  const buffer = term.buffer.active;
  const parts: string[] = [];
  for (let row = range.start.y; row <= range.end.y; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const startCol = row === range.start.y ? range.start.x : 0;
    const endCol = row === range.end.y ? range.end.x : line.length;
    const text = line.translateToString(true, startCol, endCol);
    // 软换行行（isWrapped）是上一逻辑行的延续：换行符只加在「下一行不是
    // 延续行」的位置，否则会把视觉折行错当成独立行。
    if (row > range.start.y && !line.isWrapped) parts.push("\n");
    parts.push(text);
  }
  const joined = parts.join("");
  return joined.endsWith("\n") ? joined.slice(0, -1) : joined;
}

/** 读取终端选区文本：规范化开关由调用方决定。 */
export function readTerminalSelection(term: Terminal, normalize: boolean): string {
  return normalize ? normalizeTerminalSelection(term) : term.getSelection();
}

/** 单例 xterm 画布：创建即 fit + focus，销毁时 unmount 清理。 */
export function TerminalView({ onReady, onData, onResize, onOsc7, onFindShortcut, showTimestamps = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const timestampsRef = useRef<Map<number, string>>(new Map());
  const lastTimestampLineRef = useRef<number>(0);
  const timestampRafRef = useRef<number | null>(null);
  const gutterWidthRef = useRef(0);
  const [gutterWidth, setGutterWidth] = useState(0);
  // 回调可能随状态更新而变化，用 ref 保证 xterm 只注册一次处理器。
  const onOsc7Ref = useRef(onOsc7);
  onOsc7Ref.current = onOsc7;
  const onFindRef = useRef(onFindShortcut);
  onFindRef.current = onFindShortcut;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    const initial = getSettings();
    const term = new Terminal(buildXtermOptions(initial));
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // 链接识别：Ctrl/Cmd+点击（修饰键由设置中心的「链接修饰键」决定），
    // 经 open_external_url 交系统浏览器打开（Netcatty WebLinksAddon 等价物）。
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        const s = getSettings();
        if (!linkModifierAllows(s.terminal.linkModifier, event)) return;
        void api.openExternalUrl(uri).catch(() => {});
      }),
    );
    term.open(containerRef.current!);
    xtermRef.current = term;
    fitRef.current = fit;
    // 内嵌图片：SIXEL / Kitty / iTerm IIP（@xterm/addon-image，对照 Netcatty）。
    // 总开关关闭或三个协议全关时不加载 addon，避免向远端声明图形能力。
    let imageAddon: ImageAddon | null = null;
    let imageOptionsKey = "";
    const syncInlineImages = (settings: AppSettings) => {
      const options = resolveInlineImageAddonOptions(settings.terminal);
      const key = options ? JSON.stringify(options) : "";
      if (key === imageOptionsKey) return;
      imageOptionsKey = key;
      if (imageAddon) {
        try {
          imageAddon.dispose();
        } catch {
          /* 已释放 */
        }
        imageAddon = null;
      }
      if (options) {
        try {
          imageAddon = new ImageAddon(options);
          term.loadAddon(imageAddon);
        } catch (e) {
          // 可选能力：addon 不可用时只关闭图片渲染，不影响终端本身。
          imageAddon = null;
          console.warn("[termX] 内嵌图片加载失败", e);
        }
      }
    };
    syncInlineImages(initial);
    const container = containerRef.current!;
    applyFontVisuals(container, initial);
    applyTermBackground(container, initial);
    fit.fit();
    term.focus();

    const highlighter = new CursorLineHighlighter(term);
    highlighter.setBackgroundColor(resolveCursorLineColor(initial));
    highlighter.setEnabled(initial.terminal.highlightCursorLine);

    const disposables: IDisposable[] = [];
    disposables.push(term.onData((s) => onDataRef.current?.(s)));
    disposables.push(term.onResize(({ cols, rows }) => onResize?.(cols, rows)));
    // OSC 7 = 当前目录；xterm 解析后回调负载（`file://host/path`）。
    disposables.push(
      term.parser.registerOscHandler(7, (payload) => {
        onOsc7Ref.current?.(payload);
        return true;
      }),
    );

    // ── 行为区：输入 / 选择 / 粘贴 ──────────────────────────────
    // Shift+Enter 发送配置文本（默认 \e\r，传统 Alt+Enter 编码）。
    term.attachCustomKeyEventHandler((e) => {
      const s = getSettings();
      if (e.type === "keydown" && isFindShortcut(e)) {
        // Cmd/Ctrl+F 打开搜索条（对照 Netcatty searchTerminal 热键），
        // 返回 false 阻止 Ctrl+F 被当作控制字符发往远端。
        onFindRef.current?.();
        return false;
      }
      if (
        IS_MAC_PLATFORM &&
        s.terminal.optionArrowWordJump &&
        e.type === "keydown" &&
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        // Meta-b / Meta-f：readline/zle 按单词移动光标。
        onDataRef.current?.(e.key === "ArrowLeft" ? "\u001bb" : "\u001bf");
        return false;
      }
      if (
        s.terminal.shiftEnterNewlineEnabled &&
        e.type === "keydown" &&
        e.key === "Enter" &&
        e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.isComposing
      ) {
        onDataRef.current?.(decodeTerminalTextEscapes(s.terminal.shiftEnterNewlineText));
        return false;
      }
      if (s.terminal.scrollOnKeyPress) term.scrollToBottom();
      return true;
    });

    // 选择即复制（规范化开关跟随复制设置）。
    const selDisposable = term.onSelectionChange(() => {
      const s = getSettings();
      if (!s.terminal.copyOnSelect) return;
      const text = readTerminalSelection(term, s.terminal.normalizeTextOnCopy);
      if (text) void navigator.clipboard.writeText(text).catch(() => {});
    });
    disposables.push(selDisposable);

    // 输出时自动滚动。
    const writeParsed = term.onWriteParsed(() => {
      if (getSettings().terminal.scrollOnOutput) term.scrollToBottom();
    });
    disposables.push(writeParsed);

    // 粘贴：多行确认 / 括号粘贴 / 粘贴后滚动 / 剪贴板图片。
    const textarea = term.textarea;
    const onPaste = (e: ClipboardEvent) => {
      const s = getSettings();
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text) {
        // 图片粘贴仅在支持自动上传时才有意义；未移植时保持默认行为。
        return;
      }
      if (s.terminal.confirmBeforeMultilinePaste) {
        const lines = text.split(/\r\n|\r|\n/).length;
        if (lines >= s.terminal.multilinePasteConfirmMinLines) {
          e.preventDefault();
          const ok = window.confirm(
            `即将粘贴 ${lines} 行 / ${text.length} 个字符，确认发送？`,
          );
          if (!ok) return;
          term.paste(text);
          if (s.terminal.scrollOnPaste) term.scrollToBottom();
          return;
        }
      }
      if (s.terminal.scrollOnPaste) term.scrollToBottom();
    };
    textarea?.addEventListener("paste", onPaste, true);

    // 输入时保留选区（对照 Netcatty preserveSelectionOnInput）：xterm 在键入后
    // 会清掉选区，这里在两个事件后用一个 microtask 把选区放回去。
    const preserveSelectionOnInput = () => {
      const s = getSettings();
      if (!s.terminal.preserveSelectionOnInput || !term.hasSelection()) return;
      const sel = term.getSelectionPosition();
      if (!sel) return;
      const length = (sel.end.y - sel.start.y) * term.cols + (sel.end.x - sel.start.x);
      queueMicrotask(() => {
        if (term.hasSelection()) return;
        // 回滚缓冲裁剪后旧行号可能越界。
        if (sel.start.y >= term.buffer.active.length) return;
        term.select(sel.start.x, sel.start.y, length);
      });
    };
    textarea?.addEventListener("keydown", preserveSelectionOnInput, true);
    textarea?.addEventListener("keypress", preserveSelectionOnInput, true);

    // OSC 52 剪贴板（远程程序读写本机剪贴板）。
    const osc52 = term.parser.registerOscHandler(52, (payload) => {
      const s = getSettings();
      if (s.terminal.osc52Clipboard === "off") return true;
      const sep = payload.indexOf(";");
      if (sep < 0) return true;
      const body = payload.slice(sep + 1);
      if (body) {
        // 远端可发任意 payload；非法 base64 不能让异常穿透 xterm 的解析链路。
        try {
          const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
          void navigator.clipboard
            .writeText(new TextDecoder().decode(bytes))
            .catch(() => {});
        } catch {
          // 忽略非法负载。
        }
        return true;
      }
      const mode = s.terminal.osc52Clipboard;
      if (mode === "write-only") return true;
      if (mode === "prompt" && !window.confirm("远程程序请求读取剪贴板，是否允许？")) {
        return true;
      }
      void api
        .clipboardRead()
        .then((text) => {
          // 大段剪贴板不能用 String.fromCharCode(...bytes) 展开（参数上限约
          // 12 万，会抛 RangeError），逐字节拼接更稳。
          const bytes = new TextEncoder().encode(text);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]);
          }
          onDataRef.current?.(`\u001b]52;c;${btoa(binary)}\u0007`);
        })
        .catch(() => {});
      return true;
    });
    disposables.push(osc52);

    // OSC 9 / 777 / 99 桌面通知（对照 Netcatty terminalOscNotifications）。
    const emitOscNotification = (notification: OscNotification | null) => {
      if (!notification) return;
      const s = getSettings();
      const windowFocused = typeof document !== "undefined" && document.hasFocus();
      if (!shouldShowOscNotification(s.terminal.oscNotifications, windowFocused)) return;
      const { title, body } = resolveOscNotificationPresentation(notification);
      if (!body) return;
      try {
        if (typeof Notification === "undefined") return;
        if (Notification.permission === "granted") {
          new Notification(title, { body });
        } else if (Notification.permission !== "denied") {
          void Notification.requestPermission()
            .then((permission) => {
              if (permission === "granted") new Notification(title, { body });
            })
            .catch(() => {});
        }
      } catch {
        // WebView 不支持桌面通知时静默跳过，不影响终端本身。
      }
    };
    const osc99Assembler = new Osc99Assembler();
    disposables.push(
      term.parser.registerOscHandler(9, (data) => {
        emitOscNotification(parseOsc9Payload(data));
        return true;
      }),
      term.parser.registerOscHandler(777, (data) => {
        emitOscNotification(parseOsc777Payload(data));
        return true;
      }),
      term.parser.registerOscHandler(99, (data) => {
        emitOscNotification(osc99Assembler.consume(data));
        return true;
      }),
    );

    // 设置变更（字体 / 光标 / 主题等）实时同步到已打开的终端。
    const unsubSettings = subscribeSettings(() => {
      const s = getSettings();
      syncInlineImages(s);
      term.options = buildXtermOptions(s);
      applyFontVisuals(container, s);
      applyTermBackground(container, s);
      // 字号 / 字重 / 行间距会改变单元格尺寸，xterm 只重算 cell 不重排列数，
      // 必须重新 fit 并通过 onResize 同步远端 PTY 尺寸。
      fit.fit();
      highlighter.setBackgroundColor(resolveCursorLineColor(s));
      highlighter.setEnabled(s.terminal.highlightCursorLine);
    });

    // 分屏 / 切换标签会改变容器尺寸（隐藏标签的尺寸为 0），
    // 靠 ResizeObserver 重新 fit，避免行列停留在旧值。
    const ro = new ResizeObserver(() => {
      if (containerRef.current) fit.fit();
    });
    ro.observe(container);

    onReady({ term, fit, search });

    return () => {
      unsubSettings();
      ro.disconnect();
      textarea?.removeEventListener("paste", onPaste, true);
      textarea?.removeEventListener("keydown", preserveSelectionOnInput, true);
      textarea?.removeEventListener("keypress", preserveSelectionOnInput, true);
      highlighter.dispose();
      disposables.forEach((d) => d.dispose());
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 输出行时间戳 gutter（对照 Netcatty TerminalTimestampGutter）──
  useEffect(() => {
    const term = xtermRef.current;
    const container = containerRef.current;
    if (!term || !container) return;
    const initial = term.buffer.active;
    lastTimestampLineRef.current = initial.baseY + initial.cursorY;
    const stamps = new Map<number, string>();
    timestampsRef.current = stamps;

    if (!showTimestamps) {
      setGutterWidth(0);
      return;
    }

    const render = () => {
      timestampRafRef.current = null;
      const gutter = gutterRef.current;
      if (!gutter) return;
      const buffer = term.buffer.active;
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      const rows =
        buffer.type === "alternate" || !screen || term.rows <= 0
          ? []
          : resolveVisibleTerminalTimestampRows({
              stamps,
              viewportY: buffer.viewportY,
              rows: term.rows,
              isWrapped: (line) => buffer.getLine(line)?.isWrapped === true,
            });
      const cellHeight = screen && term.rows > 0
        ? screen.clientHeight / term.rows
        : 0;
      const gutterRect = gutter.getBoundingClientRect();
      const screenTop = screen
        ? screen.getBoundingClientRect().top - gutterRect.top
        : 4;
      const fontStyle = screen ? window.getComputedStyle(screen) : null;
      const fontSize = fontStyle
        ? Number.parseFloat(fontStyle.fontSize) || 12
        : 12;
      const width = resolveTerminalTimestampGutterWidth({ fontSize });
      if (width !== gutterWidthRef.current) {
        gutterWidthRef.current = width;
        setGutterWidth(width);
      }
      gutter.style.fontFamily = fontStyle?.fontFamily ?? "monospace";
      gutter.style.fontSize = `${fontSize}px`;
      gutter.style.fontWeight = fontStyle?.fontWeight ?? "400";
      gutter.style.color =
        term.options.theme?.brightCyan ??
        window.getComputedStyle(gutter).getPropertyValue("--terminal-timestamp-fg") ??
        "#56d4dd";
      gutter.style.background = term.options.theme?.background ?? "transparent";

      const children = gutter.children;
      let index = 0;
      for (; index < rows.length; index += 1) {
        let item = children[index] as HTMLElement | undefined;
        if (!item) {
          item = document.createElement("div");
          item.className = "term-timestamp-row";
          gutter.appendChild(item);
        }
        const { row, label } = rows[index];
        if (item.textContent !== label) item.textContent = label;
        item.style.top = `${screenTop + row * cellHeight}px`;
        item.style.height = `${cellHeight}px`;
        item.style.lineHeight = `${cellHeight}px`;
        item.style.display = "";
      }
      for (; index < children.length; index += 1) {
        (children[index] as HTMLElement).style.display = "none";
      }
    };

    const scheduleRender = () => {
      if (timestampRafRef.current !== null) return;
      timestampRafRef.current = requestAnimationFrame(render);
    };

    const parsed = term.onWriteParsed(() => {
      const buffer = term.buffer.active;
      if (buffer.type !== "alternate") {
        const current = buffer.baseY + buffer.cursorY;
        if (current >= lastTimestampLineRef.current) {
          lastTimestampLineRef.current = stampTerminalTimestampLines({
            stamps,
            previousAbsolute: lastTimestampLineRef.current,
            currentAbsolute: current,
            label: formatTerminalTimestamp(new Date()),
            isWrapped: (line) => buffer.getLine(line)?.isWrapped === true,
          });
          pruneTerminalTimestampLines(stamps, buffer.baseY - 200);
        } else {
          lastTimestampLineRef.current = current;
        }
      }
      scheduleRender();
    });
    const scroll = term.onScroll(scheduleRender);
    const rendered = term.onRender(scheduleRender);
    const resized = term.onResize(scheduleRender);
    const ro = new ResizeObserver(scheduleRender);
    ro.observe(container);
    render();

    return () => {
      parsed.dispose();
      scroll.dispose();
      rendered.dispose();
      resized.dispose();
      ro.disconnect();
      if (timestampRafRef.current !== null) {
        cancelAnimationFrame(timestampRafRef.current);
        timestampRafRef.current = null;
      }
      stamps.clear();
    };
  }, [showTimestamps]);

  // gutter 出现/变宽后容器尺寸变化，重新 fit 并同步远端 PTY 行列。
  useEffect(() => {
    fitRef.current?.fit();
  }, [showTimestamps, gutterWidth]);

  return (
    <div className="terminal-shell">
      {showTimestamps && (
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="terminal-timestamp-gutter"
          data-section="terminal-timestamp-gutter"
          style={{ width: gutterWidth || 56 }}
        />
      )}
      <div
        ref={containerRef}
        className="terminal"
        style={terminalInsetsStyle()}
      />
    </div>
  );
}
