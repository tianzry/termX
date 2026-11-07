import { beforeEach, describe, expect, it } from "vitest";
import type { ActiveForwardInfo, Forward } from "./backend/client";
import {
  FORWARD_RECONNECT_LIMIT,
  createForwardSupervisorState,
  currentForwardSupervisorState,
  noteForwardStarted,
  noteForwardStopped,
  planForwardTick,
  resetForwardSupervisorForTest,
  splitActiveForwards,
} from "./forwardSupervisor";

const activeInfo = (forward_id: string, connected: boolean): ActiveForwardInfo => ({
  active_id: `a-${forward_id}`,
  forward_id,
  stats: { bytes_tx: 0, bytes_rx: 0, connections: 0, connected, rules: [] },
});

const forward = (patch: Partial<Forward> = {}): Forward => ({
  id: "f1",
  name: "fw",
  profile_id: "p1",
  group_id: null,
  rules: [],
  auto_start: false,
  auto_reconnect: null,
  ...patch,
});

const active = (...ids: string[]) => new Set(ids);

beforeEach(() => resetForwardSupervisorForTest());

describe("planForwardTick", () => {
  it("auto_start 每个应用生命周期只拉起一次，手动停止后不再拉起", () => {
    const state = currentForwardSupervisorState();
    const first = planForwardTick([forward({ auto_start: true })], active(), state, new Set());
    expect(first).toEqual(["f1"]);

    noteForwardStopped("f1");
    const second = planForwardTick([forward({ auto_start: true })], active(), state, new Set());
    expect(second).toEqual([]);
  });

  it("运行中会清零重试计数", () => {
    const state = createForwardSupervisorState();
    state.desired.add("f1");
    state.attempts.set("f1", 3);
    planForwardTick([forward()], active("f1"), state, new Set());
    expect(state.attempts.has("f1")).toBe(false);
  });

  it("auto_reconnect 未设置时跟随 auto_start", () => {
    const state = createForwardSupervisorState();
    state.desired.add("f1");
    state.autoStartTried.add("f1");

    // auto_start 关、auto_reconnect 未设置 → 不重连
    expect(planForwardTick([forward()], active(), state, new Set())).toEqual([]);
    // auto_start 开、auto_reconnect 未设置 → 重连
    expect(
      planForwardTick([forward({ auto_start: true })], active(), state, new Set()),
    ).toEqual(["f1"]);
  });

  it("显式 auto_reconnect=false 覆盖 auto_start", () => {
    const state = createForwardSupervisorState();
    state.desired.add("f1");
    state.autoStartTried.add("f1");
    expect(
      planForwardTick(
        [forward({ auto_start: true, auto_reconnect: false })],
        active(),
        state,
        new Set(),
      ),
    ).toEqual([]);
  });

  it("手动启动且未开自动重连的条目不回拉；开了则回拉", () => {
    const state = currentForwardSupervisorState();
    noteForwardStarted("f1");
    expect(planForwardTick([forward()], active(), state, new Set())).toEqual([]);
    expect(
      planForwardTick([forward({ auto_reconnect: true })], active(), state, new Set()),
    ).toEqual(["f1"]);
  });

  it("达到重试上限后停止", () => {
    const state = currentForwardSupervisorState();
    noteForwardStarted("f1");
    const f = forward({ auto_reconnect: true });
    const runs = [];
    for (let i = 0; i < FORWARD_RECONNECT_LIMIT + 2; i += 1) {
      runs.push(planForwardTick([f], active(), state, new Set()).length);
    }
    expect(runs.filter((n) => n === 1)).toHaveLength(FORWARD_RECONNECT_LIMIT);
    expect(state.desired.has("f1")).toBe(true);
  });

  it("信道已断的僵尸会话不计入运行中，能触发重连", () => {
    const state = currentForwardSupervisorState();
    noteForwardStarted("f1");
    noteForwardStarted("f2");
    const { live, stale } = splitActiveForwards([
      activeInfo("f1", true),
      activeInfo("f2", false),
    ]);
    expect(live).toEqual(new Set(["f1"]));
    expect(stale).toEqual(["a-f2"]);

    // f2 断线后重连；f1 仍活着，不被重复拉起。
    expect(
      planForwardTick(
        [forward({ id: "f1", auto_reconnect: true }), forward({ id: "f2", auto_reconnect: true })],
        live,
        state,
        new Set(),
      ),
    ).toEqual(["f2"]);
  });

  it("启动进行中的条目不重复拉起", () => {
    const state = currentForwardSupervisorState();
    noteForwardStarted("f1");
    expect(planForwardTick([forward({ auto_reconnect: true })], active(), state, new Set(["f1"]))).toEqual(
      [],
    );
  });
});
