/**
 * Web-mode shim for Tauri's `invoke()` function.
 *
 * When the app is served from a browser (Docker / Nginx) rather than
 * inside a Tauri WebView, `window.__TAURI_INTERNALS__` is absent.
 * This module translates every Tauri IPC command into an equivalent
 * HTTP fetch() call to the engine's REST API.
 *
 * The engine is reachable at `/api/` (relative URL) — Nginx proxies
 * that prefix to `127.0.0.1:19113` inside the container.
 *
 * Commands that are inherently desktop-only (local file system walks,
 * payload TCP send, OS notifications) degrade gracefully:
 *  - Local FS commands return empty results (the Docker UI uses
 *    server-side path inputs instead of a host file picker).
 *  - Persistence (queue, playlists, resume tx-ids) falls back to
 *    localStorage so state survives page reloads.
 *  - `payload_send` is a no-op in web mode (use the Connection tab
 *    to send the payload manually from the PS5 side).
 */

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const BASE = "/api";

async function getJson<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  let url = `${BASE}${path}`;
  if (params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined) q.set(k, String(v));
    }
    const qs = q.toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ─── localStorage persistence (replaces Tauri file-based persistence) ────────

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`ps5upload:${key}`);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(`ps5upload:${key}`, JSON.stringify(value));
  } catch {
    /* quota exceeded — silently ignore */
  }
}

function lsRemove(key: string): void {
  try {
    localStorage.removeItem(`ps5upload:${key}`);
  } catch {
    /* ignore */
  }
}

// ─── SSE / streaming helper ────────────────────────────────────────────────

/**
 * Consume an SSE stream from the engine.
 * The engine's streaming endpoints (zip_inspect/stream, 7z_inspect/stream)
 * emit `event: progress` / `event: done` / `event: error` lines.
 * `onProgress` is called for each `progress` event; the function resolves
 * with the `done` payload or rejects on `error`.
 */
async function ssePost<TProgress, TResult>(
  path: string,
  body: unknown,
  onProgress: (p: TProgress) => void,
): Promise<TResult> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  return new Promise<TResult>((resolve, reject) => {
    function pump() {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            reject(new Error("SSE stream ended without a done event"));
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (!data || data === ": heartbeat") {
                eventType = "";
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                if (eventType === "progress") {
                  onProgress(parsed as TProgress);
                } else if (eventType === "done") {
                  resolve(parsed as TResult);
                  return;
                } else if (eventType === "error") {
                  reject(new Error(String((parsed as Record<string, unknown>).error ?? data)));
                  return;
                }
              } catch {
                /* ignore malformed SSE data */
              }
              eventType = "";
            } else if (line === "") {
              eventType = "";
            }
          }
          pump();
        })
        .catch(reject);
    }
    pump();
  });
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

type AnyArgs = Record<string, unknown> | undefined;

/**
 * Translate a Tauri IPC command + args into an HTTP call.
 * This is the single entry point used by `invokeLogged.ts` when running
 * outside a Tauri context. Unknown commands throw so they're visible
 * in the browser console rather than silently failing.
 */
export async function webInvoke<T>(
  cmd: string,
  args?: AnyArgs,
): Promise<T> {
  // Helper: extract `req` wrapper or use args directly
  const req = (args?.req ?? args ?? {}) as Record<string, unknown>;

  switch (cmd) {
    // ── Engine health ──────────────────────────────────────────────────────
    case "engine_version":
      return getJson<T>("/version");

    // ── PS5 status / volumes ───────────────────────────────────────────────
    case "ps5_status":
      return getJson<T>("/ps5/status", { addr: req.addr });

    case "ps5_volumes":
      return getJson<T>("/ps5/volumes", { addr: req.addr });

    case "ps5_list_dir": {
      // args: {addr, path, offset, limit}
      const a = args ?? {};
      return getJson<T>("/ps5/list-dir", {
        addr: a.addr,
        path: a.path,
        offset: a.offset,
        limit: a.limit,
      });
    }

    case "ps5_cleanup":
      return postJson<T>("/ps5/cleanup", req);

    case "ps5_pkg_scan_external":
      return getJson<T>("/ps5/pkg/scan-external", { addr: req.addr });

    // ── FS ops ─────────────────────────────────────────────────────────────
    case "ps5_fs_delete":
      return postJson<T>("/ps5/fs/delete", req);

    case "ps5_fs_move":
      return postJson<T>("/ps5/fs/move", req);

    case "ps5_fs_copy":
      return postJson<T>("/ps5/fs/copy", req);

    case "ps5_fs_op_status":
      return getJson<T>("/ps5/fs/op-status", { addr: req.addr, op_id: req.op_id });

    case "ps5_fs_op_cancel":
      return postJson<T>("/ps5/fs/op-cancel", req);

    case "ps5_fs_mount":
      return postJson<T>("/ps5/fs/mount", req);

    case "ps5_fs_unmount":
      return postJson<T>("/ps5/fs/unmount", req);

    case "ps5_fs_chmod":
      return postJson<T>("/ps5/fs/chmod", req);

    case "ps5_fs_mkdir":
      return postJson<T>("/ps5/fs/mkdir", req);

    // ── App management ─────────────────────────────────────────────────────
    case "ps5_app_launch":
      return postJson<T>("/ps5/app/launch", req);

    case "ps5_app_register":
      return postJson<T>("/ps5/app/register", req);

    case "ps5_app_unregister":
      return postJson<T>("/ps5/app/unregister", req);

    case "ps5_apps_installed":
      return getJson<T>("/ps5/apps/installed", { addr: req.addr });

    // ── Hardware ───────────────────────────────────────────────────────────
    case "ps5_hw_info":
      return getJson<T>("/ps5/hw/info", { addr: req.addr });

    case "ps5_hw_temps":
      return getJson<T>("/ps5/hw/temps", { addr: req.addr });

    case "ps5_hw_power":
      return getJson<T>("/ps5/hw/power", { addr: req.addr });

    case "ps5_hw_storage":
      return getJson<T>("/ps5/hw/storage", { addr: req.addr });

    case "ps5_hw_set_fan_threshold":
      return postJson<T>("/ps5/hw/fan-threshold", req);

    case "ps5_proc_list":
      return getJson<T>("/ps5/proc/list", { addr: req.addr });

    // ── Game metadata / icons ──────────────────────────────────────────────
    case "ps5_game_meta":
      return getJson<T>("/ps5/game-meta", {
        addr: req.addr,
        path: req.path,
      });

    case "ps5_game_icon":
      return getJson<T>("/ps5/game-icon", {
        addr: req.addr,
        path: req.path,
      });

    case "ps5_app_icon":
      return getJson<T>("/ps5/app-icon", {
        addr: req.addr,
        title_id: req.title_id,
      });

    // ── Time ───────────────────────────────────────────────────────────────
    case "ps5_time_get":
      return getJson<T>("/ps5/time/get", { addr: req.addr });

    case "ps5_time_sync":
      return postJson<T>("/ps5/time/sync", req);

    case "ps5_time_state_get":
      return getJson<T>("/ps5/time/state/get", { addr: req.addr });

    case "ps5_time_state_set":
      return postJson<T>("/ps5/time/state/set", req);

    // ── Syslog ─────────────────────────────────────────────────────────────
    case "ps5_syslog_tail":
      return getJson<T>("/ps5/syslog/tail", { addr: req.addr, since: req.since });

    // ── SMP meta ───────────────────────────────────────────────────────────
    case "ps5_smp_meta_control":
      return postJson<T>("/ps5/smp-meta/control", req);

    case "ps5_smp_meta_stats":
      return getJson<T>("/ps5/smp-meta/stats", { addr: req.addr });

    // ── Profile ────────────────────────────────────────────────────────────
    case "profile_info":
      return getJson<T>("/profile/info", { addr: req.addr });

    case "profile_set_username":
      return postJson<T>("/profile/username", req);

    case "profile_rename_user":
      return postJson<T>("/profile/local-username", req);

    case "profile_activate":
      return postJson<T>("/profile/activate", req);

    case "profile_clear_slot":
      return postJson<T>("/profile/clear-slot", req);

    case "profile_apply_avatar":
      return postJson<T>("/profile/avatar", req);

    case "profile_avatar_preview":
      return postJson<T>("/profile/avatar/preview", req);

    // ── Transfer jobs ──────────────────────────────────────────────────────
    case "transfer_file":
      return postJson<T>("/transfer/file", req);

    case "transfer_dir":
      return postJson<T>("/transfer/dir", req);

    case "transfer_dir_reconcile":
      return postJson<T>("/transfer/dir-reconcile", req);

    case "transfer_dir_diff_preview": {
      // Note: invoke uses camelCase arg names, engine uses snake_case body
      const a = args ?? {};
      return postJson<T>("/transfer/dir-diff-preview", {
        src_dir: a.srcDir,
        dest_root: a.destRoot,
        addr: a.addr,
        excludes: a.excludes,
      });
    }

    case "transfer_zip":
      return postJson<T>("/transfer/zip", req);

    case "transfer_7z":
      return postJson<T>("/transfer/7z", req);

    case "transfer_rar":
      return postJson<T>("/transfer/rar", req);

    case "transfer_file_list":
      return postJson<T>("/transfer/file-list", req);

    case "transfer_download":
      return postJson<T>("/transfer/download", req);

    // ── Archive inspect ────────────────────────────────────────────────────
    case "zip_inspect":
      return postJson<T>("/zip/inspect", req);

    case "sevenz_inspect":
      return postJson<T>("/7z/inspect", req);

    case "rar_inspect":
      return postJson<T>("/rar/inspect", req);

    // SSE streaming inspect — the Channel onmessage callback is already
    // registered by the caller via the `channel` arg; we drive it from SSE.
    case "zip_inspect_stream": {
      const { onProgress, req: r } = args as {
        onProgress: { onmessage: (p: unknown) => void };
        req: Record<string, unknown>;
      };
      return ssePost<unknown, T>("/zip/inspect/stream", r, (p) => {
        if (onProgress?.onmessage) onProgress.onmessage(p);
      });
    }

    case "sevenz_inspect_stream": {
      const { onProgress, req: r } = args as {
        onProgress: { onmessage: (p: unknown) => void };
        req: Record<string, unknown>;
      };
      return ssePost<unknown, T>("/7z/inspect/stream", r, (p) => {
        if (onProgress?.onmessage) onProgress.onmessage(p);
      });
    }

    // ── Job management ─────────────────────────────────────────────────────
    case "job_status":
      return getJson<T>(`/jobs/${req.id}`);

    case "cancel_job":
      return postJson<T>(`/jobs/${req.id}/cancel`);

    // ── Engine logs ────────────────────────────────────────────────────────
    case "engine_logs_tail":
      return getJson<T>("/engine-logs", { since: req.since ?? 0 });

    // ── Persistence: localStorage fallbacks ───────────────────────────────
    case "upload_queue_load":
      return lsGet<T>("upload_queue", {} as T);

    case "upload_queue_save":
      lsSet("upload_queue", args?.doc);
      return undefined as T;

    case "payload_playlists_load":
      return lsGet<T>("payload_playlists", {} as T);

    case "payload_playlists_save":
      lsSet("payload_playlists", args?.doc);
      return undefined as T;

    // ── Resume tx-id: localStorage fallbacks ──────────────────────────────
    case "resume_txid_lookup": {
      const key = `resume:${req.host}:${req.src}:${req.dest}`;
      const record = lsGet<{ tx_id_hex: string; expires: number } | null>(key, null);
      if (record && record.expires > Date.now()) {
        return { tx_id_hex: record.tx_id_hex } as T;
      }
      lsRemove(key);
      return { tx_id_hex: null } as T;
    }

    case "resume_txid_remember": {
      const key = `resume:${req.host}:${req.src}:${req.dest}`;
      lsSet(key, {
        tx_id_hex: req.tx_id_hex,
        expires: Date.now() + 24 * 60 * 60 * 1000, // 24h TTL
      });
      return undefined as T;
    }

    case "resume_txid_forget": {
      const key = `resume:${req.host}:${req.src}:${req.dest}`;
      lsRemove(key);
      return undefined as T;
    }

    // ── User config: localStorage fallbacks ───────────────────────────────
    case "user_config_load":
      return lsGet<T>("user_config", {} as T);

    case "user_config_save":
      lsSet("user_config", args?.config ?? args?.doc);
      return undefined as T;

    // ── Local filesystem (desktop-only, graceful no-ops in web mode) ──────
    //
    // In Docker the engine runs server-side; it can't walk the browser's
    // local filesystem. The upload path still works — users mount their
    // game library into the container (e.g. -v /mnt/games:/games) and
    // type the server-side path in the Upload screen's path field.
    case "local_list_dir":
      return { entries: [] } as T;

    case "local_storage_roots":
      return [] as T;

    case "storage_access_granted":
      return true as T;

    case "request_storage_access":
      return undefined as T;

    case "path_kind":
      // Without access to the local FS we can't tell — default to "folder"
      // so drag-drop paths at least attempt an upload rather than silently
      // routing to the wrong picker.
      return { kind: "folder" } as T;

    case "inspect_folder":
      // Return a minimal no-game result; the upload screen will show the
      // path as-is without a game preview card.
      return {
        ok: true,
        result: {
          path: req.path ?? "",
          title: null,
          title_id: null,
          content_id: null,
          content_version: null,
          application_category_type: null,
          icon0_path: null,
          total_size: 0,
          file_count: 0,
          skipped_paths: [],
          meta_source: "none",
        },
        wrapped_hint: null,
      } as T;

    // ── Payload TCP send (desktop-only) ───────────────────────────────────
    //
    // Send a payload ELF to the PS5 loader over TCP. In web mode, the
    // engine cannot open a raw TCP socket from the server, and the
    // browser certainly can't. The payload must be sent manually (e.g.
    // via `netcat` or another tool on the same network).
    case "payload_send":
      console.warn(
        "[web-mode] payload_send is not supported in Docker/web mode. " +
        "Send the ELF to your PS5 manually: nc <ps5-ip> 9021 < payload/ps5upload.elf"
      );
      return { ok: false, status: "not_supported_in_web_mode" } as T;

    // ── Connectivity probes & LAN discovery (web shims) ───────────────────
    case "payload_check": {
      try {
        const ip = req.ip || req.addr || "";
        const status = await getJson<unknown>("/ps5/status", { addr: `${ip}:9114` });
        return {
          ok: true,
          reachable: true,
          status,
        } as T;
      } catch (e: any) {
        return {
          ok: false,
          reachable: false,
          error: e.message || String(e),
        } as T;
      }
    }

    case "port_check": {
      const ip = req.ip || req.addr || "";
      const port = Number(req.port);
      if (port === 9114 || port === 9113) {
        try {
          await getJson<unknown>("/ps5/status", { addr: `${ip}:9114` });
          return { open: true } as T;
        } catch {
          return { open: false, error: "unreachable" } as T;
        }
      }
      return { open: false, error: "TCP probes for this port not supported in web mode" } as T;
    }

    case "discover_ps5":
      return {
        ok: true,
        candidates: [],
        scanned_ms: 0,
        browsed_services: [],
      } as T;

    case "companion_probe":
      return [] as T;

    case "update_check":
      return {
        available: false,
        current_version: "3.2.4",
        latest_version: "3.2.4",
        notes: "Running in Docker web mode. Updates are managed via Docker image tags.",
        pub_date: "",
        download_url: "",
        download_filename: "",
      } as T;

    case "fs_read_preview":
      return {
        size: 0,
        base64: "",
      } as T;

    case "shell_run_cmd":
      return {
        exit_code: -1,
        timed_out: false,
        stdout: "",
        err: "Shell execution is not supported in web mode.",
      } as T;

    // ── OS notifications (desktop-only no-op) ─────────────────────────────
    case "send_notification":
    case "notify":
      return undefined as T;

    // ── Keep-awake (desktop-only no-op) ───────────────────────────────────
    case "keep_awake_acquire":
    case "keep_awake_release":
      return undefined as T;

    // ── Crash reporter / diagnostics (desktop-only no-ops) ────────────────
    case "diag_log_append":
    case "diag_log_rotate":
    case "crash_report_save":
      return undefined as T;

    // ── Window state (no-op in browser) ───────────────────────────────────
    case "save_window_state":
    case "restore_window_state":
    case "set_window_title":
      return undefined as T;

    default:
      // Surface unknown commands clearly so they show up during development.
      console.error(`[webInvoke] Unknown command: "${cmd}"`, args);
      throw new Error(`webInvoke: unhandled command "${cmd}"`);
  }
}
