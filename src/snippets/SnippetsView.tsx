// Snippets 管理页（P0 #5 阶段 A）。
// 对照 Netcatty `components/SnippetsManager.tsx`：列表 / 搜索 / 分组（package）/
// 新建 / 编辑 / 删除 + 快捷键 + 自动执行开关。
// 「插入到终端」在终端侧完成（TerminalPane 右键菜单与逐片段快捷键），
// 仅写入当前活动窗格的会话，不做跨会话发送。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../backend/client";
import type { Snippet } from "../backend/client";
import type { PaneHandle } from "../TerminalPane";
import { userVisibleError } from "../domain/sshErrors";
import {
  SNIPPETS_CHANGED_EVENT,
  deleteSnippetPackage,
  ensureSnippetIds,
  filterSnippets,
  findShortkeyConflict,
  groupSnippets,
  parseShortkey,
  renameSnippetPackage,
  resolveScriptTrigger,
  scriptTriggerNote,
} from "./snippetsModel";
import {
  clearScriptTriggers,
  subscribeScriptTriggers,
  type ScriptTriggerEntry,
} from "./scriptTriggerLog";
import {
  buildSnippetExportPayload,
  describeImportStats,
  mergeSnippetImport,
  parseSnippetImportPayload,
} from "./snippetsTransfer";
import "./snippets.css";

type SnippetKind = "" | "script";
type RunMode = "" | "paste" | "lineDelay";

type Draft = {
  id: string;
  name: string;
  command: string;
  description: string;
  package: string;
  tagsText: string;
  shortkey: string;
  noAutoRun: boolean;
  kind: SnippetKind;
  multiLineRunMode: RunMode;
  language: string;
  /** "" = 手动；onConnect / onOutput 由终端窗格在渲染层自动执行（阶段 B）。 */
  trigger: "" | "onConnect" | "onOutput";
  triggerPattern: string;
  targets: string[];
  targetsAllHosts: boolean;
};

function toDraft(s: Snippet): Draft {
  return {
    id: s.id,
    name: s.name,
    command: s.command,
    description: s.description,
    package: s.package,
    tagsText: s.tags.join(", "),
    shortkey: s.shortkey,
    noAutoRun: s.no_auto_run,
    kind: s.kind === "script" ? "script" : "",
    multiLineRunMode:
      s.multi_line_run_mode === "lineDelay" || s.multi_line_run_mode === "paste"
        ? s.multi_line_run_mode
        : "",
    language: s.language || "shell",
    trigger: s.trigger === "onConnect" || s.trigger === "onOutput" ? s.trigger : "",
    triggerPattern: s.trigger_pattern || "",
    targets: s.targets ?? [],
    targetsAllHosts: s.targets_all_hosts === true,
  };
}

function emptyDraft(): Draft {
  return {
    id: "",
    name: "",
    command: "",
    description: "",
    package: "",
    tagsText: "",
    shortkey: "",
    noAutoRun: false,
    kind: "",
    multiLineRunMode: "",
    language: "shell",
    trigger: "",
    triggerPattern: "",
    targets: [],
    targetsAllHosts: false,
  };
}

export function SnippetsView({ activeHandle }: { activeHandle?: PaneHandle | null }) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [pkgFilter, setPkgFilter] = useState(""); // "" = 全部分组
  const [kindFilter, setKindFilter] = useState<"" | "snippet" | "script">("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [pkgRename, setPkgRename] = useState<{ from: string; to: string } | null>(null);
  /** 最近一次运行的脚本（横幅 + 停止 / 暂停 / 恢复）；切换活动终端时清空。 */
  const [run, setRun] = useState<{ name: string; paneId: string } | null>(null);
  /** onConnect 目标主机选择用的主机列表。 */
  const [hosts, setHosts] = useState<{ id: string; name: string; host: string }[]>([]);
  /** 自动触发日志（内存，跨终端窗格共享）。 */
  const [triggerLog, setTriggerLog] = useState<ScriptTriggerEntry[]>([]);
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setErr("");
      setSnippets(ensureSnippetIds(await api.loadSnippets()));
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 切换活动窗格 / 关闭终端后清空运行横幅，避免把控制键发给错误的会话。
  useEffect(() => {
    setRun(null);
  }, [activeHandle]);

  useEffect(() => {
    let alive = true;
    api
      .listProfiles()
      .then((list) => {
        if (alive) {
          setHosts(list.map((p) => ({ id: p.id, name: p.name, host: p.host })));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => subscribeScriptTriggers(setTriggerLog), []);

  /** 保存全量列表并通知终端侧刷新；成功后执行 onDone。 */
  const persist = useCallback(
    async (next: Snippet[], onDone?: () => void) => {
      setBusy(true);
      setErr("");
      try {
        await api.saveSnippets(next);
        setSnippets(next);
        window.dispatchEvent(new Event(SNIPPETS_CHANGED_EVENT));
        onDone?.();
      } catch (e) {
        setErr(userVisibleError(String(e)));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const packages = useMemo(
    () =>
      [...new Set(snippets.map((s) => (s.package || "").trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [snippets],
  );

  const groups = useMemo(() => {
    let list = filterSnippets(snippets, query);
    if (pkgFilter) list = list.filter((s) => (s.package || "").trim() === pkgFilter);
    if (kindFilter === "script") list = list.filter((s) => s.kind === "script");
    else if (kindFilter === "snippet") list = list.filter((s) => s.kind !== "script");
    return groupSnippets(list);
  }, [snippets, query, pkgFilter, kindFilter]);

  const openNew = () => {
    setIsNew(true);
    setErr("");
    setDraft({ ...emptyDraft(), package: pkgFilter });
  };

  const openEdit = (s: Snippet) => {
    setIsNew(false);
    setErr("");
    setDraft(toDraft(s));
  };

  /** 运行脚本：把内容发送到活动终端；未连接 / 无会话时只提示，不假装执行。 */
  const runScript = (s: Snippet) => {
    if (!activeHandle) {
      setNotice("先在终端打开一个已连接的会话，再回来运行脚本。");
      return;
    }
    if (!activeHandle.connected()) {
      setNotice("活动终端当前未连接，无法运行脚本。");
      return;
    }
    if (!activeHandle.runSnippet(s)) {
      setNotice("脚本未能发送：终端未就绪。");
      return;
    }
    setRun({ name: s.name, paneId: activeHandle.paneId });
    setNotice(`已在活动终端运行「${s.name}」`);
  };

  /** 停止 = Ctrl-C（SIGINT）；暂停 / 恢复走 shell 的 SIGTSTP / fg。 */
  const controlRun = (action: "stop" | "pause" | "resume") => {
    if (!activeHandle) return;
    const ok =
      action === "stop"
        ? activeHandle.interrupt()
        : action === "pause"
          ? activeHandle.suspend()
          : activeHandle.resume();
    if (!ok) {
      setNotice("活动终端已断开，无法发送控制键。");
      return;
    }
    setNotice(
      action === "stop"
        ? "已发送 Ctrl-C（SIGINT）"
        : action === "pause"
          ? "已发送 Ctrl-Z（SIGTSTP），仅挂起 shell 前台任务"
          : "已发送 fg，恢复挂起的前台任务",
    );
  };

  const saveDraft = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setErr("名称不能为空");
      return;
    }
    if (!draft.command.trim()) {
      setErr("命令内容不能为空");
      return;
    }
    if (draft.shortkey.trim() && !parseShortkey(draft.shortkey)) {
      setErr(`快捷键格式无效：${draft.shortkey}（示例：F1 或 Ctrl + Shift + F1）`);
      return;
    }
    const conflict = findShortkeyConflict(snippets, draft.shortkey, draft.id || undefined);
    if (conflict) {
      setErr(`快捷键 ${draft.shortkey.trim()} 已被片段「${conflict.name}」占用`);
      return;
    }
    const next: Snippet = {
      id: draft.id || crypto.randomUUID(),
      name,
      command: draft.command,
      description: draft.description.trim(),
      package: draft.package.trim(),
      tags: draft.tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      shortkey: draft.shortkey.trim(),
      no_auto_run: draft.noAutoRun,
      kind: draft.kind === "script" ? "script" : "",
      multi_line_run_mode: draft.multiLineRunMode,
      // 语言 / 触发方式只对脚本有意义；trigger="" 即手动运行。
      language: draft.kind === "script" ? draft.language || "shell" : "",
      trigger: draft.kind === "script" ? draft.trigger : "",
      trigger_pattern:
        draft.kind === "script" && draft.trigger === "onOutput"
          ? draft.triggerPattern.trim()
          : "",
      targets: draft.kind === "script" ? draft.targets : [],
      targets_all_hosts: draft.kind === "script" ? draft.targetsAllHosts : false,
    };
    const list = isNew
      ? [...snippets, next]
      : snippets.map((s) => (s.id === next.id ? next : s));
    void persist(list, () => setDraft(null));
  };

  const removeSnippet = (s: Snippet) => {
    if (!window.confirm(`删除片段「${s.name}」？不可恢复。`)) return;
    void persist(snippets.filter((x) => x.id !== s.id));
  };

  const removePackage = (pkg: string) => {
    const count = snippets.filter(
      (s) => s.package === pkg || s.package.startsWith(`${pkg}/`),
    ).length;
    if (!window.confirm(`删除分组「${pkg}」及其下 ${count} 条片段？不可恢复。`)) return;
    void persist(deleteSnippetPackage(snippets, pkg));
  };

  const applyPkgRename = () => {
    if (!pkgRename) return;
    const to = pkgRename.to.trim();
    if (!to || to === pkgRename.from) return;
    void persist(renameSnippetPackage(snippets, pkgRename.from, to), () =>
      setPkgRename(null),
    );
    if (pkgFilter === pkgRename.from) setPkgFilter(to);
  };

  /** 导出为 Netcatty snippet 传输格式（kind=netcatty.snippets / version 3）。 */
  const exportSnippets = () => {
    try {
      const payload = buildSnippetExportPayload(snippets);
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `termx-snippets-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${snippets.length} 条`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  /** 导入：解析 → 按命令判冲突（覆盖 / 跳过）→ 全量保存并通知终端刷新。 */
  const importSnippets = async (file: File) => {
    setBusy(true);
    setErr("");
    setNotice("");
    try {
      const payload = parseSnippetImportPayload(await file.text());
      if (payload.snippets.length === 0) throw new Error("导入文件没有可用条目");
      const overwrite = window.confirm(
        `共 ${payload.snippets.length} 条。命令相同的条目是否覆盖本地？\n确定 = 覆盖，取消 = 跳过`,
      );
      const merged = mergeSnippetImport({
        existing: snippets,
        payload,
        conflictAction: overwrite ? "overwrite" : "skip",
        createId: () => crypto.randomUUID(),
      });
      await api.saveSnippets(merged.snippets);
      setSnippets(merged.snippets);
      window.dispatchEvent(new Event(SNIPPETS_CHANGED_EVENT));
      setNotice(`导入完成：${describeImportStats(merged.stats)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="snippets-page">
      <div className="snippets-toolbar">
        <div className="snippets-search">
          <input
            value={query}
            placeholder="搜索片段（名称 / 命令 / 描述 / 标签）"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          value={pkgFilter}
          title="按分组筛选"
          onChange={(e) => setPkgFilter(e.target.value)}
        >
          <option value="">全部分组</option>
          {packages.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={kindFilter}
          title="按类型筛选"
          onChange={(e) => setKindFilter(e.target.value as "" | "snippet" | "script")}
        >
          <option value="">全部类型</option>
          <option value="snippet">片段</option>
          <option value="script">脚本</option>
        </select>
        <div className="snippets-toolbar-spacer" />
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importSnippets(f);
          }}
        />
        <button onClick={() => importRef.current?.click()} disabled={busy}>
          导入
        </button>
        <button onClick={exportSnippets} disabled={busy || snippets.length === 0}>
          导出
        </button>
        <button className="snippets-primary" onClick={openNew} disabled={busy}>
          新建片段
        </button>
      </div>

      {err && <div className="snippets-error">{err}</div>}
      {notice && <div className="snippets-notice">{notice}</div>}

      <div className="snippets-runbar">
        <span className="snippets-run-target">
          活动终端：
          {activeHandle
            ? activeHandle.connected()
              ? "已连接"
              : "未连接"
            : "未打开（先在终端打开会话）"}
        </span>
        {run && activeHandle && (
          <>
            <span className="snippets-run-name">正在运行「{run.name}」</span>
            <button onClick={() => controlRun("stop")}>停止</button>
            <button onClick={() => controlRun("pause")}>暂停</button>
            <button onClick={() => controlRun("resume")}>恢复</button>
          </>
        )}
        <span className="snippets-run-hint">
          停止 = Ctrl-C（SIGINT）；暂停 = Ctrl-Z（SIGTSTP）；恢复 = fg。暂停 / 恢复只作用于
          shell 前台任务，不改变逐行发送队列。
        </span>
      </div>

      <div className="snippets-trigger-log">
        <div className="snippets-trigger-log-head">
          <span>自动触发日志（{triggerLog.length}）</span>
          <button
            onClick={() => clearScriptTriggers()}
            disabled={!triggerLog.length}
          >
            清空
          </button>
        </div>
        {triggerLog.length === 0 ? (
          <p>暂无记录；onConnect / onOutput 脚本触发后会显示在这里。</p>
        ) : (
          <ul>
            {triggerLog.slice(-6).reverse().map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className={`snippets-trigger-status ${e.status}`}>
                  {e.status === "done" ? "完成" : e.status === "error" ? "失败" : "执行中"}
                </span>
                <span>
                  {new Date(e.at).toLocaleTimeString()} ·{" "}
                  {e.kind === "onConnect" ? "连接触发" : "输出触发"} · {e.name}
                </span>
                <span className="snippets-trigger-detail">{e.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="snippets-body">
        {snippets.length === 0 ? (
          <div className="snippets-empty">
            <h2>还没有片段</h2>
            <p>把常用命令存成片段，之后在终端右键菜单或用快捷键一键插入。</p>
          </div>
        ) : groups.length === 0 ? (
          <div className="snippets-empty">
            <h2>没有匹配的片段</h2>
            <p>换个关键词试试。</p>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.pkg || "__ungrouped"} className="snippets-group">
              <header className="snippets-group-head">
                <span className="snippets-group-name">{g.pkg || "未分组"}</span>
                <span className="snippets-group-count">{g.items.length}</span>
                {g.pkg && (
                  <div className="snippets-group-actions">
                    <button onClick={() => setPkgRename({ from: g.pkg, to: g.pkg })}>
                      重命名
                    </button>
                    <button onClick={() => removePackage(g.pkg)}>删除分组</button>
                  </div>
                )}
              </header>
              <div className="snippets-rows">
                {g.items.map((s) => (
                  <div key={s.id} className="snippets-row" onClick={() => openEdit(s)}>
                    <div className="snippets-row-main">
                      <div className="snippets-row-title">
                        <span className="snippets-row-name">{s.name}</span>
                        {s.kind === "script" && (
                          <span className="snippets-flag-badge">脚本</span>
                        )}
                        {s.trigger === "onConnect" || s.trigger === "onOutput" ? (
                          <span
                            className="snippets-flag-badge"
                            title={scriptTriggerNote(s.trigger)}
                          >
                            自动触发
                          </span>
                        ) : null}
                        {s.shortkey && (
                          <span className="snippets-shortkey-badge">{s.shortkey}</span>
                        )}
                        {s.multi_line_run_mode === "lineDelay" && (
                          <span className="snippets-flag-badge">逐行</span>
                        )}
                        {s.no_auto_run && <span className="snippets-flag-badge">仅插入</span>}
                      </div>
                      <div className="snippets-row-command">
                        {s.command.split(/\r?\n/)[0]}
                      </div>
                      {s.description && <div className="snippets-row-desc">{s.description}</div>}
                      {s.tags.length > 0 && (
                        <div className="snippets-row-tags">
                          {s.tags.map((t) => (
                            <span key={t}>{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="snippets-row-actions" onClick={(e) => e.stopPropagation()}>
                      {s.kind === "script" && (
                        <button
                          onClick={() => runScript(s)}
                          disabled={!activeHandle || !activeHandle.connected()}
                          title={
                            !activeHandle
                              ? "先在终端打开一个会话"
                              : !activeHandle.connected()
                                ? "活动终端未连接"
                                : "发送到活动终端执行"
                          }
                        >
                          运行
                        </button>
                      )}
                      <button onClick={() => openEdit(s)}>编辑</button>
                      <button onClick={() => removeSnippet(s)}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {pkgRename && (
        <div className="snippets-modal-backdrop">
          <div className="snippets-modal">
            <h3>重命名分组</h3>
            <label>
              <span>分组路径</span>
              <input
                autoFocus
                value={pkgRename.to}
                onChange={(e) => setPkgRename({ ...pkgRename, to: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyPkgRename();
                  if (e.key === "Escape") setPkgRename(null);
                }}
              />
            </label>
            <p className="snippets-modal-hint">
              子分组会一并改名（如 {pkgRename.from}/db →{" "}
              {pkgRename.to.trim() || "<新名>"}/db）。
            </p>
            <div className="snippets-modal-actions">
              <button onClick={() => setPkgRename(null)}>取消</button>
              <button
                className="snippets-primary"
                disabled={!pkgRename.to.trim() || pkgRename.to.trim() === pkgRename.from}
                onClick={applyPkgRename}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <aside className="snippets-aside">
          <header className="snippets-aside-head">
            <h3>{isNew ? "新建片段" : "编辑片段"}</h3>
            <button className="snippets-aside-close" onClick={() => setDraft(null)} title="关闭">
              ×
            </button>
          </header>
          <div className="snippets-aside-body">
            <label>
              <span>类型</span>
              <select
                value={draft.kind}
                onChange={(e) =>
                  setDraft({ ...draft, kind: e.target.value as SnippetKind })
                }
              >
                <option value="">片段（插入到终端）</option>
                <option value="script">脚本（发送到活动终端执行）</option>
              </select>
              <em>
                {draft.kind === "script"
                  ? "执行时把内容发送给当前会话的 shell，输出直接回显；Netcatty 的 nct.* JS 运行时未移植。"
                  : "片段在终端右键菜单或按快捷键插入到当前会话。"}
              </em>
            </label>
            {draft.kind === "script" && (
              <>
                <label>
                  <span>脚本语言</span>
                  <select
                    value={draft.language || "shell"}
                    onChange={(e) => setDraft({ ...draft, language: e.target.value })}
                  >
                    <option value="shell">shell（发送到活动会话执行）</option>
                    <option value="javascript" disabled>
                      javascript（nct.* JS 运行时未移植）
                    </option>
                    <option value="python" disabled>
                      python（无 Python 运行时）
                    </option>
                  </select>
                  <em>
                    termX 脚本按 shell 命令发送到活动终端；Netcatty 的 nct.* JS API
                    （屏幕等待 / 对话框 / 进度）未移植，javascript / python 仅为标签。
                  </em>
                </label>
                <label>
                  <span>触发方式</span>
                  <select
                    value={resolveScriptTrigger(draft.trigger)}
                    onChange={(e) => {
                      const v = e.target.value;
                      setDraft({
                        ...draft,
                        trigger: v === "onConnect" || v === "onOutput" ? v : "",
                      });
                    }}
                  >
                    <option value="manual">手动运行（在脚本页点「运行」）</option>
                    <option value="onConnect">连接后自动执行（仅 SSH）</option>
                    <option value="onOutput">输出匹配自动执行</option>
                  </select>
                  <em>{scriptTriggerNote(draft.trigger)}</em>
                </label>
                {draft.trigger === "onConnect" && (
                  <div className="snippets-target-field">
                    <span>目标主机</span>
                    <label className="snippets-inline-check">
                      <input
                        type="checkbox"
                        checked={draft.targetsAllHosts}
                        onChange={(e) =>
                          setDraft({ ...draft, targetsAllHosts: e.target.checked })
                        }
                      />
                      所有主机
                    </label>
                    {!draft.targetsAllHosts && (
                      <div className="snippets-target-list">
                        {hosts.length === 0 ? (
                          <em>本机还没有主机；未选择目标时不会自动执行。</em>
                        ) : (
                          hosts.map((h) => (
                            <label key={h.id} className="snippets-inline-check">
                              <input
                                type="checkbox"
                                checked={draft.targets.includes(h.id)}
                                onChange={(e) =>
                                  setDraft({
                                    ...draft,
                                    targets: e.target.checked
                                      ? [...draft.targets, h.id]
                                      : draft.targets.filter((x) => x !== h.id),
                                  })
                                }
                              />
                              {h.name}（{h.host}）
                            </label>
                          ))
                        )}
                      </div>
                    )}
                    <em>目标主机命中时，连接建立并出现提示符后按顺序执行。</em>
                  </div>
                )}
                {draft.trigger === "onOutput" && (
                  <label>
                    <span>触发模式（正则）</span>
                    <input
                      value={draft.triggerPattern}
                      onChange={(e) =>
                        setDraft({ ...draft, triggerPattern: e.target.value })
                      }
                      placeholder="sudo.*password"
                    />
                    <em>同一会话同一脚本只触发一次；正则无效时不会触发。</em>
                  </label>
                )}
                <em>
                  屏幕等待指令：`#@wait-prompt [ms]`、`#@wait-text &lt;文本&gt; [ms]`、
                  `#@wait-regex &lt;正则&gt; [ms]`（基于本机终端缓冲）。
                  未移植并置灰：录制回放、nct.dialog（主进程回调）、nct.progress /
                  nct.session.startLog（宿主能力）。
                </em>
              </>
            )}
            <label>
              <span>名称 *</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="如：查看磁盘用量"
              />
            </label>
            <label>
              <span>{draft.kind === "script" ? "脚本内容 *" : "命令 *"}</span>
              <textarea
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                placeholder={
                  draft.kind === "script"
                    ? "如：\nset -e\necho start\nuptime"
                    : "如：df -h"
                }
                rows={5}
                spellCheck={false}
              />
            </label>
            <label>
              <span>多行运行方式</span>
              <select
                value={draft.multiLineRunMode || "paste"}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    multiLineRunMode:
                      e.target.value === "lineDelay" ? "lineDelay" : "",
                  })
                }
              >
                <option value="paste">一次性发送</option>
                <option value="lineDelay">逐行发送（每行 250ms）</option>
              </select>
              <em>仅多行且自动执行时生效；登录提示、网络设备宏等场景可用逐行发送。</em>
            </label>
            <label>
              <span>描述</span>
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="可选"
              />
            </label>
            <label>
              <span>分组</span>
              <input
                value={draft.package}
                onChange={(e) => setDraft({ ...draft, package: e.target.value })}
                placeholder="如 ops/db；留空 = 未分组"
                list="snippets-package-options"
              />
              <datalist id="snippets-package-options">
                {packages.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </label>
            <label>
              <span>标签</span>
              <input
                value={draft.tagsText}
                onChange={(e) => setDraft({ ...draft, tagsText: e.target.value })}
                placeholder="用逗号分隔"
              />
            </label>
            <label>
              <span>快捷键</span>
              <input
                value={draft.shortkey}
                onChange={(e) => setDraft({ ...draft, shortkey: e.target.value })}
                placeholder="如 F1 或 Ctrl + Shift + F1"
              />
              <em>终端获得焦点时，按快捷键插入到当前会话</em>
            </label>
            <label className="snippets-checkbox">
              <input
                type="checkbox"
                checked={draft.noAutoRun}
                onChange={(e) => setDraft({ ...draft, noAutoRun: e.target.checked })}
              />
              <span>仅插入，不自动执行（不发送回车）</span>
            </label>
          </div>
          <footer className="snippets-aside-foot">
            <button onClick={() => setDraft(null)}>取消</button>
            <button className="snippets-primary" onClick={saveDraft} disabled={busy}>
              保存
            </button>
          </footer>
        </aside>
      )}
    </div>
  );
}
