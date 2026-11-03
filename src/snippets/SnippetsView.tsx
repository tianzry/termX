// Snippets 管理页（P0 #5 阶段 A）。
// 对照 Netcatty `components/SnippetsManager.tsx`：列表 / 搜索 / 分组（package）/
// 新建 / 编辑 / 删除 + 快捷键 + 自动执行开关。
// 「插入到终端」在终端侧完成（TerminalPane 右键菜单与逐片段快捷键），
// 仅写入当前活动窗格的会话，不做跨会话发送。
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../backend/client";
import type { Snippet } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import {
  SNIPPETS_CHANGED_EVENT,
  ensureSnippetIds,
  filterSnippets,
  groupSnippets,
  parseShortkey,
} from "./snippetsModel";
import "./snippets.css";

type Draft = {
  id: string;
  name: string;
  command: string;
  description: string;
  package: string;
  tagsText: string;
  shortkey: string;
  noAutoRun: boolean;
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
  };
}

export function SnippetsView() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [pkgFilter, setPkgFilter] = useState(""); // "" = 全部分组
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);

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
    return groupSnippets(list);
  }, [snippets, query, pkgFilter]);

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
        <div className="snippets-toolbar-spacer" />
        <button className="snippets-primary" onClick={openNew} disabled={busy}>
          新建片段
        </button>
      </div>

      {err && <div className="snippets-error">{err}</div>}

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
              </header>
              <div className="snippets-rows">
                {g.items.map((s) => (
                  <div key={s.id} className="snippets-row" onClick={() => openEdit(s)}>
                    <div className="snippets-row-main">
                      <div className="snippets-row-title">
                        <span className="snippets-row-name">{s.name}</span>
                        {s.shortkey && (
                          <span className="snippets-shortkey-badge">{s.shortkey}</span>
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
              <span>名称 *</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="如：查看磁盘用量"
              />
            </label>
            <label>
              <span>命令 *</span>
              <textarea
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                placeholder="如：df -h"
                rows={5}
                spellCheck={false}
              />
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
