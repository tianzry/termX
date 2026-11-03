/**
 * 内置编辑器（P0 #8）：全屏遮罩 + 低依赖 textarea 方案
 * （Netcatty 用 Monaco；阶段 A 按约定先不做语法高亮全覆盖）。
 *
 * 行为对齐 Netcatty TextEditorPane / UnsavedChangesDialog 的 termX 子集：
 * - 加载：远端 `sftpReadFile`（后端 10 MiB 预检）；本地先 `localStat`
 *   尺寸断言再 `localReadFile`（≤10 MiB 时必然全文）。
 * - 二进制：入口按扩展名过滤（调用方），字节采样 NUL 兜底（本组件）。
 * - 编码：BOM 探测 + UTF-8 严格解码 + gb18030 回退（editorFile.decodeText）；
 *   保存统一 UTF-8。
 * - 保存：Ctrl+S 或按钮；远端 `sftpWriteFile` / 本地 `localWriteFile`。
 * - 另存：输入目标路径（默认当前路径），写入后切换编辑目标。
 * - 关闭：有未保存改动弹三按钮确认（保存并关闭 / 不保存 / 取消）。
 *
 * 阶段 B：外部修改监视（对齐 Netcatty startFileWatch 语义的 termX 子集）：
 * - 本地：轮询 `localStat`；远端：定时 `sftpStat`（mtime/size 比对）。
 * - 基准快照：加载成功与每次保存/另存成功后刷新；写入进行中抑制比对，
 *   避免自身写入回环误判。
 * - 检出外部修改 → 弹「文件已在磁盘/远端被修改，是否重新加载」对话框：
 *   重新加载（重读文件）/ 忽略（以当前 stat 为新基准继续编辑）。
 * - 轮询定时器随目标/状态变化重建、卸载即清理，无句柄泄漏。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { SftpPromptDialog } from "../sftp/SftpPaneDialogs";
import {
  assertEditorSize,
  decodeText,
  encodeText,
  looksBinary,
  statChanged,
  type EditorStat,
} from "./editorFile";

export interface EditorTarget {
  kind: "local" | "remote";
  /** 远端必填。 */
  sftpId?: string;
  /** 完整路径（远端为 POSIX，本地为平台路径）。 */
  path: string;
  name: string;
}

interface Props {
  target: EditorTarget;
  onClose: () => void;
}

/** 外部修改轮询间隔：本地 stat 便宜取 1.5s；远端每次走 SFTP 请求，放宽到 3s。 */
const WATCH_INTERVAL_LOCAL_MS = 1500;
const WATCH_INTERVAL_REMOTE_MS = 3000;

export function SftpEditorDialog({ target: initialTarget, onClose }: Props) {
  const [target, setTarget] = useState(initialTarget);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveAs, setSaveAs] = useState(false);
  const [saveAsBusy, setSaveAsBusy] = useState(false);
  const [saveAsError, setSaveAsError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  /** 检出外部修改，等待用户选择「重新加载 / 忽略」。 */
  const [externalChange, setExternalChange] = useState(false);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const textRef = useRef(text);
  textRef.current = text;
  const targetRef = useRef(target);
  targetRef.current = target;
  /** 监视基准快照（加载 / 保存成功后刷新）；null = 尚未建立。 */
  const baselineRef = useRef<EditorStat | null>(null);
  /** 自身写入期间抑制比对（保存回环防护）。 */
  const writingRef = useRef(false);

  /** 取当前目标的 stat 快照；失败（会话已关闭等）返回 null，不打断编辑。 */
  const statOf = useCallback(
    async (t: EditorTarget): Promise<EditorStat | null> => {
      try {
        if (t.kind === "remote") {
          if (!t.sftpId) return null;
          const st = await api.sftpStat(t.sftpId, t.path);
          return { mtime: st.mtime, size: st.size };
        }
        const st = await api.localStat(t.path);
        return { mtime: st.mtime, size: st.size };
      } catch {
        return null;
      }
    },
    [],
  );

  const load = useCallback(
    async (t: EditorTarget) => {
      setLoading(true);
      setError("");
      try {
        let bytes: Uint8Array;
        if (t.kind === "remote") {
          if (!t.sftpId) throw new Error("SFTP 会话不存在。");
          bytes = Uint8Array.from(await api.sftpReadFile(t.sftpId, t.path));
        } else {
          const st = await api.localStat(t.path);
          assertEditorSize(st.size);
          bytes = Uint8Array.from(await api.localReadFile(t.path));
        }
        if (looksBinary(bytes)) {
          throw new Error("该文件似乎是二进制文件，无法在内置编辑器中编辑。");
        }
        setText(decodeText(bytes));
        setDirty(false);
        // 加载成功即建立监视基准。
        baselineRef.current = await statOf(t);
      } catch (e) {
        setError(userVisibleError(String(e)));
      } finally {
        setLoading(false);
      }
    },
    [statOf],
  );

  useEffect(() => {
    void load(initialTarget);
    // 仅挂载时加载；切换目标经 setTarget + 显式 load（另存不换文件内容）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const writeContent = useCallback(async (t: EditorTarget, content: string) => {
    const data = encodeText(content);
    if (t.kind === "remote") {
      if (!t.sftpId) throw new Error("SFTP 会话不存在。");
      await api.sftpWriteFile(t.sftpId, t.path, data);
    } else {
      await api.localWriteFile(t.path, data);
    }
  }, []);

  const save = useCallback(async () => {
    if (saving || loading || error) return;
    setSaving(true);
    setError("");
    writingRef.current = true;
    try {
      await writeContent(targetRef.current, textRef.current);
      // 保存成功后立即以新 stat 为基准，防止自身写入被监视误判为外部修改。
      baselineRef.current = await statOf(targetRef.current);
      setDirty(false);
    } catch (e) {
      setError(userVisibleError(String(e)));
    } finally {
      writingRef.current = false;
      setSaving(false);
    }
  }, [saving, loading, error, writeContent, statOf]);

  const runSaveAs = async (newPath: string) => {
    setSaveAsBusy(true);
    setSaveAsError("");
    writingRef.current = true;
    try {
      const name = newPath.replace(/\\/g, "/").split("/").pop() || newPath;
      const next: EditorTarget = { ...targetRef.current, path: newPath, name };
      await writeContent(next, textRef.current);
      setTarget(next);
      setDirty(false);
      baselineRef.current = await statOf(next);
      setSaveAs(false);
    } catch (e) {
      setSaveAsError(userVisibleError(String(e)));
    } finally {
      writingRef.current = false;
      setSaveAsBusy(false);
    }
  };

  // ── 外部修改监视（本地轮询 / 远端定时 stat 比对） ──────────
  // 对话框打开（externalChange）或加载中不轮询；目标变化（另存）自动重建。
  useEffect(() => {
    if (loading || error || externalChange) return;
    const timer = setInterval(async () => {
      if (writingRef.current) return;
      const cur = await statOf(targetRef.current);
      const base = baselineRef.current;
      if (cur && base && statChanged(base, cur)) {
        setExternalChange(true);
      }
    }, target.kind === "remote" ? WATCH_INTERVAL_REMOTE_MS : WATCH_INTERVAL_LOCAL_MS);
    return () => clearInterval(timer);
  }, [target, loading, error, externalChange, statOf]);

  /** 重新加载：重读文件（基准随 load 刷新）；未保存改动将被覆盖。 */
  const reloadNow = async () => {
    setExternalChange(false);
    await load(targetRef.current);
  };

  /** 忽略：以磁盘/远端当前 stat 为新基准，保留编辑器内容继续编辑。 */
  const ignoreChange = async () => {
    baselineRef.current = await statOf(targetRef.current);
    setExternalChange(false);
  };

  const requestClose = () => {
    if (dirtyRef.current) {
      setConfirmClose(true);
    } else {
      onClose();
    }
  };

  const discardAndClose = async () => {
    setConfirmClose(false);
    onClose();
  };

  const saveAndClose = async () => {
    setConfirmClose(false);
    await save();
    // save 失败会重设 error；仅成功（不再 dirty）时关闭。
    if (!dirtyRef.current) onClose();
  };

  return (
    <div className="nc-editor-backdrop">
      <div className="nc-editor">
        <div className="nc-editor-header">
          <span className="nc-editor-name" title={target.path}>
            {target.name}
            {dirty && <span className="nc-editor-dirty">●</span>}
          </span>
          <span className="nc-editor-path">{target.path}</span>
          <div className="nc-editor-actions">
            <button
              className="primary"
              disabled={saving || loading || !!error}
              onClick={() => void save()}
            >
              {saving ? "保存中..." : "保存"}
            </button>
            <button
              disabled={saving || loading || !!error}
              onClick={() => {
                setSaveAsError("");
                setSaveAs(true);
              }}
            >
              另存为
            </button>
            <button disabled={saving} onClick={requestClose}>
              关闭
            </button>
          </div>
        </div>
        {error && <div className="nc-editor-error">{error}</div>}
        {loading ? (
          <div className="nc-editor-hint">加载中...</div>
        ) : (
          <textarea
            className="nc-editor-textarea"
            value={text}
            spellCheck={false}
            disabled={!!error}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void save();
              }
            }}
          />
        )}
      </div>

      {saveAs && (
        <SftpPromptDialog
          title={`另存为 ${target.name}`}
          initial={target.path}
          confirmLabel="保存"
          busy={saveAsBusy}
          error={saveAsError}
          onClose={() => setSaveAs(false)}
          onSubmit={(v) => void runSaveAs(v)}
        />
      )}

      {confirmClose && (
        <div className="nc-sftp-dialog-backdrop">
          <div className="nc-sftp-dialog">
            <h3>有未保存的更改</h3>
            <p className="nc-editor-unsaved-text">
              “{target.name}”尚未保存，是否在关闭前保存？
            </p>
            <div className="nc-sftp-dialog-actions">
              <button onClick={() => setConfirmClose(false)}>取消</button>
              <button onClick={() => void discardAndClose()}>不保存</button>
              <button className="primary" onClick={() => void saveAndClose()}>
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {externalChange && (
        <div className="nc-sftp-dialog-backdrop">
          <div className="nc-sftp-dialog">
            <h3>文件已被外部修改</h3>
            <p className="nc-editor-unsaved-text">
              “{target.name}”已在{target.kind === "remote" ? "远端" : "磁盘"}
              被修改，是否重新加载？
              {dirty && "（重新加载将丢失未保存的更改）"}
            </p>
            <div className="nc-sftp-dialog-actions">
              <button onClick={() => void ignoreChange()}>忽略</button>
              <button className="primary" onClick={() => void reloadNow()}>
                重新加载
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
