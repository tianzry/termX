/**
 * SFTP 双栏主视图（对齐 Netcatty SftpView 的可见结构子集）：
 * 左右 50/50 两栏，各含会话标签栏 + 面板；聚焦栏左上角蓝色三角，
 * 点击栏 = 聚焦（并清掉对侧选择——选择模型在实现③引入）；空栏显示空态；
 * 「+」或空态按钮打开主机选择器；连接流三分支：本地 / 复用已有 SSH 会话 /
 * 独立连接（保存主机 + 凭据）。标签拖拽重排 / 放大单栏等后续阶段补齐。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../backend/client";
import type { Credential, Profile } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { newId } from "../workspaceModel";
import { SftpHostPicker } from "./SftpHostPicker";
import { SftpPaneEmptyState } from "./SftpPaneEmptyState";
import { SftpPaneView } from "./SftpPaneView";
import { SftpQueuePanel } from "./SftpQueuePanel";
import { SftpTabBar } from "./SftpTabBar";
import {
  buildDropTransferTasks,
  buildPickerSections,
  connectBranch,
  detectLocalOs,
  osFromUname,
  pickerItemToTarget,
  planSftpOpenFromHost,
  type ConnectedHostEntry,
  type HostOs,
  type PaneConnection,
  type PickerItem,
  type SftpConnectTarget,
  type SftpDragPayload,
  type SftpOpenRequest,
  type SftpPaneTab,
  type SftpSide,
} from "./sftpModel";

interface SideState {
  tabs: SftpPaneTab[];
  activeTabId: string | null;
}

const EMPTY_SIDE: SideState = { tabs: [], activeTabId: null };

interface Props {
  profiles: Profile[];
  credentials: Credential[];
  /** 当前可复用建 SFTP 的已连接 SSH 会话。 */
  connectedHosts: ConnectedHostEntry[];
  /** 外部「打开 SFTP」请求（主机右键 / 工具栏）；seq 变化即执行一次定位。 */
  openRequest?: SftpOpenRequest | null;
}

export function SftpView({
  profiles,
  credentials,
  connectedHosts,
  openRequest = null,
}: Props) {
  const [sides, setSides] = useState<Record<SftpSide, SideState>>({
    left: EMPTY_SIDE,
    right: EMPTY_SIDE,
  });
  const [focusedSide, setFocusedSide] = useState<SftpSide>("left");
  const [pickerSide, setPickerSide] = useState<SftpSide | null>(null);
  const [pickerTerm, setPickerTerm] = useState("");
  const [busySide, setBusySide] = useState<SftpSide | null>(null);
  /** 对侧传输完成后递增，触发对应面板重新加载。 */
  const [refreshKeys, setRefreshKeys] = useState<Record<SftpSide, number>>({
    left: 0,
    right: 0,
  });
  const [errors, setErrors] = useState<Record<SftpSide, string>>({
    left: "",
    right: "",
  });
  /** 已处理过的外部请求序号（同一请求不重复执行）。 */
  const handledOpenSeqRef = useRef(0);

  const setSide = useCallback(
    (side: SftpSide, updater: (prev: SideState) => SideState) => {
      setSides((prev) => ({ ...prev, [side]: updater(prev[side]) }));
    },
    [],
  );

  // ── 连接流 ─────────────────────────────────────────────

  const addTab = useCallback(
    (side: SftpSide, connection: PaneConnection) => {
      const tab: SftpPaneTab = { id: newId(), connection };
      setSide(side, (prev) => ({
        tabs: [...prev.tabs, tab],
        activeTabId: tab.id,
      }));
    },
    [setSide],
  );

  /** 远端 OS 探测结果回写对应标签（按 sftpId 匹配）。 */
  const updateTabOs = useCallback(
    (side: SftpSide, sftpId: string, os: HostOs) => {
      setSide(side, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.connection.kind === "remote" && t.connection.sftpId === sftpId
            ? { ...t, connection: { ...t.connection, os } }
            : t,
        ),
      }));
    },
    [setSide],
  );

  /**
   * 远端起始目录（对照 Netcatty `resolveSftpInitialPath`）：
   * 优先终端 cwd（只接受绝对 POSIX 路径），不可达时回退远端 home。
   */
  async function resolveRemoteStartPath(
    sftpId: string,
    initialPath?: string | null,
  ): Promise<string> {
    const home = await api.sftpHome(sftpId);
    if (!initialPath || !initialPath.startsWith("/")) return home;
    try {
      await api.sftpList(sftpId, initialPath);
      return initialPath;
    } catch {
      return home;
    }
  }

  const connectTarget = useCallback(
    async (side: SftpSide, target: SftpConnectTarget, initialPath?: string | null) => {
      setBusySide(side);
      setErrors((prev) => ({ ...prev, [side]: "" }));
      try {
        if (connectBranch(target) === "local") {
          const home = await api.localHome();
          addTab(side, {
            kind: "local",
            label: "本地",
            path: home,
            os: detectLocalOs(),
          });
          return;
        }
        if (target.kind === "session") {
          const entry = target.entry;
          const sftpId = await api.sftpConnectSession(entry.sessionId);
          try {
            const startPath = await resolveRemoteStartPath(sftpId, initialPath);
            addTab(side, {
              kind: "remote",
              sftpId,
              canExec: true,
              label: entry.label,
              meta: entry.meta,
              path: startPath,
              os: entry.os ?? "unknown",
              hostId: entry.profileId,
              sessionId: entry.sessionId,
            });
            // best-effort 远端 OS 探测：复用会话上跑 uname -s，不阻塞连接流；
            // 失败 / 无 uname 保持 unknown（标签回落服务器图标）。
            void api
              .sshExec(entry.sessionId, "uname -s", 3000)
              .then((r) => {
                if (r.exit_code !== 0) return;
                const os = osFromUname(r.stdout);
                if (os !== "unknown") updateTabOs(side, sftpId, os);
              })
              .catch(() => {});
          } catch (e) {
            await api.sftpClose(sftpId).catch(() => {});
            throw e;
          }
          return;
        }
        // 独立连接：保存主机 + 凭据（local 已在上面返回，此处收窄为 profile）
        if (target.kind !== "profile") return;
        const profile = target.profile;
        const listed = credentials.find(
          (c) => c.id === profile.credential_id,
        );
        if (!listed) {
          throw new Error("该主机未配置凭据，无法独立连接");
        }
        // list_credentials 不返回 secret（见 client.ts 注释），独立连接必须取全量凭据
        const credential = await api.getCredential(listed.id);
        const sftpId = await api.sftpConnect(
          profile.host,
          profile.port,
          credential.username,
          credential.type,
          credential.secret,
          profile.id,
        );
        try {
          const startPath = await resolveRemoteStartPath(sftpId, initialPath);
          addTab(side, {
            kind: "remote",
            sftpId,
            canExec: false,
            label: profile.name,
            meta: `${credential.username}@${profile.host}`,
            path: startPath,
            os: "unknown",
            hostId: profile.id,
          });
        } catch (e) {
          await api.sftpClose(sftpId).catch(() => {});
          throw e;
        }
      } catch (e) {
        setErrors((prev) => ({ ...prev, [side]: userVisibleError(String(e)) }));
      } finally {
        setBusySide(null);
      }
    },
    [addTab, credentials, updateTabOs],
  );

  // ── 标签操作 ───────────────────────────────────────────

  const closeTab = useCallback(
    (side: SftpSide, tabId: string) => {
      const tab = sides[side].tabs.find((t) => t.id === tabId);
      if (tab?.connection.kind === "remote") {
        api.sftpClose(tab.connection.sftpId).catch(() => {});
      }
      setSide(side, (prev) => {
        const tabs = prev.tabs.filter((t) => t.id !== tabId);
        const activeTabId =
          prev.activeTabId === tabId
            ? (tabs[tabs.length - 1]?.id ?? null)
            : prev.activeTabId;
        return { tabs, activeTabId };
      });
    },
    [setSide, sides],
  );

  const updateTabPath = useCallback(
    (side: SftpSide, tabId: string, path: string) => {
      setSide(side, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id === tabId
            ? { ...t, connection: { ...t.connection, path } }
            : t,
        ),
      }));
    },
    [setSide],
  );

  // ── 双击「传输到另一侧」（对照 Netcatty startTransfer 到对侧活动面板）──

  const transferSubs = useRef(new Map<string, () => void>());

  const transferToOtherSide = useCallback(
    (fromSide: SftpSide, payload: SftpDragPayload): boolean => {
      const other: SftpSide = fromSide === "left" ? "right" : "left";
      const { tabs, activeTabId } = sides[other];
      const tab = tabs.find((t) => t.id === activeTabId);
      if (!tab) return false;
      const tasks = buildDropTransferTasks({
        payload,
        destKind: tab.connection.kind,
        destSftpId:
          tab.connection.kind === "remote" ? tab.connection.sftpId : undefined,
        targetDir: tab.connection.path,
      });
      if (!tasks || tasks.length === 0) return false;
      void api
        .sftpTransferEnqueue(tasks)
        .then((created) => {
          for (const item of created) {
            void api
              .onSftpTransferUpdated(item.id, (it) => {
                if (it.status !== "completed" && it.status !== "skipped") return;
                transferSubs.current.get(item.id)?.();
                transferSubs.current.delete(item.id);
                setRefreshKeys((prev) => ({
                  ...prev,
                  [other]: prev[other] + 1,
                }));
              })
              .then((u) => transferSubs.current.set(item.id, u));
          }
        })
        .catch(() => {});
      return true;
    },
    [sides],
  );

  // 卸载时回收双击传输的订阅。
  useEffect(() => {
    const subs = transferSubs.current;
    return () => {
      for (const u of subs.values()) u();
      subs.clear();
    };
  }, []);

  // ── 主机选择器 ─────────────────────────────────────────

  const openPicker = useCallback((side: SftpSide) => {
    setFocusedSide(side);
    setPickerTerm("");
    setPickerSide(side);
  }, []);

  const handlePick = useCallback(
    (item: PickerItem) => {
      const side = pickerSide;
      setPickerSide(null);
      if (!side) return;
      void connectTarget(side, pickerItemToTarget(item));
    },
    [connectTarget, pickerSide],
  );

  const pickerSections = buildPickerSections({
    term: pickerTerm,
    connected: connectedHosts,
    profiles,
  });

  // ── 卸载时关闭所有远端 SFTP 会话 ──────────────────────

  const sidesRef = useRef(sides);
  sidesRef.current = sides;

  // ── 外部「打开 SFTP」请求：左本地 + 右主机，重复点击聚焦已有标签 ──
  useEffect(() => {
    if (!openRequest || openRequest.seq <= handledOpenSeqRef.current) return;
    handledOpenSeqRef.current = openRequest.seq;
    const plan = planSftpOpenFromHost({
      leftTabs: sidesRef.current.left.tabs,
      rightTabs: sidesRef.current.right.tabs,
      hostId: openRequest.hostId,
    });
    setFocusedSide("right");

    if (plan.leftTabId) {
      setSide("left", (prev) => ({ ...prev, activeTabId: plan.leftTabId }));
    } else if (plan.connectLeft) {
      void connectTarget("left", { kind: "local" });
    }

    if (plan.rightTabId) {
      setSide("right", (prev) => ({ ...prev, activeTabId: plan.rightTabId }));
      setErrors((prev) => ({ ...prev, right: "" }));
      return;
    }

    // 可复用已连接 SSH 会话时优先复用（与 Netcatty 工具栏一致），否则独立连接。
    const connected = openRequest.sessionId
      ? connectedHosts.find((e) => e.sessionId === openRequest.sessionId)
      : connectedHosts.find((e) => e.profileId === openRequest.hostId);
    const profile = profiles.find((p) => p.id === openRequest.hostId);
    const target: SftpConnectTarget | null = connected
      ? {
          kind: "session",
          entry: {
            ...connected,
            label: openRequest.label,
            meta: openRequest.meta,
            profileId: connected.profileId ?? openRequest.hostId,
          },
        }
      : profile
        ? { kind: "profile", profile }
        : null;
    if (!target) {
      setErrors((prev) => ({
        ...prev,
        right: "主机不存在或未配置凭据，无法打开 SFTP",
      }));
      return;
    }
    void connectTarget("right", target, openRequest.initialPath);
    // connectTarget / setSide 为稳定闭包；只按请求序号执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  useEffect(() => {
    return () => {
      for (const side of ["left", "right"] as const) {
        for (const tab of sidesRef.current[side].tabs) {
          if (tab.connection.kind === "remote") {
            api.sftpClose(tab.connection.sftpId).catch(() => {});
          }
        }
      }
    };
  }, []);

  // ── 渲染 ───────────────────────────────────────────────

  const renderSide = (side: SftpSide) => {
    const { tabs, activeTabId } = sides[side];
    const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
    return (
      <div
        className="nc-sftp-side"
        data-side={side}
        onClick={() => setFocusedSide(side)}
        onFocusCapture={() => setFocusedSide(side)}
      >
        {focusedSide === side && <div className="nc-sftp-focus-tri" />}
        {tabs.length > 0 && (
          <SftpTabBar
            side={side}
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={(tabId) =>
              setSide(side, (prev) => ({ ...prev, activeTabId: tabId }))
            }
            onClose={(tabId) => closeTab(side, tabId)}
            onAdd={() => openPicker(side)}
          />
        )}
        {tabs.length > 0 && errors[side] && (
          <div className="nc-sftp-side-error" role="alert">
            {errors[side]}
          </div>
        )}
        {tabs.length === 0 ? (
          <SftpPaneEmptyState
            side={side}
            busy={busySide === side}
            error={errors[side]}
            onSelectHost={() => openPicker(side)}
          />
        ) : (
          activeTab && (
            <SftpPaneView
              key={activeTab.id}
              connection={activeTab.connection}
              onPathChange={(path) => updateTabPath(side, activeTab.id, path)}
              onTransferFile={(payload) => transferToOtherSide(side, payload)}
              refreshKey={refreshKeys[side]}
            />
          )
        )}
      </div>
    );
  };

  return (
    <div className="nc-sftp-area">
      <section className="nc-sftp-view">
        {renderSide("left")}
        {renderSide("right")}
        <SftpHostPicker
          open={pickerSide !== null}
          side={pickerSide ?? focusedSide}
          term={pickerTerm}
          onTermChange={setPickerTerm}
          sections={pickerSections}
          onClose={() => setPickerSide(null)}
          onPick={handlePick}
        />
      </section>
      {/* 全局传输队列：上传/下载统一入队，进度只在此展示（阶段 B） */}
      <SftpQueuePanel />
    </div>
  );
}
