import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks for the start() pre-flight suite below. The load()/hydrate()
// suite doesn't touch these modules, so mocking them is harmless there.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "9.9.9"),
}));
vi.mock("../api/ps5", () => ({
  bundledPayloadPath: vi.fn(async () => "/bundled/ps5upload.elf"),
  payloadCheck: vi.fn(async () => ({
    reachable: true,
    payloadVersion: "9.9.9",
  })),
  sendPayload: vi.fn(async () => {}),
}));
vi.mock("../api/engine", () => ({ engineApi: { ping: vi.fn() } }));

import { invoke } from "@tauri-apps/api/core";
import { engineApi } from "../api/engine";
import { useInstallQueue, type InstallQueueItem } from "./installQueue";
import { useConnectionStore } from "./connection";

// installQueue uses bare `localStorage.{getItem,setItem}` (not the
// `window.localStorage` shape the mountDest tests stub), so we have
// to stub the global the module reads from. Vitest's default node env
// has no localStorage at all; jsdom-style globals would also work but
// pulling in jsdom for one suite isn't worth it.
function installLocalStorageStub() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("localStorage", stub);
  return stub;
}

const STORAGE_KEY = "ps5upload.install_queue.v1";

describe("installQueue load() back-compat", () => {
  beforeEach(() => {
    installLocalStorageStub();
    // Zustand stores hold global state across tests in the same
    // module — reset before each test so a leaked items[] from one
    // case doesn't poison the next.
    useInstallQueue.setState({ items: [], runId: 0, isRunning: false, _hydrated: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hydrates a fresh install (no persisted state) to an empty queue", () => {
    useInstallQueue.getState().hydrate();
    expect(useInstallQueue.getState().items).toEqual([]);
  });

  it("strips the legacy localPs5Path field on load (file:// flow retired in 2.2.52)", () => {
    // Persisted shape from a 2.2.50 / 2.2.51 install, before file://
    // was retired. The field should silently disappear on hydrate
    // and the row should still load with all other fields intact.
    const legacyRow = {
      id: "abc123",
      pkgPath: "/Users/test/foo.pkg",
      isSplit: false,
      displayName: "foo",
      contentId: "UP1234-CUSA56789_00-XXXXXXXXXXXXXXXX",
      totalBytes: 1234567,
      packageType: "PS4GD",
      addr: "192.168.1.50:9114",
      status: "pending",
      phase: "idle",
      bytesDownloaded: 0,
      errCode: 0,
      errMessage: null,
      sessionId: null,
      taskId: null,
      addedAt: 1700000000000,
      startedAt: null,
      finishedAt: null,
      warnings: [],
      // The retired field — set to a non-null value to prove it
      // disappears rather than being passed through silently.
      localPs5Path: "/data/pkg/foo.pkg",
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([legacyRow]));

    useInstallQueue.getState().hydrate();
    const loaded = useInstallQueue.getState().items;

    expect(loaded.length).toBe(1);
    const row = loaded[0];
    expect(row.id).toBe("abc123");
    expect(row.pkgPath).toBe("/Users/test/foo.pkg");
    expect(row.contentId).toBe("UP1234-CUSA56789_00-XXXXXXXXXXXXXXXX");
    // The field is gone — accessing it via an as-cast shouldn't find
    // it on the runtime object.
    expect((row as unknown as { localPs5Path?: string }).localPs5Path).toBeUndefined();
  });

  it("back-fills 2.2.52 diag defaults for rows persisted by older builds", () => {
    // A legitimately-old row (no diag field) should hydrate with
    // empty/false defaults so the InstallPackage row's <details>
    // expander renders without a runtime crash on `diag.registerPath`.
    const oldRow = {
      id: "old1",
      pkgPath: "/x.pkg",
      isSplit: false,
      displayName: "x",
      contentId: "UP0000-CUSA00000_00-XXXXXXXXXXXXXXXX",
      totalBytes: 0,
      packageType: "PS4GD",
      addr: "10.0.0.1:9114",
      status: "pending",
      phase: "idle",
      bytesDownloaded: 0,
      errCode: 0,
      errMessage: null,
      sessionId: null,
      taskId: null,
      addedAt: 1,
      startedAt: null,
      finishedAt: null,
      warnings: [],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([oldRow]));

    useInstallQueue.getState().hydrate();
    const row = useInstallQueue.getState().items[0];
    expect(row.diag).toEqual({
      registerPath: "",
      intdebugAvail: false,
      kernelRw: false,
      shelluiErr: null,
      appinstErr: null,
    });
  });

  it("replaces a malformed diag block with the empty default", () => {
    // Corruption-resistant: persisted localStorage could contain a
    // diag of the wrong shape (string, number, array) from an older
    // bug or hand-edited state. Pre-fix the `?? defaults` check let
    // these slip through, then InstallRow's <details> expander tried
    // to access `.registerPath` on a string and rendered weirdly.
    // Validation must replace any non-plain-object diag with the
    // empty default.
    const malformedShapes: unknown[] = ["oops", 42, ["a", "b"], null];
    for (const badDiag of malformedShapes) {
      const row = {
        id: "bad-diag",
        pkgPath: "/z.pkg",
        isSplit: false,
        displayName: "z",
        contentId: "X",
        totalBytes: 0,
        packageType: "PS4GD",
        addr: "1:9114",
        status: "pending",
        phase: "idle",
        bytesDownloaded: 0,
        errCode: 0,
        errMessage: null,
        sessionId: null,
        taskId: null,
        addedAt: 1,
        startedAt: null,
        finishedAt: null,
        warnings: [],
        diag: badDiag,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify([row]));
      useInstallQueue.setState({ items: [], runId: 0, isRunning: false, _hydrated: false });
      useInstallQueue.getState().hydrate();
      const got = useInstallQueue.getState().items[0];
      expect(got.diag).toEqual({
        registerPath: "",
        intdebugAvail: false,
        kernelRw: false,
        shelluiErr: null,
        appinstErr: null,
      });
    }
  });

  it("preserves an existing diag block when hydrating", () => {
    // A row written by a 2.2.52+ payload run carries diag data; the
    // back-fill must not stomp it.
    const richRow = {
      id: "new1",
      pkgPath: "/y.pkg",
      isSplit: false,
      displayName: "y",
      contentId: "UP0000-CUSA00001_00-XXXXXXXXXXXXXXXX",
      totalBytes: 0,
      packageType: "PS4GD",
      addr: "10.0.0.1:9114",
      status: "failed",
      phase: "error",
      bytesDownloaded: 0,
      errCode: 0x80990038,
      errMessage: "BGFT register failed",
      sessionId: null,
      taskId: null,
      addedAt: 2,
      startedAt: null,
      finishedAt: 3,
      warnings: [],
      diag: {
        registerPath: "regular",
        intdebugAvail: false,
        kernelRw: true,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([richRow]));

    useInstallQueue.getState().hydrate();
    const row = useInstallQueue.getState().items[0];
    expect(row.diag.registerPath).toBe("regular");
    expect(row.diag.intdebugAvail).toBe(false);
    expect(row.diag.kernelRw).toBe(true);
  });

  it("drops rows missing required string fields", () => {
    const malformed = [
      { id: 42, pkgPath: "/a.pkg", addr: "x:9114" }, // id wrong type
      { pkgPath: "/b.pkg", addr: "x:9114" }, // missing id
      // good one
      {
        id: "ok",
        pkgPath: "/c.pkg",
        isSplit: false,
        displayName: "c",
        contentId: "X",
        totalBytes: 0,
        packageType: "PS4GD",
        addr: "x:9114",
        status: "pending",
        phase: "idle",
        bytesDownloaded: 0,
        errCode: 0,
        errMessage: null,
        sessionId: null,
        taskId: null,
        addedAt: 1,
        startedAt: null,
        finishedAt: null,
        warnings: [],
      },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(malformed));

    useInstallQueue.getState().hydrate();
    const items = useInstallQueue.getState().items;
    expect(items.length).toBe(1);
    expect(items[0].id).toBe("ok");
  });
});

const mockedInvoke = vi.mocked(invoke);
const mockedPing = vi.mocked(engineApi.ping);

/** A minimal pending install item. Field shape mirrors InstallQueueItem
 *  in installQueue.ts — changes there surface here as compile errors.
 *  Defaults to the stream/DPI 2.0 path (no staging). */
function fakeItem(overrides: Partial<InstallQueueItem> = {}): InstallQueueItem {
  return {
    id: "item-1",
    pkgPath: "/games/x.pkg",
    isSplit: false,
    displayName: "x.pkg",
    contentId: "",
    totalBytes: 0,
    packageType: "",
    addr: "192.168.1.50:9114",
    status: "pending",
    phase: "idle",
    bytesDownloaded: 0,
    errCode: 0,
    errMessage: null,
    sessionId: null,
    taskId: null,
    addedAt: 0,
    startedAt: null,
    finishedAt: null,
    warnings: [],
    installMethod: "stream",
    stagingPath: null,
    stagingBytes: 0,
    diag: {
      registerPath: "",
      intdebugAvail: false,
      kernelRw: false,
      shelluiErr: null,
      appinstErr: null,
    },
    ...overrides,
  };
}

const startedInstall = () =>
  mockedInvoke.mock.calls.some((c) => c[0] === "pkg_install_start");

describe("useInstallQueue.start pre-flight", () => {
  beforeEach(() => {
    installLocalStorageStub();
    mockedInvoke.mockReset().mockResolvedValue(undefined);
    mockedPing.mockReset();
    useInstallQueue.setState({ items: [], isRunning: false, runId: 0 });
    useConnectionStore.setState({
      engineStatus: "unknown",
      payloadStatus: "unknown",
      payloadStatusHost: null,
    });
  });
  afterEach(() => {
    useInstallQueue.setState({ items: [], isRunning: false, runId: 0 });
    vi.unstubAllGlobals();
  });

  const seed = (item: InstallQueueItem) =>
    useInstallQueue.setState({ items: [item], isRunning: false, runId: 0 });

  it("blocks with an engine-down message when an 'unknown' engine fails the active ping", async () => {
    // engineStatus "unknown" (background poll hasn't run) is exactly the
    // just-launched case; the pre-flight must actively ping rather than
    // pass through. ping=false → block, and pkg_install_start never fires.
    mockedPing.mockResolvedValue(false);
    seed(fakeItem());

    await useInstallQueue.getState().start();

    const item = useInstallQueue.getState().items[0];
    expect(item.status).toBe("failed");
    expect(item.errMessage).toContain("Desktop engine isn't running");
    expect(mockedPing).toHaveBeenCalledTimes(1);
    expect(useInstallQueue.getState().isRunning).toBe(false);
    expect(startedInstall()).toBe(false);
  });

  it("trusts engineStatus 'up' (no active ping) and blocks on a payload down for the target host", async () => {
    useConnectionStore.setState({
      engineStatus: "up",
      payloadStatus: "down",
      payloadStatusHost: "192.168.1.50",
    });
    seed(fakeItem({ addr: "192.168.1.50:9114" }));

    await useInstallQueue.getState().start();

    const item = useInstallQueue.getState().items[0];
    expect(item.status).toBe("failed");
    expect(item.errMessage).toContain("PS5 helper");
    expect(mockedPing).not.toHaveBeenCalled();
    expect(startedInstall()).toBe(false);
  });

  it("normalizes host:port when matching payloadStatusHost to the target", async () => {
    // payloadStatusHost is the raw probed host (may carry a port);
    // target is bare-IP. Both must normalize so a port doesn't make the
    // check silently skip.
    useConnectionStore.setState({
      engineStatus: "up",
      payloadStatus: "down",
      payloadStatusHost: "192.168.1.50:9114",
    });
    seed(fakeItem({ addr: "192.168.1.50:9114" }));

    await useInstallQueue.getState().start();

    expect(useInstallQueue.getState().items[0].status).toBe("failed");
    expect(useInstallQueue.getState().items[0].errMessage).toContain(
      "PS5 helper",
    );
  });

  it("does NOT block on a payload down for a DIFFERENT host (no false positive)", async () => {
    useConnectionStore.setState({
      engineStatus: "up",
      payloadStatus: "down",
      payloadStatusHost: "192.168.1.99",
    });
    seed(fakeItem({ addr: "192.168.1.50:9114" }));

    // engineStatus "up" → the pre-flight runs synchronously up to the
    // first ensurePayloadCurrent await, so by here it has NOT blocked.
    const p = useInstallQueue.getState().start();
    expect(useInstallQueue.getState().items[0].status).not.toBe("failed");

    // Stop so the worker bails at its next isLive() check (after
    // ensurePayloadCurrent) instead of driving a real install.
    useInstallQueue.getState().stop();
    await p;

    expect(mockedPing).not.toHaveBeenCalled();
    expect(startedInstall()).toBe(false);
    expect(useInstallQueue.getState().items[0].errMessage ?? "").not.toContain(
      "PS5 helper",
    );
  });
});
