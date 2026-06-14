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

// @ts-ignore
import faqMarkdown from "../../../FAQ.md?raw";
// @ts-ignore
import changelogMarkdown from "../../../CHANGELOG.md?raw";

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

// ─── Payloads Catalogue Data ───────────────────────────────────────────────

const CATALOGUE = [
  {
    id: "kstuff-echostretch",
    display_name: "kstuff-lite (EchoStretch)",
    role: "Kernel exploit + R/W primitive",
    description: "Kernel patcher for the full PS5 firmware range. Resolves kernel symbols at runtime via the SDK's NID table, so the same binary covers FW 1.00 → 12.x. Required by ShadowMountPlus and most other privileged payloads. Load this first.",
    repo_host: "github.com",
    repo_owner: "EchoStretch",
    repo_name: "kstuff-lite",
    asset_name_hint: "kstuff",
    on_console_marker_path: "/data/kstuff.elf",
    process_name_hint: null,
    ports: [],
    autoload_priority: 0,
    autoload_delay_ms: 3000,
    homepage: "https://github.com/EchoStretch/kstuff-lite",
  },
  {
    id: "kstuff-lite-drakmor",
    display_name: "kstuff-lite (drakmor — fpkg-optimized)",
    role: "Kernel exploit + R/W primitive — faster .ffpkg/PFS mounting",
    description: "Fork of EchoStretch/kstuff-lite with a hot path for .ffpkg (UFS) + PFS mounts and lower overhead in repeated mount/unmount cycles. Recent builds extended firmware coverage through FW 12.xx (the '12.xx Support' update) on top of the original 3.00→10.01 range — check the release notes for your exact firmware. Adds an option to disable automatic mounting (noautomount) for a controlled startup. Recommended when your primary workflow is ShadowMount+ with .ffpkg/.exfat/PFS images. Same load-first ordering as any other kstuff: must boot before ShadowMount+ or ps5upload.",
    repo_host: "github.com",
    repo_owner: "drakmor",
    repo_name: "kstuff-lite",
    asset_name_hint: "kstuff",
    on_console_marker_path: "/data/kstuff.elf",
    process_name_hint: null,
    ports: [],
    autoload_priority: 0,
    autoload_delay_ms: 3000,
    homepage: "https://github.com/drakmor/kstuff-lite",
  },
  {
    id: "shadowmountplus",
    display_name: "ShadowMount+",
    role: "Auto-mount + register daemon for game backups",
    description: "Watches scan folders (/mnt/usb*, /mnt/ext*, /data/homebrew, /mnt/shadowmnt) AND /data/shadowmount/manual.lst for game folders and .ffpkg/.exfat/.ffpfs/.ffpfsc images, then auto-mounts (LVD/MD), stages sce_sys + appmeta + trophy data, and registers them on the home screen — no per-image command, it's fully autonomous. Newer builds add nested/compressed-PFS (.ffpfsc) containers, trophy-data copy, and a watched manual-install list. Needs kstuff-lite v1.07+ loaded first.",
    repo_host: "github.com",
    repo_owner: "drakmor",
    repo_name: "shadowMountPlus",
    asset_name_hint: "shadowmountplus",
    on_console_marker_path: "/data/shadowmount/debug.log",
    process_name_hint: "shadowmountplus",
    ports: [],
    autoload_priority: 1,
    autoload_delay_ms: 1000,
    homepage: "https://github.com/drakmor/shadowMountPlus",
  },
  {
    id: "etahen",
    display_name: "etaHEN",
    role: "Homebrew enabler + jailbreak helper",
    description: "Long-running homebrew enabler with toolbox features. Faster app jailbreak than the on-the-fly path; provides the HijackerCommand IPC many homebrew apps expect on :9028.",
    repo_host: "github.com",
    repo_owner: "LightningMods",
    repo_name: "etaHEN",
    asset_name_hint: "etaHEN",
    on_console_marker_path: null,
    process_name_hint: "etaHEN",
    ports: [9028, 2323],
    autoload_priority: 2,
    autoload_delay_ms: 500,
    homepage: "https://github.com/LightningMods/etaHEN",
  },
  {
    id: "ftpsrv",
    display_name: "ftpsrv",
    role: "FTP server payload",
    description: "Lightweight FTP server on :2121 with SELF↔ELF auto-decryption and remount-RW SITE commands. Lets you browse the PS5's filesystem from any FTP client.",
    repo_host: "github.com",
    repo_owner: "ps5-payload-dev",
    repo_name: "ftpsrv",
    asset_name_hint: "ftpsrv",
    on_console_marker_path: null,
    process_name_hint: "ftpsrv",
    ports: [2121],
    autoload_priority: 3,
    autoload_delay_ms: 200,
    homepage: "https://github.com/ps5-payload-dev/ftpsrv",
  },
  {
    id: "websrv",
    display_name: "websrv",
    role: "Web-based homebrew launcher",
    description: "HTTP server on :8080 serving a homebrew launcher page. Pairs with the homebrew bundles distributed by ps5-payload-dev.",
    repo_host: "github.com",
    repo_owner: "ps5-payload-dev",
    repo_name: "websrv",
    asset_name_hint: "websrv",
    on_console_marker_path: null,
    process_name_hint: "websrv",
    ports: [8080],
    autoload_priority: 3,
    autoload_delay_ms: 200,
    homepage: "https://github.com/ps5-payload-dev/websrv",
  },
  {
    id: "ezremote-dpi",
    display_name: "ezremote-DPI (install daemon)",
    role: "PKG install daemon",
    description: "Long-lived loopback install daemon (127.0.0.1:9040). Owns Sony's PlayGo/AppInstUtil install state machine so installs don't evaporate when the calling process exits. Sonicloader and ezremote-client both use this as their primary install path. Once installed, ps5upload's install runner will offer a 'DPI' method that proxies to it (planned for follow-up).",
    repo_host: "github.com",
    repo_owner: "cy33hc",
    repo_name: "ps5-ezremote-dpi",
    asset_name_hint: "ezremote-dpi",
    on_console_marker_path: "/data/ezremote-dpi.elf",
    process_name_hint: "ezremote-dpi",
    ports: [],
    autoload_priority: 3,
    autoload_delay_ms: 500,
    homepage: "https://github.com/cy33hc/ps5-ezremote-dpi",
  },
  {
    id: "ps5-app-dumper",
    display_name: "ps5-app-dumper",
    role: "Dump installed apps to USB",
    description: "Dumps installed PS5 apps to USB or internal storage in fakepkg/folder format. Reads config from /data/ps5-app-dumper/config.ini.",
    repo_host: "github.com",
    repo_owner: "ps5-payload-dev",
    repo_name: "ps5-app-dumper",
    asset_name_hint: "dumper",
    on_console_marker_path: null,
    process_name_hint: "dumper",
    ports: [],
    autoload_priority: 4,
    autoload_delay_ms: 200,
    homepage: "https://github.com/ps5-payload-dev/ps5-app-dumper",
  },
  {
    id: "itemzflow",
    display_name: "Itemzflow",
    role: "PS5 native homebrew launcher UI",
    description: "Full-screen native PS5 launcher for homebrew, fpkg games, and FTP browsing. Heavyweight (~50 MB) but the most polished launcher in the scene.",
    repo_host: "github.com",
    repo_owner: "LightningMods",
    repo_name: "itemzflow_PS5",
    asset_name_hint: "itemzflow",
    on_console_marker_path: null,
    process_name_hint: "itemzflow",
    ports: [],
    autoload_priority: 5,
    autoload_delay_ms: 200,
    homepage: "https://github.com/LightningMods/itemzflow_PS5",
  },
  {
    id: "shsrv",
    display_name: "shsrv (telnet shell + ELF launcher + gdb)",
    role: "42-command telnet shell + hbldr + hbdbg",
    description: "Telnet server on :2323 with 42 POSIX-ish commands (sfoinfo, file, hexdump, find with -exec, etc.) plus hbldr (launch unsigned ELF with full A/V) and hbdbg (gdb-style debugger). Our Shell tab covers the same 42 built-ins via :9114 authenticated FTX2; install shsrv if you want hbldr/hbdbg or you prefer telnet access. Connect via `telnet <ps5-ip> 2323`.",
    repo_host: "github.com",
    repo_owner: "ps5-payload-dev",
    repo_name: "shsrv",
    asset_name_hint: "shsrv",
    on_console_marker_path: null,
    process_name_hint: "shsrv.elf",
    ports: [2323],
    autoload_priority: 4,
    autoload_delay_ms: 200,
    homepage: "https://github.com/ps5-payload-dev/shsrv",
  },
  {
    id: "lapyjb",
    display_name: "Lapy JB Daemon (voidwhisper)",
    role: "Per-PID jailbreak daemon — drops etaHEN dependency",
    description: "Standalone PID-jailbreak daemon that handles app escalation directly. Apps that previously needed etaHEN's HijackerCommand IPC (Itemzflow, xplorer, anything using universalps5 PRX) just work with lapyjb running. Smaller, simpler than etaHEN — recommended over etaHEN if you only need the app-jb side.",
    repo_host: "git.etawen.dev",
    repo_owner: "voidwhisper",
    repo_name: "lapy-jb-daemon",
    asset_name_hint: "lapyjb",
    on_console_marker_path: null,
    process_name_hint: "lapyjb.elf",
    ports: [],
    autoload_priority: 3,
    autoload_delay_ms: 500,
    homepage: "https://git.etawen.dev/voidwhisper/lapy-jb-daemon",
  },
  {
    id: "np-fake-signin",
    display_name: "NP Fake Sign-in",
    role: "Offline account activation (no PSN required)",
    description: "Headless payload that registers PS5 user slots directly via the system registry. Replaces having to sign into a real PSN account just to set up local users — handy for fresh jailbreaks, secondary accounts, or test profiles. One-shot ELF: send, runs, exits.",
    repo_host: "git.etawen.dev",
    repo_owner: "earthonion",
    repo_name: "np-fake-signin",
    asset_name_hint: "np-fake-signin-ps5",
    on_console_marker_path: null,
    process_name_hint: null,
    ports: [],
    autoload_priority: 5,
    autoload_delay_ms: 200,
    homepage: "https://git.etawen.dev/earthonion/np-fake-signin",
  },
  {
    id: "garlic-worker",
    display_name: "Garlic Worker (community save processor)",
    role: "Process community save decryption jobs (opt-in)",
    description: "Background worker that drains the community save-decryption queue from garlicsaves.com. Handles both PS4 and PS5 saves natively. **Privacy notice**: connects to garlicsaves.com and processes other users' encrypted save files. Off by default — install + run manually if you want to contribute back to the community queue.",
    repo_host: "git.etawen.dev",
    repo_owner: "earthonion",
    repo_name: "garlic-worker",
    asset_name_hint: "garlic-worker-ps5",
    on_console_marker_path: null,
    process_name_hint: "garlic-worker",
    ports: [],
    autoload_priority: 6,
    autoload_delay_ms: 200,
    homepage: "https://git.etawen.dev/earthonion/garlic-worker",
  },
  {
    id: "garlic-savemgr",
    display_name: "Garlic SaveMgr (decrypt your own saves)",
    role: "Decrypt + re-encrypt your own PS5/PS4 saves",
    description: "On-console save decrypt/encrypt daemon. Lets you back up saves in plaintext, edit them on PC, and re-encrypt for the same console. No network — operates purely on saves you already own. Companion to ps5upload's Saves tab; install this for round-trip plaintext editing workflows.",
    repo_host: "git.etawen.dev",
    repo_owner: "earthonion",
    repo_name: "garlic-savemgr",
    asset_name_hint: "garlic-savemgr",
    on_console_marker_path: null,
    process_name_hint: "garlic-savemgr",
    ports: [],
    autoload_priority: 5,
    autoload_delay_ms: 200,
    homepage: "https://git.etawen.dev/earthonion/garlic-savemgr",
  },
  {
    id: "klogsrv",
    display_name: "klogsrv",
    role: "Persistent /dev/klog netcat server + rotated log",
    description: "Streams /dev/klog over TCP :3232 and tees it to /data/klog/klog.log (10-backup rotation). Useful for capturing kernel-log activity that happens while the ps5upload desktop app is closed, or for tailing klog via plain netcat without our payload.",
    repo_host: "github.com",
    repo_owner: "ps5-payload-dev",
    repo_name: "klogsrv",
    asset_name_hint: "klogsrv",
    on_console_marker_path: "/data/klog/klog.log",
    process_name_hint: "klogsrv.elf",
    ports: [3232],
    autoload_priority: 4,
    autoload_delay_ms: 200,
    homepage: "https://github.com/ps5-payload-dev/klogsrv",
  },
  {
    id: "nanodns",
    display_name: "nanoDNS",
    role: "On-console DNS server — block PSN / redirect domains",
    description: "A minimal DNS server that runs on the PS5 (UDP :53). Ships blocking PlayStation Network + update domains by default (0.0.0.0), and can redirect any domain to a LAN IP — handy for staying offline-friendly while jailbroken. Point the console's DNS at it (set bind=0.0.0.0 in the ini to serve the LAN). Config: /data/nanodns/nanodns.ini (auto-created with sane defaults). PS5 build only — never the -ps4 asset.",
    repo_host: "github.com",
    repo_owner: "drakmor",
    repo_name: "nanoDNS",
    asset_name_hint: "nanodns.elf",
    on_console_marker_path: "/data/nanodns/nanodns.ini",
    process_name_hint: "nanodns.elf",
    ports: [53],
    autoload_priority: 4,
    autoload_delay_ms: 300,
    homepage: "https://github.com/drakmor/nanoDNS",
  },
  {
    id: "ghostpad",
    display_name: "Ghostpad",
    role: "Virtual controller + input redirection",
    description: "Creates a virtual PS5 controller on the console and redirects input to it — useful for input automation, remote control, and accessibility setups. Send the payload to start it; pair it with the upstream's companion app for driving the virtual pad.",
    repo_host: "github.com",
    repo_owner: "StonedModder",
    repo_name: "Ghostpad",
    asset_name_hint: "ghostpad.elf",
    on_console_marker_path: null,
    process_name_hint: "ghostpad.elf",
    ports: [],
    autoload_priority: 4,
    autoload_delay_ms: 200,
    homepage: "https://github.com/StonedModder/Ghostpad",
  }
];

const PAYLOAD_EXT_PRIORITY = [".elf", ".bin", ".lua", ".js", ".jar"];

function extPriority(name: string): number {
  const lower = name.toLowerCase();
  for (let i = 0; i < PAYLOAD_EXT_PRIORITY.length; i++) {
    if (lower.endsWith(PAYLOAD_EXT_PRIORITY[i])) return i;
  }
  return PAYLOAD_EXT_PRIORITY.length;
}

function pickAsset(release: any, hint: string): [string, string, number] {
  if (!release.assets || release.assets.length === 0) {
    return ["", "", 0];
  }
  const lowerHint = hint.toLowerCase();

  // First pass: hint substring match with valid payload extension
  if (hint) {
    let best: [number, any] | null = null;
    for (const a of release.assets) {
      if (!a.name.toLowerCase().includes(lowerHint)) continue;
      const prio = extPriority(a.name);
      if (prio >= PAYLOAD_EXT_PRIORITY.length) continue;
      if (!best || prio < best[0]) {
        best = [prio, a];
      }
    }
    if (best) {
      const a = best[1];
      return [a.name, a.browser_download_url, a.size];
    }
  }

  // Fallback: first .elf
  for (const a of release.assets) {
    if (a.name.toLowerCase().endsWith(".elf")) {
      return [a.name, a.browser_download_url, a.size];
    }
  }

  // Archive fallback: .zip
  if (hint) {
    for (const a of release.assets) {
      const n = a.name.toLowerCase();
      if (n.endsWith(".zip") && n.includes(lowerHint)) {
        return [a.name, a.browser_download_url, a.size];
      }
    }
  }
  for (const a of release.assets) {
    if (a.name.toLowerCase().endsWith(".zip")) {
      return [a.name, a.browser_download_url, a.size];
    }
  }

  // Last resort: first asset
  const a = release.assets[0];
  return [a.name, a.browser_download_url, a.size];
}

function releaseToInfo(entry: any, release: any, cachedAgeSecs: number, refreshError?: string) {
  const [assetName, assetUrl, assetSize] = pickAsset(release, entry.asset_name_hint);
  return {
    payload_id: entry.id,
    tag: release.tag_name,
    name: release.name || release.tag_name,
    body: release.body || "",
    published_at: release.published_at || "",
    html_url: release.html_url || "",
    picked_asset_url: assetUrl,
    picked_asset_name: assetName,
    picked_asset_size: assetSize,
    prerelease: !!release.prerelease,
    cached_age_secs: cachedAgeSecs,
    refresh_error: refreshError,
  };
}

async function fetchReleases(entry: any, latestOnly: boolean): Promise<any> {
  const url = entry.repo_host === "github.com"
    ? `https://api.github.com/repos/${entry.repo_owner}/${entry.repo_name}/releases${latestOnly ? "/latest" : "?per_page=30"}`
    : `https://${entry.repo_host}/api/v1/repos/${entry.repo_owner}/${entry.repo_name}/releases${latestOnly ? "/latest" : "?limit=30"}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
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

    case "pkg_scan_external":
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
      return getJson<T>("/ps5/hw/temps", { addr: req.addr, extended: args?.extended });

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
      const a = args ?? {};
      return postJson<T>("/transfer/dir-diff-preview", {
        src_dir: a.srcDir ?? a.src_dir ?? req.src_dir ?? req.srcDir,
        dest_root: a.destRoot ?? a.dest_root ?? req.dest_root ?? req.destRoot,
        addr: a.addr ?? req.addr,
        excludes: a.excludes ?? req.excludes,
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
    case "job_status": {
      const jobId = args?.jobId ?? args?.job_id ?? args?.id ?? req.id ?? req.jobId ?? req.job_id;
      return getJson<T>(`/jobs/${jobId}`);
    }

    case "job_cancel":
    case "cancel_job": {
      const jobId = args?.jobId ?? args?.job_id ?? args?.id ?? req.id ?? req.jobId ?? req.job_id;
      return postJson<T>(`/jobs/${jobId}/cancel`);
    }

    // ── Engine logs ────────────────────────────────────────────────────────
    case "engine_logs_tail":
      return getJson<T>("/engine-logs", { since: req.since ?? 0 });

    // ── PKG install ────────────────────────────────────────────────────────
    case "pkg_metadata":
      return postJson<T>("/pkg/parse", { path: req.path ?? args?.path });

    case "pkg_metadata_split":
      return postJson<T>("/pkg/parse-split", { path: req.path ?? args?.path });

    case "ffpkg_inspect":
      return postJson<T>("/ffpkg/inspect", { path: req.path ?? args?.path });

    case "ffpkg_extract":
      return postJson<T>("/ffpkg/extract", {
        ffpkg_path: args?.ffpkgPath ?? req.ffpkg_path,
        inner_path: args?.innerPath ?? req.inner_path,
        dest_dir: args?.destDir ?? req.dest_dir,
      });

    case "pkg_install_start":
      return postJson<T>("/pkg/install/start", {
        ps5_addr: args?.ps5Addr ?? req.ps5_addr ?? req.ps5Addr,
        path: args?.path ?? req.path,
        split_root: args?.splitRoot ?? req.split_root ?? req.splitRoot,
        package_type_override: args?.packageTypeOverride ?? req.package_type_override ?? req.packageTypeOverride,
        local_ps5_path: args?.localPs5Path ?? req.local_ps5_path ?? req.localPs5Path,
        content_id: args?.contentId ?? req.content_id ?? req.contentId,
      });

    case "pkg_dpi_install":
      return postJson<T>("/pkg/dpi-install", {
        ps5_addr: args?.ps5Addr ?? req.ps5_addr ?? req.ps5Addr,
        local_ps5_path: args?.localPs5Path ?? req.local_ps5_path ?? req.localPs5Path,
      });

    case "pkg_install_status":
      return getJson<T>("/pkg/install/status", {
        session: args?.session ?? req.session,
      });

    case "pkg_install_cancel":
      return postJson<T>("/pkg/install/cancel", {
        session: args?.session ?? req.session,
      });

    // ── Payloads catalog ───────────────────────────────────────────────────
    case "payloads_catalog":
      return CATALOGUE.map(e => ({
        id: e.id,
        display_name: e.display_name,
        role: e.role,
        description: e.description,
        repo_owner: e.repo_owner,
        repo_name: e.repo_name,
        on_console_marker_path: e.on_console_marker_path,
        process_name_hint: e.process_name_hint,
        ports: e.ports,
        autoload_priority: e.autoload_priority,
        autoload_delay_ms: e.autoload_delay_ms,
        homepage: e.homepage,
      })) as T;

    case "payloads_release": {
      const entry = CATALOGUE.find(e => e.id === args?.id);
      if (!entry) throw new Error(`unknown payload id: ${args?.id}`);
      try {
        const release = await fetchReleases(entry, true);
        return releaseToInfo(entry, release, 0) as T;
      } catch (e: any) {
        console.warn(`Failed to fetch latest release for ${args?.id}:`, e);
        return {
          payload_id: entry.id,
          tag: "v1.0.0",
          name: "v1.0.0 (Offline Mock)",
          body: "Offline mode. Unable to fetch release notes from GitHub.",
          published_at: new Date().toISOString(),
          html_url: entry.homepage,
          picked_asset_url: "",
          picked_asset_name: `${entry.asset_name_hint || entry.id}.elf`,
          picked_asset_size: 0,
          prerelease: false,
          cached_age_secs: 0,
          refresh_error: e.message || String(e),
        } as T;
      }
    }

    case "payloads_releases": {
      const entry = CATALOGUE.find(e => e.id === args?.id);
      if (!entry) throw new Error(`unknown payload id: ${args?.id}`);
      try {
        const releases = await fetchReleases(entry, false);
        return (releases.map((r: any) => releaseToInfo(entry, r, 0))) as T;
      } catch (e: any) {
        console.warn(`Failed to fetch releases list for ${args?.id}:`, e);
        return [{
          payload_id: entry.id,
          tag: "v1.0.0",
          name: "v1.0.0 (Offline Mock)",
          body: "Offline mode. Unable to fetch releases from GitHub.",
          published_at: new Date().toISOString(),
          html_url: entry.homepage,
          picked_asset_url: "",
          picked_asset_name: `${entry.asset_name_hint || entry.id}.elf`,
          picked_asset_size: 0,
          prerelease: false,
          cached_age_secs: 0,
          refresh_error: e.message || String(e),
        }] as T;
      }
    }

    case "payloads_local_inventory":
      return lsGet<T>("payloads_local_inventory", [] as T);

    case "payloads_local_path": {
      const inventory = lsGet<any[]>("payloads_local_inventory", []);
      const item = inventory.find(i => i.payload_id === args?.id);
      return (item?.path || null) as T;
    }

    case "payloads_download": {
      const entry = CATALOGUE.find(e => e.id === args?.id);
      if (!entry) throw new Error(`unknown payload id: ${args?.id}`);
      const inventory = lsGet<any[]>("payloads_local_inventory", []);
      const newEntry = {
        payload_id: entry.id,
        version: args?.version || "v1.0.0",
        path: `mock_cache://${entry.id}/${entry.asset_name_hint || entry.id}.elf`,
        size: 1024 * 1024,
        mtime: Math.floor(Date.now() / 1000),
      };
      const filtered = inventory.filter(i => i.payload_id !== entry.id);
      filtered.push(newEntry);
      lsSet("payloads_local_inventory", filtered);
      return newEntry as T;
    }

    // ── FAQ + changelog content ────────────────────────────────────────────
    case "faq_load":
      return faqMarkdown as T;

    case "changelog_load":
      return changelogMarkdown as T;

    // ── Local filesystem (browses container FS in web mode) ───────────────
    case "local_list_dir":
      return getJson<T>("/local-fs/list-dir", { path: req.path ?? args?.path });

    case "local_storage_roots":
      return getJson<T>("/local-fs/roots");

    case "storage_access_granted":
      return true as T;

    case "request_storage_access":
      return undefined as T;

    case "path_kind":
      return { kind: "folder" } as T;

    case "inspect_folder":
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

    // ── Stubs / Mocks for remaining Tauri commands ─────────────────────────
    case "dpi_ensure":
      return { ok: false, listening: false, sent: false, error: "DPI check not supported in web mode" } as T;

    case "payload_bundled_path":
      return { ok: false, error: "not_supported_in_web_mode" } as T;

    case "payload_probe":
      return { is_ps5upload: false, code: "payload_probe_not_supported" } as T;

    case "payload_send":
      console.warn("[web-mode] payload_send is not supported in web mode. Send ELF manually.");
      return { ok: false, status: "not_supported_in_web_mode" } as T;

    case "heal_appmeta":
      return {
        title_id: args?.titleId ?? req.title_id ?? "",
        appmeta_dir: `/user/appmeta/${args?.titleId ?? req.title_id ?? ""}`,
        source_dir: args?.sourcePath ?? req.source_path ?? "",
        outcomes: [],
        copied: 0,
        already_present: 0,
        errors: 0,
      } as T;

    case "smp_status":
      return {
        installed: false,
        running: false,
        config_ini: null,
        autotune_ini: null,
        debug_log_tail: null,
        mounted_images: [],
        errors: [],
      } as T;

    case "usb_list_removable":
      return [] as T;

    case "usb_autoloader_install":
      return { ok: false, error: "USB autoloader is not supported in web mode." } as T;

    case "power_reboot":
    case "power_shutdown":
    case "power_standby":
    case "power_tick":
      return { ok: false, err: "Power control is not supported in web mode" } as T;

    case "power_telemetry_get":
      return {
        operating_seconds: null,
        boot_cycles: null,
        thermal_alert_flags: null,
        power_up_cause: null,
      } as T;

    case "user_list_get":
      return {
        foreground: -1,
        err_fg: 0,
        err_list: 0,
        users: [],
      } as T;

    case "saves_list":
      return { saves: [] } as T;

    case "screenshots_list":
      return { items: [] } as T;

    case "screenshot_convert":
      return { ok: false, error: "Screenshot conversion is not supported in web mode." } as T;

    case "save_archive_make_temp":
    case "save_archive_cleanup_temp":
    case "save_archive_zip":
    case "save_archive_unzip":
    case "save_archive_backup_finalize":
    case "save_archive_restore_prepare":
      return {} as T;

    case "save_text_file":
    case "read_text_file":
      return "" as T;

    case "crash_reports_stats":
      return { total: 0, sizes: 0 } as T;

    case "crash_reports_dir_resolved":
      return "mock_dir" as T;

    case "crash_reports_zip":
      return "" as T;

    case "crash_reports_clear":
    case "crash_reports_open_dir":
      return undefined as T;

    case "diag_log_read_window":
      return [] as T;

    case "diag_log_stats":
      return { total: 0, size: 0 } as T;

    case "diag_log_clear":
    case "diag_log_open_dir":
      return undefined as T;

    case "bug_report_build":
      return { zip_path: "", error: "Bug report bundle creation is not supported in web mode." } as T;

    case "screenshot_save":
    case "screenshot_list":
      return [] as T;

    case "screenshot_delete":
    case "screenshot_clear":
    case "screenshot_open_dir":
      return undefined as T;

    case "fs_index_start":
    case "fs_index_status":
    case "fs_search_index":
    case "fs_index_cancel":
      return {} as T;

    case "app_suspend":
    case "app_resume":
    case "app_kill":
      return undefined as T;

    case "app_list_running":
      return { ok: true, apps: [] } as T;

    case "toast_push":
      return undefined as T;

    case "klog_chunk":
      return [] as T;

    case "net_interfaces_get":
      return { interfaces: [] } as T;

    case "peripheral_eject":
    case "peripheral_bd_off":
    case "peripheral_bd_on":
    case "peripheral_usb_off":
    case "peripheral_usb_on":
      return undefined as T;

    case "proc_modules_get":
      return { modules: [] } as T;

    case "proc_list_get":
      return { ok: true, procs: [] } as T;

    case "crc32_file_get":
      return { crc32: 0 } as T;

    case "appdb_query_get":
      return { apps: [] } as T;

    case "net_speed_test_run":
      return { ok: false, error: "Net speed test is not supported in web mode." } as T;

    case "pkg_direct_mount_run":
    case "ufs_fsck_run":
    case "lwfs_mount_run":
      return { ok: false, error: "Not supported in web mode." } as T;

    case "fs_write_bytes_run":
      return { ok: false, error: "Writing bytes directly not supported in web mode." } as T;

    case "fs_blake3_hash":
      return { path: req.path ?? "", size: 0, hash: "" } as T;

    case "keep_awake_set":
    case "keep_awake_state":
      return { enabled: false } as T;

    case "user_config_path_resolved":
      return "LocalStorage (web mode)" as T;

    case "app_data_reset": {
      const keys = ["upload_queue", "payload_playlists", "user_config", "payloads_local_inventory"];
      for (const k of keys) {
        localStorage.removeItem(`ps5upload:${k}`);
      }
      return 4 as T;
    }

    case "update_download":
      return undefined as T;

    case "title_meta_fetch":
      return { title: null, cover_url: null } as T;

    // ── Persistence / config fallbacks ────────────────────────────────────
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
        expires: Date.now() + 24 * 60 * 60 * 1000,
      });
      return undefined as T;
    }

    case "resume_txid_forget": {
      const key = `resume:${req.host}:${req.src}:${req.dest}`;
      lsRemove(key);
      return undefined as T;
    }

    case "user_config_load":
      return lsGet<T>("user_config", {} as T);

    case "user_config_save":
      lsSet("user_config", args?.config ?? args?.doc);
      return undefined as T;

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

    case "shell_run_cmd": {
      const a = args ?? {};
      return postJson<T>("/ps5/shell", {
        addr: a.addr ?? req.addr,
        cmd: a.cmd ?? req.cmd,
        session_id: a.sessionId ?? a.session_id ?? req.session_id ?? req.sessionId,
        cwd: a.cwd ?? req.cwd,
        timeout_secs: a.timeoutSecs ?? a.timeout_secs ?? req.timeout_secs ?? req.timeoutSecs,
      });
    }

    case "send_notification":
    case "notify":
      return undefined as T;

    case "keep_awake_acquire":
    case "keep_awake_release":
      return undefined as T;

    case "diag_log_append":
    case "diag_log_rotate":
    case "crash_report_save":
      return undefined as T;

    case "save_window_state":
    case "restore_window_state":
    case "set_window_title":
      return undefined as T;

    default:
      console.error(`[webInvoke] Unknown command: "${cmd}"`, args);
      throw new Error(`webInvoke: unhandled command "${cmd}"`);
  }
}

if (typeof window !== "undefined") {
  (window as any).__TAURI_INVOKE__ = webInvoke;
}
