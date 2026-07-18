import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Typed event subscriptions for backend → frontend push events.
 * Payload shapes mirror the Rust structs in src-tauri/src/types.rs.
 */

export interface DataPayload {
  session_id: string;
  dir: "rx" | "tx";
  ts: number;
  text: string;
}

export type SessionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "lost";

export interface StatusPayload {
  session_id: string;
  state: SessionState;
  attempts?: number;
  max_attempts?: number;
  msg?: string;
}

export interface SignalPayload {
  session_id: string;
  cts: boolean;
  dsr: boolean;
  cd: boolean;
  ri: boolean;
}

export interface PortsChangedPayload {
  added: string[];
  removed: string[];
}

export function onData(
  sessionId: string,
  cb: (p: DataPayload) => void,
): Promise<UnlistenFn> {
  return listen<DataPayload>("serial:data", (e) => {
    if (e.payload.session_id === sessionId) cb(e.payload);
  });
}

export function onStatus(
  sessionId: string,
  cb: (p: StatusPayload) => void,
): Promise<UnlistenFn> {
  return listen<StatusPayload>("serial:status", (e) => {
    if (e.payload.session_id === sessionId) cb(e.payload);
  });
}

export function onSignal(
  sessionId: string,
  cb: (p: SignalPayload) => void,
): Promise<UnlistenFn> {
  return listen<SignalPayload>("serial:signal", (e) => {
    if (e.payload.session_id === sessionId) cb(e.payload);
  });
}

export function onPortsChanged(cb: (p: PortsChangedPayload) => void): Promise<UnlistenFn> {
  return listen<PortsChangedPayload>("serial:ports_changed", (e) => cb(e.payload));
}

export function onReconnected(sessionId: string, cb: () => void): Promise<UnlistenFn> {
  return listen<{ session_id: string }>("serial:reconnected", (e) => {
    if (e.payload.session_id === sessionId) cb();
  });
}
