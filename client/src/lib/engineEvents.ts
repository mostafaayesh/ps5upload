/**
 * SSE event stream consumer for shared engine state.
 *
 * Opens a persistent EventSource to GET /api/events and dispatches
 * typed events to registered callbacks. The engine broadcasts every
 * state change (job transitions, PS5 status, queue mutations) on a
 * single SSE channel — this module is the client-side receiver.
 *
 * Connection lifecycle:
 *   - Connects on module import (app startup).
 *   - On open: resets backoff to 1 s.
 *   - On error: closes, retries with exponential backoff (1→30 s cap).
 *   - Stores check `isConnected()` to decide whether to skip polling.
 *
 * Security: EventSource only connects to same-origin `/api/events`.
 * The engine's loopback guard is bypassed because Nginx proxies the
 * request from within the same container (127.0.0.1 → engine).
 */

// ─── Types ─────────────────────────────────────────────────────────────────

/** Job state as broadcast by the engine's `set_job()` function. */
export interface JobStateEvent {
  type: "job_state";
  job_id: string;
  job: {
    status: "running" | "done" | "failed";
    started_at_ms: number;
    completed_at_ms?: number;
    elapsed_ms?: number;
    tx_id_hex?: string;
    shards_sent?: number;
    bytes_sent: number;
    total_bytes?: number;
    dest?: string;
    files_sent?: number;
    files?: unknown[];
    skipped_files?: number;
    skipped_bytes?: number;
    files_processing?: number;
    files_finalized?: number;
    files_finalizing_total?: number;
    bytes_finalized?: number;
    commit_ack?: unknown;
    error?: string;
    error_reason?: string;
    error_detail?: string;
  };
}

export interface Ps5StatusEvent {
  type: "ps5_status";
  addr: string;
  payload_up: boolean;
  version?: string;
  ps5_kernel?: string;
  ucred_elevated?: boolean;
  max_transfer_streams?: number;
}

export interface QueueChangedEvent {
  type: "queue_changed";
  data: unknown;
}

export interface PlaylistsChangedEvent {
  type: "playlists_changed";
  data: unknown;
}

export interface ConfigChangedEvent {
  type: "config_changed";
  data: unknown;
}

export interface ActivityEvent {
  type: "activity";
  data: unknown;
}

export interface NotificationEvent {
  type: "notification";
  data: unknown;
}

export interface StoreChangedEvent {
  type: "store_changed";
  data: { key: string; version: number };
}

export type EngineEvent =
  | JobStateEvent
  | Ps5StatusEvent
  | QueueChangedEvent
  | PlaylistsChangedEvent
  | ConfigChangedEvent
  | ActivityEvent
  | NotificationEvent
  | StoreChangedEvent;

// ─── Callback types ────────────────────────────────────────────────────────

type JobStateCallback = (jobId: string, state: JobStateEvent["job"]) => void;
type GenericCallback = (event: EngineEvent) => void;

// ─── Registry ──────────────────────────────────────────────────────────────

const jobCallbacks = new Set<JobStateCallback>();
const genericCallbacks = new Set<GenericCallback>();

/** Subscribe to job state changes. Returns unsubscribe function. */
export function onJobState(cb: JobStateCallback): () => void {
  jobCallbacks.add(cb);
  return () => {
    jobCallbacks.delete(cb);
  };
}

/** Subscribe to all engine events. Returns unsubscribe function. */
export function onEngineEvent(cb: GenericCallback): () => void {
  genericCallbacks.add(cb);
  return () => {
    genericCallbacks.delete(cb);
  };
}

// ─── Connection state ──────────────────────────────────────────────────────

let connected = false;

/** Whether the SSE connection is currently open. Polling stores can skip when true. */
export function isSseConnected(): boolean {
  return connected;
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

function dispatch(raw: Record<string, unknown>): void {
  const type = raw.type as string | undefined;
  if (!type) return;

  const event = raw as unknown as EngineEvent;

  // Dispatch to typed subscribers
  if (type === "job_state") {
    const je = event as JobStateEvent;
    for (const cb of jobCallbacks) {
      try {
        cb(je.job_id, je.job);
      } catch {
        /* subscriber errors must not break other subscribers */
      }
    }
  }

  // Dispatch to generic subscribers
  for (const cb of genericCallbacks) {
    try {
      cb(event);
    } catch {
      /* subscriber errors must not break other subscribers */
    }
  }
}

// ─── SSE connection ────────────────────────────────────────────────────────

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;

function connect(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  try {
    eventSource = new EventSource("/api/events");
  } catch {
    // EventSource constructor can throw in some environments
    scheduleReconnect();
    return;
  }

  eventSource.onopen = () => {
    connected = true;
    reconnectDelay = 1000; // reset backoff on successful connect
  };

  eventSource.onmessage = (e: MessageEvent) => {
    try {
      const parsed = JSON.parse(e.data) as Record<string, unknown>;
      dispatch(parsed);
    } catch {
      // ignore malformed events (keepalive comments, partial JSON)
    }
  };

  eventSource.onerror = () => {
    connected = false;
    eventSource?.close();
    eventSource = null;
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    connect();
  }, reconnectDelay);
}

// Start the connection on import
connect();

// Clean up on Vite HMR
if (typeof import.meta !== "undefined" && (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (import.meta as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    connected = false;
    eventSource?.close();
    eventSource = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    jobCallbacks.clear();
    genericCallbacks.clear();
  });
}
