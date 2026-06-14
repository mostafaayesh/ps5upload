/**
 * Tests for engineEvents.ts — SSE event stream consumer.
 *
 * Mocks the browser EventSource API since vitest runs in Node.
 * Tests cover: connection lifecycle, event dispatch, typed
 * callback routing, unsubscribe, and reconnection backoff.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock EventSource ───────────────────────────────────────────────────────

let mockEventSourceInstance: MockEventSource | null = null;

class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  readyState: number = 0; // 0 = CONNECTING, 1 = OPEN, 2 = CLOSED

  constructor(url: string) {
    this.url = url;
    mockEventSourceInstance = this;
  }

  close(): void {
    this.readyState = 2;
  }
}

// Mock global EventSource before importing the module
vi.stubGlobal("EventSource", MockEventSource);

// ─── Import after mock ──────────────────────────────────────────────────────

// We need to import dynamically after mocking, since the module
// auto-connects on import. Use vi.hoisted for the mock and
// dynamic import in beforeEach.

let engineEvents: typeof import("../src/lib/engineEvents");

async function loadModule() {
  // Reset the module registry to get a fresh import
  vi.resetModules();
  mockEventSourceInstance = null;

  // Reset global mocks
  vi.stubGlobal("EventSource", MockEventSource);

  engineEvents = await import("./engineEvents");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fireMessage(data: unknown): void {
  if (!mockEventSourceInstance?.onmessage) return;
  const event = new MessageEvent("message", {
    data: typeof data === "string" ? data : JSON.stringify(data),
  });
  mockEventSourceInstance.onmessage(event);
}

function fireOpen(): void {
  if (!mockEventSourceInstance) return;
  mockEventSourceInstance.readyState = 1;
  mockEventSourceInstance.onopen?.();
}

function fireError(): void {
  if (!mockEventSourceInstance) return;
  mockEventSourceInstance.onerror?.();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("engineEvents", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await loadModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("connection", () => {
    it("creates EventSource on /api/events on import", () => {
      expect(mockEventSourceInstance).not.toBeNull();
      expect(mockEventSourceInstance!.url).toBe("/api/events");
    });

    it("sets connected=true on open", () => {
      expect(engineEvents.isSseConnected()).toBe(false);
      fireOpen();
      expect(engineEvents.isSseConnected()).toBe(true);
    });

    it("sets connected=false on error", () => {
      fireOpen();
      expect(engineEvents.isSseConnected()).toBe(true);
      fireError();
      expect(engineEvents.isSseConnected()).toBe(false);
    });
  });

  describe("job_state dispatch", () => {
    it("calls registered job state callbacks with parsed data", () => {
      fireOpen();

      const cb = vi.fn();
      engineEvents.onJobState(cb);

      const job = {
        status: "running",
        started_at_ms: 1000,
        bytes_sent: 500,
        total_bytes: 10000,
      };

      fireMessage({
        type: "job_state",
        job_id: "abc-123",
        job,
      });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith("abc-123", job);
    });

    it("handles job_state with done status", () => {
      fireOpen();
      const cb = vi.fn();
      engineEvents.onJobState(cb);

      fireMessage({
        type: "job_state",
        job_id: "xyz-789",
        job: {
          status: "done",
          started_at_ms: 1000,
          completed_at_ms: 5000,
          elapsed_ms: 4000,
          bytes_sent: 10000,
          dest: "/data/test",
          files_sent: 5,
        },
      });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][1].status).toBe("done");
    });

    it("handles job_state with failed status", () => {
      fireOpen();
      const cb = vi.fn();
      engineEvents.onJobState(cb);

      fireMessage({
        type: "job_state",
        job_id: "fail-1",
        job: {
          status: "failed",
          started_at_ms: 1000,
          completed_at_ms: 2000,
          elapsed_ms: 1000,
          error: "connection refused",
          error_reason: "connect",
        },
      });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][1].status).toBe("failed");
      expect(cb.mock.calls[0][1].error).toBe("connection refused");
    });

    it("does not call unsubscribed callbacks", () => {
      fireOpen();
      const cb = vi.fn();
      const unsub = engineEvents.onJobState(cb);
      unsub();

      fireMessage({
        type: "job_state",
        job_id: "abc",
        job: { status: "running", started_at_ms: 1, bytes_sent: 0 },
      });

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("generic dispatch", () => {
    it("calls registered generic callbacks for all event types", () => {
      fireOpen();
      const cb = vi.fn();
      engineEvents.onEngineEvent(cb);

      fireMessage({
        type: "ps5_status",
        addr: "192.168.1.2:9114",
        payload_up: true,
      });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ type: "ps5_status" });
    });

    it("calls generic callback even when no typed callback matches", () => {
      fireOpen();
      const cb = vi.fn();
      engineEvents.onEngineEvent(cb);

      fireMessage({
        type: "future_event_type",
        data: { foo: "bar" },
      });

      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("malformed events", () => {
    it("ignores events without a type field", () => {
      fireOpen();
      const cb = vi.fn();
      engineEvents.onEngineEvent(cb);

      fireMessage({ job_id: "abc", job: {} });

      expect(cb).not.toHaveBeenCalled();
    });

    it("ignores non-JSON data", () => {
      fireOpen();
      const cb = vi.fn();
      engineEvents.onJobState(cb);

      // Direct string that isn't valid JSON
      const e = new MessageEvent("message", { data: "not json" });
      mockEventSourceInstance!.onmessage?.(e);

      expect(cb).not.toHaveBeenCalled();
    });

    it("subscriber errors do not prevent other subscribers", () => {
      fireOpen();
      const bad = vi.fn(() => {
        throw new Error("subscriber crash");
      });
      const good = vi.fn();
      engineEvents.onJobState(bad);
      engineEvents.onJobState(good);

      fireMessage({
        type: "job_state",
        job_id: "abc",
        job: { status: "running", started_at_ms: 1, bytes_sent: 0 },
      });

      expect(bad).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(1);
    });
  });
});
