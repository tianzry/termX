/** 脚本自动触发日志（内存，最多 100 条；用于脚本页展示与实测取证）。 */

export type ScriptTriggerKind = "onConnect" | "onOutput";
export type ScriptTriggerStatus = "started" | "done" | "error";

export interface ScriptTriggerEntry {
  at: number;
  kind: ScriptTriggerKind;
  name: string;
  paneId: string;
  detail: string;
  status: ScriptTriggerStatus;
}

const MAX_ENTRIES = 100;
let entries: ScriptTriggerEntry[] = [];
const listeners = new Set<(list: ScriptTriggerEntry[]) => void>();

function emit() {
  listeners.forEach((cb) => cb([...entries]));
}

export function appendScriptTrigger(
  entry: Omit<ScriptTriggerEntry, "at"> & { at?: number },
): void {
  entries = [...entries, { ...entry, at: entry.at ?? Date.now() }].slice(-MAX_ENTRIES);
  emit();
}

export function listScriptTriggers(): ScriptTriggerEntry[] {
  return [...entries];
}

export function clearScriptTriggers(): void {
  entries = [];
  emit();
}

export function subscribeScriptTriggers(
  cb: (list: ScriptTriggerEntry[]) => void,
): () => void {
  listeners.add(cb);
  cb([...entries]);
  return () => listeners.delete(cb);
}
