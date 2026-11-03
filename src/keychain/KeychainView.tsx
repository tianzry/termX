// 钥匙串：~/.ssh 系统密钥管理（阶段 A）。
// 列表（名称/类型/指纹/路径/默认）+ 生成 + 导入 + 设为默认 + 复制公钥 + 删除。
// 私钥内容不进前端：后端只回元数据与公钥行（commands/keychain.rs 文件段）。
import { useCallback, useEffect, useState } from "react";
import * as api from "../backend/client";
import type { SshFileKeyEntry } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import {
  SSH_KEY_ALGORITHMS,
  type SshKeyAlgorithm,
  RSA_BIT_OPTIONS,
  ECDSA_CURVE_OPTIONS,
  isValidSshKeyName,
  keyTypeLabel,
  defaultKeyName,
} from "../domain/keychainModel";
import "./keychain.css";

type DialogState =
  | { mode: "generate"; name: string; algorithm: SshKeyAlgorithm; bits: number; passphrase: string }
  | { mode: "import"; name: string; privateKey: string; publicKey: string }
  | null;

export function KeychainView() {
  const [entries, setEntries] = useState<SshFileKeyEntry[]>([]);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);

  const refresh = useCallback(async () => {
    try {
      setErr("");
      setEntries(await api.keychainListFileKeys());
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(""), 2500);
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setErr("");
    try {
      await action();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  const submitDialog = () => {
    if (!dialog) return;
    const name = dialog.name.trim();
    if (!isValidSshKeyName(name)) {
      setErr("密钥名只能是单层文件名（不能含路径分隔符或 ..）");
      return;
    }
    if (dialog.mode === "generate") {
      const bits = dialog.algorithm === "ED25519" ? null : dialog.bits;
      void run(async () => {
        await api.keychainGenerateFileKey(name, dialog.algorithm, bits, dialog.passphrase || null);
        setDialog(null);
        await refresh();
        flash("密钥已生成并写入 ~/.ssh");
      });
    } else {
      if (!dialog.privateKey.trim()) {
        setErr("请粘贴私钥内容");
        return;
      }
      void run(async () => {
        await api.keychainImportFileKey(name, dialog.privateKey, dialog.publicKey || null);
        setDialog(null);
        await refresh();
        flash("密钥已导入");
      });
    }
  };

  const copyPublic = async (e: SshFileKeyEntry) => {
    if (!e.public_key) return;
    try {
      await navigator.clipboard.writeText(e.public_key);
      flash(`已复制 ${e.name} 的公钥`);
    } catch {
      setErr("复制失败：剪贴板不可用");
    }
  };

  const remove = (e: SshFileKeyEntry) => {
    if (!window.confirm(`删除密钥 ${e.name}？将移除 ~/.ssh/${e.name} 与同名 .pub，不可恢复。`)) return;
    void run(async () => {
      await api.keychainDeleteFileKey(e.name);
      await refresh();
    });
  };

  const setDefault = (e: SshFileKeyEntry) =>
    void run(async () => {
      await api.keychainSetDefaultKey(e.name);
      await refresh();
      flash(`已将 ${e.name} 设为默认密钥`);
    });

  return (
    <div className="kc-file-pane">
      <div className="kc-file-toolbar">
        <div className="kc-file-title">
          系统密钥<span className="kc-file-sub">~/.ssh</span>
        </div>
        <div className="kc-file-actions">
          <button
            disabled={busy}
            onClick={() =>
              setDialog({
                mode: "generate",
                // 不预填缺省名：本机已存在同名密钥时预填会让「生成并保存」直接撞
                // key_file_exists；留空由 placeholder 引导，算法切换时仍跟随缺省名。
                name: "",
                algorithm: "ED25519",
                bits: 4096,
                passphrase: "",
              })
            }
          >
            生成密钥
          </button>
          <button
            disabled={busy}
            onClick={() => setDialog({ mode: "import", name: "", privateKey: "", publicKey: "" })}
          >
            导入密钥
          </button>
          <button disabled={busy} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </div>

      {err && <div className="kc-file-err">{err}</div>}
      {notice && <div className="kc-file-notice">{notice}</div>}

      {entries.length === 0 ? (
        <div className="kc-file-empty">未发现私钥。可生成新密钥或导入已有密钥。</div>
      ) : (
        <div className="kc-file-list">
          {entries.map((e) => (
            <div key={e.name} className="kc-file-row">
              <div className="kc-file-main">
                <span className="kc-file-name">
                  {e.name}
                  {e.is_default && <span className="kc-file-badge">默认</span>}
                  {e.encrypted && <span className="kc-file-badge kc-file-badge-dim">加密</span>}
                </span>
                <span className="kc-file-meta">
                  {keyTypeLabel(e.key_type)} · {e.fingerprint || "指纹不可得"} · {e.path}
                </span>
              </div>
              <div className="kc-file-row-actions">
                {!e.is_default && (
                  <button disabled={busy} onClick={() => setDefault(e)}>
                    设为默认
                  </button>
                )}
                <button disabled={busy || !e.public_key} onClick={() => void copyPublic(e)}>
                  复制公钥
                </button>
                <button disabled={busy} className="kc-file-danger" onClick={() => remove(e)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {dialog && (
        <div className="kc-file-dialog-backdrop">
          <div className="kc-file-dialog">
            <h3>{dialog.mode === "generate" ? "生成密钥" : "导入密钥"}</h3>
            <label>
              密钥名
              <input
                value={dialog.name}
                onChange={(ev) => setDialog({ ...dialog, name: ev.target.value })}
                placeholder="如 id_ed25519"
              />
            </label>
            {dialog.mode === "generate" ? (
              <>
                <label>
                  算法
                  <select
                    value={dialog.algorithm}
                    onChange={(ev) => {
                      const algorithm = ev.target.value as SshKeyAlgorithm;
                      setDialog({
                        ...dialog,
                        algorithm,
                        // 名称未改过时跟随算法切换缺省名。
                        name:
                          dialog.name === defaultKeyName(dialog.algorithm)
                            ? defaultKeyName(algorithm)
                            : dialog.name,
                        bits: algorithm === "ECDSA" ? 256 : 4096,
                      });
                    }}
                  >
                    {SSH_KEY_ALGORITHMS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
                {dialog.algorithm === "RSA" && (
                  <label>
                    位宽
                    <select
                      value={dialog.bits}
                      onChange={(ev) => setDialog({ ...dialog, bits: Number(ev.target.value) })}
                    >
                      {RSA_BIT_OPTIONS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {dialog.algorithm === "ECDSA" && (
                  <label>
                    曲线
                    <select
                      value={dialog.bits}
                      onChange={(ev) => setDialog({ ...dialog, bits: Number(ev.target.value) })}
                    >
                      {ECDSA_CURVE_OPTIONS.map((c) => (
                        <option key={c} value={c}>
                          P-{c}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Passphrase（可选，建议设置）
                  <input
                    type="password"
                    value={dialog.passphrase}
                    onChange={(ev) => setDialog({ ...dialog, passphrase: ev.target.value })}
                  />
                </label>
                <div className="kc-file-hint">
                  将写入 ~/.ssh/{dialog.name.trim() || "<名称>"} 与同名 .pub；同名文件已存在时拒绝覆盖。
                </div>
              </>
            ) : (
              <>
                <label>
                  私钥内容
                  <textarea
                    rows={6}
                    value={dialog.privateKey}
                    onChange={(ev) => setDialog({ ...dialog, privateKey: ev.target.value })}
                    placeholder="openssh-key-v1… 或 -----BEGIN … PRIVATE KEY-----"
                  />
                </label>
                <label>
                  公钥（可选；加密私钥可借此补齐类型/指纹）
                  <textarea
                    rows={2}
                    value={dialog.publicKey}
                    onChange={(ev) => setDialog({ ...dialog, publicKey: ev.target.value })}
                    placeholder="ssh-ed25519 AAAA…"
                  />
                </label>
              </>
            )}
            <div className="kc-file-dialog-actions">
              <button
                onClick={() => {
                  setDialog(null);
                  setErr("");
                }}
              >
                取消
              </button>
              <button disabled={busy} onClick={submitDialog}>
                {dialog.mode === "generate" ? "生成并保存" : "导入"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
