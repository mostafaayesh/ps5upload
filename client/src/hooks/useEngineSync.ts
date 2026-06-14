/**
 * React hook that wires Server-Sent Events into Zustand stores.
 *
 * Mount once in AppShell. Subscribes to the SSE event stream and
 * dispatches typed events to the appropriate stores:
 *   - job_state    → useTransferStore + useUploadQueueStore
 *   - ps5_status   → useConnectionStore
 *
 * The SSE connection is managed by engineEvents.ts (module-level
 * EventSource with auto-reconnect). This hook only registers
 * callbacks — it doesn't open its own connection.
 */

import { useEffect } from "react";
import { onJobState, onEngineEvent } from "../lib/engineEvents";
import { useTransferStore } from "../state/transfer";
import type { TransferPhase } from "../state/transfer";
import { useConnectionStore } from "../state/connection";
import { useUploadQueueStore, type QueueItem } from "../state/uploadQueue";
import { patchItem } from "../lib/queueOps";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract the host key from a transfer address (e.g. "192.168.1.2:9113" → "192.168.1.2"). */
function hostOf(addr: string): string {
  const lastColon = addr.lastIndexOf(":");
  return lastColon > 0 ? addr.slice(0, lastColon) : addr;
}

function bytesPerSec(
  prevBytes: number,
  prevMs: number,
  curBytes: number,
  curMs: number,
): number {
  const deltaBytes = curBytes - prevBytes;
  const deltaMs = curMs - prevMs;
  if (deltaMs <= 0 || deltaBytes <= 0) return 0;
  return Math.round((deltaBytes / deltaMs) * 1000);
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useEngineSync(): void {
  useEffect(() => {
    // ── Job state → transfer store ─────────────────────────────────────────
    const unsubJob = onJobState((jobId, job) => {
      const store = useTransferStore.getState();
      const { phasesByHost } = store;

      // Find which host this job belongs to
      let hostKey: string | null = null;
      let prevPhase: TransferPhase | null = null;
      for (const [key, phase] of Object.entries(phasesByHost)) {
        if (phase.kind === "running" && phase.jobId === jobId) {
          hostKey = key;
          prevPhase = phase;
          break;
        }
      }

      if (job.status === "running") {
        if (hostKey && prevPhase && prevPhase.kind === "running") {
          useTransferStore.setState({
            phasesByHost: {
              ...phasesByHost,
              [hostKey]: {
                ...prevPhase,
                bytesSent: job.bytes_sent ?? prevPhase.bytesSent,
                totalBytes: job.total_bytes ?? prevPhase.totalBytes,
                bytesPerSec: bytesPerSec(
                  prevPhase.bytesSent,
                  prevPhase.startedAtMs,
                  job.bytes_sent ?? prevPhase.bytesSent,
                  Date.now(),
                ),
                filesCompleted:
                  job.files_sent ?? prevPhase.filesCompleted,
                skippedFiles:
                  job.skipped_files ?? prevPhase.skippedFiles,
                skippedBytes:
                  job.skipped_bytes ?? prevPhase.skippedBytes,
                filesFinalized:
                  job.files_finalized ?? prevPhase.filesFinalized,
              } as TransferPhase,
            },
          });
        }
      } else if (job.status === "done") {
        if (hostKey) {
          useTransferStore.setState({
            phasesByHost: {
              ...phasesByHost,
              [hostKey]: {
                kind: "done",
                jobId,
                bytesSent: job.bytes_sent ?? 0,
                elapsedMs: job.elapsed_ms ?? 0,
                dest: job.dest ?? "",
                filesSent: job.files_sent ?? 0,
                skippedFiles: job.skipped_files ?? 0,
                skippedBytes: job.skipped_bytes ?? 0,
                commitAck: job.commit_ack,
                startedAtMs: job.started_at_ms,
              } as TransferPhase,
            },
          });
        }
      } else if (job.status === "failed") {
        if (hostKey) {
          useTransferStore.setState({
            phasesByHost: {
              ...phasesByHost,
              [hostKey]: {
                kind: "failed",
                error: job.error ?? "Unknown error",
                errorReason: job.error_reason,
                errorDetail: job.error_detail,
              } as TransferPhase,
            },
          });
        }
      }

      // ── Also update the upload queue store ───────────────────────────
      const qStore = useUploadQueueStore.getState();
      // Queue items track their job via `jobId` field (set by runner on start)
      const item = qStore.items.find(
        (i) => (i as { jobId?: string }).jobId === jobId,
      );
      if (item) {
        const patch: Record<string, unknown> = { status: job.status };
        if (job.status === "running") {
          patch.bytesSent = job.bytes_sent;
          patch.totalBytes = job.total_bytes;
        } else if (job.status === "done") {
          patch.bytesSent = job.bytes_sent;
          patch.elapsedMs = job.elapsed_ms;
        } else if (job.status === "failed") {
          patch.error = job.error;
          patch.errorReason = job.error_reason;
          patch.errorDetail = job.error_detail;
        }
        useUploadQueueStore.setState({
          items: patchItem(qStore.items, item.id, patch) as typeof qStore.items,
        });
      }
    });

    // ── PS5 status → connection store ──────────────────────────────────────
    const unsubGeneric = onEngineEvent((event) => {
      if (event.type === "ps5_status") {
        // broadcast_event nests fields under "data" — extract from there
        const data = (event as unknown as { data: Record<string, unknown> }).data;
        const addr = data?.addr as string | undefined;
        if (!addr) return;
        const host = hostOf(addr);
        useConnectionStore.getState().setHostStatus(host, {
          payloadStatus: (data.payload_up as boolean) ? "up" : "down",
          payloadVersion: data.version as string | undefined,
          ps5Kernel: data.ps5_kernel as string | undefined,
          ucredElevated: data.ucred_elevated as boolean | undefined,
          maxTransferStreams: data.max_transfer_streams as number | undefined,
        });
      }

      // ── Shared state sync: when another client changes the queue,
      //     playlists, or config, update our Zustand stores ──────────────────
      if (event.type === "queue_changed") {
        const data = (event as { data: unknown }).data;
        if (data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          useUploadQueueStore.setState({
            items: (Array.isArray(d.items) ? d.items : []) as QueueItem[],
            continueOnFailure: (d.continueOnFailure as boolean) ?? false,
          } as Partial<ReturnType<typeof useUploadQueueStore.getState>>);
        }
      }

      if (event.type === "playlists_changed") {
        const data = (event as { data: unknown }).data;
        if (data && typeof data === "object") {
          // Import lazily to avoid circular dep
          import("../state/payloadPlaylists").then((mod) => {
            mod.usePayloadPlaylistsStore.setState({
              playlists:
                (data as { playlists?: unknown[] }).playlists as never ?? [],
            });
          }).catch(() => {});
        }
      }

      if (event.type === "config_changed") {
        // Config changes are applied by the hydrateFromUserConfig system.
        // We trigger a re-hydrate by dispatching a custom event.
        window.dispatchEvent(new CustomEvent("ps5upload:config_changed", {
          detail: (event as { data: unknown }).data,
        }));
      }

      if (event.type === "activity") {
        window.dispatchEvent(new CustomEvent("ps5upload:activity", {
          detail: (event as { data: unknown }).data,
        }));
      }

      if (event.type === "notification") {
        window.dispatchEvent(new CustomEvent("ps5upload:notification", {
          detail: (event as { data: unknown }).data,
        }));
      }
    });

    return () => {
      unsubJob();
      unsubGeneric();
    };
  }, []);
}
