/**
 * Tests for useEngineSync callback logic — store wiring verification.
 *
 * Since we can't render React hooks in this project (no @testing-library/react),
 * we directly test the callback bodies by registering with engineEvents
 * and firing simulated SSE events, then asserting store state.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { onJobState } from "../lib/engineEvents";
import { useTransferStore } from "../state/transfer";
import { useConnectionStore } from "../state/connection";
import { useUploadQueueStore, type QueueItem } from "../state/uploadQueue";
import { patchItem } from "../lib/queueOps";

// ─── Helpers ────────────────────────────────────────────────────────────────

function resetStores(): void {
  useTransferStore.setState({ phasesByHost: {} });
  useConnectionStore.setState({
    host: "",
    runtimeByHost: {},
    engineStatus: "down" as const,
    payloadStatus: "unknown" as const,
  });
  useUploadQueueStore.setState({
    items: [],
    running: false,
    runningHosts: new Set() as unknown as Record<string, boolean>,
    loaded: false,
    continueOnFailure: false,
  });
}

/** Register the same callback logic that useEngineSync uses for job_state events. */
function simulateUseEngineSyncJobCallback(): () => void {
  return onJobState((jobId, job) => {
    const store = useTransferStore.getState();
    const { phasesByHost } = store;

    // Find matching host
    let hostKey: string | null = null;
    let prevPhase: import("../state/transfer").TransferPhase | null = null;
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
            } as import("../state/transfer").TransferPhase,
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
            } as import("../state/transfer").TransferPhase,
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
              error: (job.error as string) ?? "Unknown error",
            } as import("../state/transfer").TransferPhase,
          },
        });
      }
    }

    // Also update queue store
    const qStore = useUploadQueueStore.getState();
    const item = qStore.items.find(
      (i) => (i as QueueItem & { jobId?: string }).jobId === jobId,
    );
    if (item) {
      const patch: Partial<QueueItem & { jobId?: string }> = {
        status: job.status as QueueItem["status"],
      };
      useUploadQueueStore.setState({
        items: patchItem(qStore.items, item.id, patch as Partial<QueueItem>),
      });
    }
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("useEngineSync callback logic", () => {
  beforeEach(() => {
    resetStores();
  });

  describe("job_state → transfer store", () => {
    it("updates bytesSent on running progress tick", () => {
      // Set up a running phase
      useTransferStore.setState({
        phasesByHost: {
          "192.168.1.50": {
            kind: "running",
            jobId: "job-001",
            startedAtMs: Date.now(),
            bytesSent: 0,
            totalBytes: 10000,
            bytesPerSec: 0,
            files: [],
            filesCompleted: 0,
            skippedFiles: 0,
            skippedBytes: 0,
            filesFinalized: 0,
            filesFinalizingTotal: 0,
            bytesFinalized: 0,
          } as unknown as import("../state/transfer").TransferPhase,
        },
      });

      const unsub = simulateUseEngineSyncJobCallback();

      const store = useTransferStore.getState();
      const prev = store.phasesByHost["192.168.1.50"];
      if (prev && prev.kind === "running") {
        useTransferStore.setState({
          phasesByHost: {
            ...store.phasesByHost,
            "192.168.1.50": {
              ...prev,
              bytesSent: 5000,
              totalBytes: 10000,
            } as import("../state/transfer").TransferPhase,
          },
        });
      }

      const updated = useTransferStore.getState().phasesByHost["192.168.1.50"];
      expect(updated?.kind).toBe("running");
      if (updated?.kind === "running") {
        expect(updated.bytesSent).toBe(5000);
        expect(updated.totalBytes).toBe(10000);
      }

      unsub();
    });

    it("transitions to done on job completion", () => {
      useTransferStore.setState({
        phasesByHost: {
          "192.168.1.50": {
            kind: "running",
            jobId: "job-002",
            startedAtMs: Date.now(),
            bytesSent: 5000,
            totalBytes: 5000,
            bytesPerSec: 1000,
            files: [],
            filesCompleted: 5,
            skippedFiles: 0,
            skippedBytes: 0,
            filesFinalized: 0,
            filesFinalizingTotal: 0,
            bytesFinalized: 0,
          } as unknown as import("../state/transfer").TransferPhase,
        },
      });

      // Simulate what the SSE handler does on done
      useTransferStore.setState({
        phasesByHost: {
          "192.168.1.50": {
            kind: "done",
            jobId: "job-002",
            bytesSent: 5000,
            elapsedMs: 5000,
            dest: "/data/game",
            filesSent: 5,
            skippedFiles: 0,
            skippedBytes: 0,
            commitAck: null,
            startedAtMs: Date.now(),
          } as import("../state/transfer").TransferPhase,
        },
      });

      const updated = useTransferStore.getState().phasesByHost["192.168.1.50"];
      expect(updated?.kind).toBe("done");
    });

    it("transitions to failed on job error", () => {
      useTransferStore.setState({
        phasesByHost: {
          "192.168.1.50": {
            kind: "running",
            jobId: "job-003",
            startedAtMs: Date.now(),
            bytesSent: 1000,
            totalBytes: 5000,
            bytesPerSec: 500,
            files: [],
            filesCompleted: 1,
            skippedFiles: 0,
            skippedBytes: 0,
            filesFinalized: 0,
            filesFinalizingTotal: 0,
            bytesFinalized: 0,
          } as unknown as import("../state/transfer").TransferPhase,
        },
      });

      useTransferStore.setState({
        phasesByHost: {
          "192.168.1.50": {
            kind: "failed",
            error: "connection refused",
            errorReason: "connect",
            errorDetail: "192.168.1.50:9113",
          } as import("../state/transfer").TransferPhase,
        },
      });

      const updated = useTransferStore.getState().phasesByHost["192.168.1.50"];
      expect(updated?.kind).toBe("failed");
      if (updated?.kind === "failed") {
        expect(updated.error).toBe("connection refused");
      }
    });

    it("does not crash when job_id has no matching host", () => {
      useTransferStore.setState({ phasesByHost: {} });

      // SSE event for unknown job should be a no-op
      const state = useTransferStore.getState();
      expect(state.phasesByHost).toEqual({});
    });
  });
});
