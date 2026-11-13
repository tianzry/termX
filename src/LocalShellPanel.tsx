/**
 * 本地终端主机新建 / 编辑面板（对齐 Netcatty LocalShellHostDetailsPanel）。
 *
 * 右侧 overlay（与 SSH composer 同构），Esc / X 关闭。字段顺序：
 * 名称 → Shell（首项「系统默认 Shell」，value = ''）→ 分组 → 启动目录；
 * 页脚：取消 +（仅新建）保存并打开 + 保存。
 *
 * 保存语义照抄 Netcatty createLocalShellHost（见 domain/localShellHost.ts）；
 * 编辑时合并旧档案，保留本表单不暴露的字段（SFTP / TOTP 等）。
 */
import { useEffect, useMemo, useState } from "react";
import * as api from "./backend/client";
import type { DiscoveredShell, Group, Profile } from "./backend/client";
import { createLocalShellHost } from "./domain/localShellHost";
import { userVisibleError } from "./domain/sshErrors";
import { Icon } from "./ui/icons";

interface Props {
  /** 编辑目标；null = 新建。 */
  initial: Profile | null;
  groups: Group[];
  shells: DiscoveredShell[];
  onClose: () => void;
  /** 保存成功；open=true 表示保存后立即打开终端。 */
  onSaved: (profile: Profile, isNew: boolean, open: boolean) => void;
}

export function LocalShellPanel({
  initial,
  groups,
  shells,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [shell, setShell] = useState(initial?.local_shell ?? "");
  const [groupId, setGroupId] = useState(initial?.group_id ?? "");
  const [startDir, setStartDir] = useState(initial?.local_start_dir ?? "");
  // 自动会话日志：与 SSH / 串口 / Telnet 主机同一列（null = 跟随全局设置）。
  const [autoLog, setAutoLog] = useState(initial?.auto_session_log === true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Shell combobox：draft != null 表示正在输入（可自由输入自定义路径）。
  const [shellOpen, setShellOpen] = useState(false);
  const [shellDraft, setShellDraft] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // 下拉展开时 Esc 只收起下拉（对齐 Netcatty radix combobox），再按才关面板。
        if (shellOpen) {
          e.stopPropagation();
          setShellOpen(false);
          setShellDraft(null);
          return;
        }
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, shellOpen]);

  const matchedShell = useMemo(
    () => shells.find((s) => s.id === shell),
    [shells, shell],
  );

  // Shell 选择未改动时优先主机保存的快照（同步 / 导入场景可能带自定义
  // 参数），对齐 Netcatty LocalShellHostDetailsPanel 的 shellMeta 逻辑。
  const shellMeta =
    shell && initial && shell === initial.local_shell
      ? {
          args: initial.local_shell_args ?? matchedShell?.args,
          name: initial.local_shell_name ?? matchedShell?.name,
          icon: initial.local_shell_icon ?? matchedShell?.icon,
        }
      : matchedShell
        ? {
            args: matchedShell.args,
            name: matchedShell.name,
            icon: matchedShell.icon,
          }
        : undefined;

  // combobox 显示文本：输入中用 draft，否则用已选 shell 的名称 / 自定义值。
  const shellDisplay = shellDraft !== null ? shellDraft : matchedShell?.name ?? shell;
  const shellCombo = useMemo(() => {
    const q = (shellDraft ?? "").trim().toLowerCase();
    const base = [
      { value: "", label: "系统默认 Shell", sublabel: "" },
      ...shells.map((s) => ({ value: s.id, label: s.name, sublabel: s.command })),
    ];
    const filtered = q
      ? base.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.sublabel.toLowerCase().includes(q),
        )
      : base;
    const exact = base.some(
      (o) => o.label.toLowerCase() === q || o.sublabel.toLowerCase() === q,
    );
    return { filtered, canCreate: q.length > 0 && !exact };
  }, [shells, shellDraft]);

  function buildProfile(): Profile {
    const host = createLocalShellHost({
      id: initial?.id,
      name,
      shell,
      shellArgs: shellMeta?.args ?? undefined,
      shellName: shellMeta?.name ?? undefined,
      shellIcon: shellMeta?.icon ?? undefined,
      startDir,
      groupId,
      autoSessionLog: autoLog,
    });
    return initial ? { ...initial, ...host } : host;
  }

  async function save(open: boolean) {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const profile = buildProfile();
      if (initial) await api.updateProfile(profile);
      else await api.createProfile(profile);
      onSaved(profile, !initial, open);
    } catch (e) {
      setErr(userVisibleError(String(e)));
      setBusy(false);
    }
  }

  return (
    <aside
      className="vault-composer local-shell-panel"
      data-section="local-shell-panel"
    >
      <header className="vault-composer-head">
        <div className="vault-composer-heading">
          <span className="vault-composer-title">
            {initial ? "编辑本地终端" : "新建本地终端"}
          </span>
          {initial && <span className="vault-composer-sub">{initial.name}</span>}
        </div>
        <div className="vault-composer-head-actions">
          <button className="nc-icon-btn" title="关闭面板" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
      </header>

      <div className="vault-composer-body">
        {err && <div className="vault-composer-err">{err}</div>}

        <label>
          名称
          <input
            value={name}
            placeholder="例如：项目 A · CMD"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label>
          Shell
          <div
            className="lsh-combo"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setShellOpen(false);
                setShellDraft(null);
              }
            }}
          >
            <div className="lsh-combo-input">
              <Icon name="terminal" size={14} className="lsh-combo-lead" />
              <input
                value={shellDisplay}
                placeholder="系统默认 Shell"
                onFocus={() => setShellOpen(true)}
                onChange={(e) => {
                  setShellDraft(e.target.value);
                  setShellOpen(true);
                }}
              />
              {shell !== "" && (
                <button
                  type="button"
                  className="nc-icon-btn"
                  title="清除"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setShell("");
                    setShellDraft(null);
                  }}
                >
                  <Icon name="x" size={13} />
                </button>
              )}
              <button
                type="button"
                className="nc-icon-btn"
                title="展开"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShellOpen((o) => !o)}
              >
                <Icon name="chevron-down" size={13} />
              </button>
            </div>
            {shellOpen && (
              <div className="lsh-combo-pop">
                {shellCombo.filtered.map((o) => (
                  <button
                    type="button"
                    key={o.value || "__default__"}
                    className={
                      "lsh-combo-opt" + (shell === o.value ? " is-active" : "")
                    }
                    onClick={() => {
                      setShell(o.value);
                      setShellDraft(null);
                      setShellOpen(false);
                    }}
                  >
                    <span className="lsh-combo-opt-main">
                      <span className="lsh-combo-opt-label">{o.label}</span>
                      {o.sublabel && (
                        <span className="lsh-combo-opt-sub">{o.sublabel}</span>
                      )}
                    </span>
                    {shell === o.value && (
                      <Icon name="check" size={13} className="lsh-combo-check" />
                    )}
                  </button>
                ))}
                {shellCombo.filtered.length === 0 && !shellCombo.canCreate && (
                  <div className="lsh-combo-empty">未发现可用 Shell</div>
                )}
                {shellCombo.canCreate && (
                  <button
                    type="button"
                    className="lsh-combo-opt lsh-combo-create"
                    onClick={() => {
                      setShell((shellDraft ?? "").trim());
                      setShellDraft(null);
                      setShellOpen(false);
                    }}
                  >
                    <span className="lsh-combo-opt-main">
                      <span className="lsh-combo-opt-label">
                        使用 “{(shellDraft ?? "").trim()}”
                      </span>
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>
          <p className="lsh-combo-hint">
            {matchedShell
              ? `启动 ${matchedShell.command}`
              : "留空则使用设置 → 终端中配置的默认本地 Shell。"}
          </p>
        </label>

        <label>
          分组
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">选择分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
            {groupId && !groups.some((g) => g.id === groupId) && (
              <option value={groupId}>{groupId}</option>
            )}
          </select>
        </label>

        <label>
          启动目录
          <div className="lsh-startdir">
            <input
              value={startDir}
              placeholder="继承全局起始目录（未设置时为主目录）"
              onChange={(e) => setStartDir(e.target.value)}
            />
            {startDir !== "" && (
              <button
                type="button"
                className="nc-icon-btn"
                title="重置"
                onClick={() => setStartDir("")}
              >
                <Icon name="x" size={13} />
              </button>
            )}
          </div>
        </label>

        <div className="lsh-auto-log">
          <span id="lsh-auto-log-label">自动记录会话日志</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoLog}
            aria-labelledby="lsh-auto-log-label"
            className={`host-switch${autoLog ? " on" : ""}`}
            onClick={() => setAutoLog((v) => !v)}
          >
            <span className="host-switch-knob" />
          </button>
        </div>
        <p className="lsh-combo-hint">
          开启后，本终端每次建立会话都会自动写入一份可打印纯文本 .log。保存目录与命名规则在「设置 → 终端 → 会话日志」中配置；重名自动加序号，不会覆盖已有文件。默认关闭。
        </p>
      </div>

      <footer className="vault-composer-foot">
        <button
          className="vault-secondary-btn"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        {!initial && (
          <button
            className="vault-new-btn"
            disabled={busy}
            onClick={() => void save(true)}
          >
            <Icon name="terminal" size={14} />
            保存并打开
          </button>
        )}
        <button
          className="vault-new-btn"
          disabled={busy}
          onClick={() => void save(false)}
        >
          <Icon name="save" size={14} />
          保存
        </button>
      </footer>
    </aside>
  );
}
