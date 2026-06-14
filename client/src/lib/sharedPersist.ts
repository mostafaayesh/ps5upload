/**
 * Engine-backed persistence for collaborative Zustand stores.
 *
 * In web/Docker mode (no Tauri), stores that previously used `localStorage`
 * can call `useSharedSync()` to additionally:
 *   1. Hydrate from the engine (`GET /api/store/:key`) on mount.
 *   2. Persist mutations to the engine (debounced `PUT /api/store/:key`).
 *   3. Re-hydrate when another client writes the same key via SSE.
 *
 * Desktop Tauri builds are unaffected: every function returns immediately
 * when `isWebMode()` is false, so existing `localStorage` paths win.
 */

import { useEffect } from "react";
import { onEngineEvent } from "./engineEvents";

// ── Web mode detection ────────────────────────────────────────────────────────

export function isWebMode(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  const internals = w.__TAURI_INTERNALS__ as Record<string, unknown> | undefined;
  return !(Boolean(w.isTauri || internals) && !internals?.isShim);
}

// ── Per-key state ─────────────────────────────────────────────────────────────

const _etags = new Map<string, string>();
const _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Blocks the Zustand subscribe callback from immediately re-uploading
// data that was just fetched from the engine (no-op round-trip).
const _suppressSave = new Set<string>();

// ── Load ──────────────────────────────────────────────────────────────────────

export async function sharedLoad<T>(key: string, fallback: T): Promise<T> {
  if (!isWebMode()) return fallback;
  try {
    const res = await fetch(`/api/store/${key}`);
    if (!res.ok) return fallback;
    const etag = res.headers.get("etag");
    if (etag) _etags.set(key, etag);
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

// ── Save (debounced, version-aware) ──────────────────────────────────────────

export function sharedSave(key: string, data: unknown, delayMs = 400): void {
  if (!isWebMode() || _suppressSave.has(key)) return;
  const existing = _debounceTimers.get(key);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    _debounceTimers.delete(key);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const etag = _etags.get(key);
    if (etag) headers["If-Match"] = etag;
    fetch(`/api/store/${key}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(data),
    })
      .then(async (res) => {
        if (res.ok) {
          const newEtag = res.headers.get("etag");
          if (newEtag) _etags.set(key, newEtag);
        } else if (res.status === 409) {
          // Conflict: refresh our cached version and retry immediately.
          try {
            const body = await res.json() as Record<string, unknown>;
            if (typeof body?.version === "number") {
              _etags.set(key, `"${body.version}"`);
            }
          } catch { /* ignore */ }
          sharedSave(key, data, 50);
        }
      })
      .catch(() => {/* network error — best-effort */});
  }, delayMs);
  _debounceTimers.set(key, timer);
}

// ── SSE store_changed listener ────────────────────────────────────────────────

function onStoreChanged(key: string, cb: () => void): () => void {
  return onEngineEvent((event) => {
    if (event.type !== "store_changed") return;
    const d = (event as { data?: { key?: string } }).data;
    if (d?.key === key) cb();
  });
}

// ── React hook ────────────────────────────────────────────────────────────────

/**
 * Mount once per collaborative store. In web mode it:
 *  1. Hydrates the Zustand store from the engine on mount.
 *  2. Persists mutations to the engine (debounced, If-Match version check).
 *  3. Re-hydrates when another client writes the same key (SSE store_changed).
 *
 * `subscribe`  — Zustand's `.subscribe(cb)` bound to the data slice to sync.
 * `setRemote`  — applies remotely-loaded data to the local store.
 * `fallback`   — used when the engine key is absent (first run / empty state).
 */
export function useSharedSync<T>(
  key: string,
  subscribe: (listener: (data: T) => void) => () => void,
  setRemote: (data: T) => void,
  fallback: T,
): void {
  useEffect(() => {
    if (!isWebMode()) return;

    let cancelled = false;

    const hydrate = () =>
      sharedLoad<T>(key, fallback).then((data) => {
        if (cancelled) return;
        // Suppress the next subscription fire so we don't echo the just-fetched
        // value straight back to the engine.
        _suppressSave.add(key);
        setRemote(data);
        setTimeout(() => _suppressSave.delete(key), 0);
      });

    hydrate();

    const unsubStore = subscribe((data) => sharedSave(key, data));
    const unsubSse = onStoreChanged(key, hydrate);

    return () => {
      cancelled = true;
      unsubStore();
      unsubSse();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
