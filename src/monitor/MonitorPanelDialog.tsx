/**
 * 监控面板编辑弹窗（#206）：名称 / 主机勾选 / 布局 / 列数 / 刷新间隔 / 排序。
 * 默认面板「全部 SSH 主机」由前端派生，不可编辑或删除。
 */

import { useState } from "react";
import type { MonitorPanel, Profile } from "../backend/client";
import { Icon } from "../ui/icons";
import { MAX_MONITOR_COLUMNS, MONITOR_INTERVALS, normalizePanelDraft } from "./monitorPanelsModel";

export function MonitorPanelDialog({
  initial,
  canDelete,
  sshProfiles,
  saving,
  error,
  onSave,
  onDelete,
  onClose,
}: {
  initial: MonitorPanel;
  canDelete: boolean;
  sshProfiles: Profile[];
  saving: boolean;
  error: string | null;
  onSave: (panel: MonitorPanel) => void;
  onDelete: (panel: MonitorPanel) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<MonitorPanel>(initial);
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const patch = (value: Partial<MonitorPanel>) =>
    setDraft((previous) => ({ ...previous, ...value }));

  function toggleHost(id: string) {
    patch({
      host_ids: draft.host_ids.includes(id)
        ? draft.host_ids.filter((item) => item !== id)
        : [...draft.host_ids, id],
    });
  }

  function submit() {
    const normalized = normalizePanelDraft(draft, new Set(sshProfiles.map((p) => p.id)));
    if (!normalized.name) {
      setLocalError("请填写面板名称");
      return;
    }
    if (normalized.host_ids.length === 0) {
      setLocalError("至少选择一台 SSH 主机");
      return;
    }
    setLocalError(null);
    onSave(normalized);
  }

  return (
    <div className="monitor-panel-overlay" onClick={onClose}>
      <div
        className="monitor-panel-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={canDelete ? "编辑监控面板" : "新建监控面板"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="monitor-panel-dialog-head">
          <div className="monitor-panel-dialog-title">
            {canDelete ? "编辑监控面板" : "新建监控面板"}
          </div>
          <button type="button" className="monitor-panel-dialog-close" title="关闭" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="monitor-panel-dialog-body">
          <label className="monitor-panel-field">
            <span>名称</span>
            <input
              autoFocus
              value={draft.name}
              maxLength={120}
              placeholder="例如：生产集群"
              onChange={(event) => patch({ name: event.target.value })}
            />
          </label>

          <div className="monitor-panel-field">
            <span>主机（{draft.host_ids.length} 台）</span>
            {sshProfiles.length === 0 ? (
              <p className="monitor-panel-hint">还没有可选的 SSH 主机。</p>
            ) : (
              <div className="monitor-panel-hosts">
                {sshProfiles.map((profile) => (
                  <label key={profile.id} className="monitor-panel-host-row">
                    <input
                      type="checkbox"
                      checked={draft.host_ids.includes(profile.id)}
                      onChange={() => toggleHost(profile.id)}
                    />
                    <span className="monitor-panel-host-name">{profile.name}</span>
                    <span className="monitor-panel-host-addr">
                      {profile.host}:{profile.port}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="monitor-panel-field-row">
            <label className="monitor-panel-field">
              <span>默认布局</span>
              <select
                value={draft.layout}
                onChange={(event) => patch({ layout: event.target.value as MonitorPanel["layout"] })}
              >
                <option value="charts">图表</option>
                <option value="list">列表</option>
              </select>
            </label>
            <label className="monitor-panel-field">
              <span>列数</span>
              <select
                value={draft.columns}
                onChange={(event) => patch({ columns: Number(event.target.value) })}
              >
                <option value={0}>自动</option>
                {Array.from({ length: MAX_MONITOR_COLUMNS }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {value} 列
                  </option>
                ))}
              </select>
            </label>
            <label className="monitor-panel-field">
              <span>刷新间隔</span>
              <select
                value={draft.interval}
                onChange={(event) => patch({ interval: Number(event.target.value) })}
              >
                {MONITOR_INTERVALS.map((value) => (
                  <option key={value} value={value}>
                    每 {value} 秒
                  </option>
                ))}
              </select>
            </label>
            <label className="monitor-panel-field">
              <span>排序</span>
              <input
                type="number"
                min={0}
                value={draft.sort_order}
                onChange={(event) => patch({ sort_order: Number(event.target.value) })}
              />
            </label>
          </div>

          {(localError || error) && (
            <p role="alert" className="monitor-panel-error">
              {localError ?? error}
            </p>
          )}
        </div>

        <div className="monitor-panel-dialog-foot">
          {canDelete ? (
            <button
              type="button"
              className={`monitor-panel-btn is-danger${confirmDelete ? " is-confirming" : ""}`}
              disabled={saving}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                onDelete(draft);
              }}
            >
              <Icon name="trash" size={13} />
              {confirmDelete ? "确认删除" : "删除面板"}
            </button>
          ) : (
            <span />
          )}
          <div className="monitor-panel-dialog-actions">
            <button type="button" className="monitor-panel-btn" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button
              type="button"
              className="monitor-panel-btn is-primary"
              onClick={submit}
              disabled={saving}
            >
              <Icon name="save" size={13} />
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
