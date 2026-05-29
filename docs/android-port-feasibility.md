# ps5upload on Android — Feasibility & Design Spike

> Status: **design spike** (no code committed yet). Produced 2026-05-28.
> Decision context: this reverses the 2026-04-18 "no mobile client" call.
> Goal agreed with maintainer: **full feature parity with the desktop client**
> (including uploads), **reusing the existing React UI** via **Tauri v2 Android**.

This document is the grounded plan: what ports for free, what needs real work,
the hard product caveat (where do the files come from on a phone?), a
feature-by-feature parity table, a responsive-UI plan so nothing is cut off, the
build/signing pipeline, and a phased roadmap. It is meant to be read before any
Android code is written.

---

## 1. Verdict

**Feasible, with moderate-to-significant rework, best delivered in phases.**

The UI and the entire Tauri-command + engine-endpoint surface port largely for
free. The real work concentrates in **four** areas, in rough order of effort:

1. **Engine runtime model** — replace "spawn a sidecar binary" with "run the
   engine in-process." (Mechanical but central.)
2. **File access for uploads** — Android has no real filesystem paths for
   user content; everything goes through the Storage Access Framework (SAF).
   Single-file uploads (`.zip` / `.pkg`) are very doable; **game-*folder*
   uploads are the genuine hard gap.**
3. **Responsive UI** — the desktop layout assumes a wide window and a fixed
   240px sidebar. A mobile navigation pattern + breakpoints are needed so
   "nothing is cut off."
4. **Platform APIs** — keep-awake, window-state, drag-drop, USB enumeration,
   mDNS discovery each need an Android path or graceful no-op.

None of these is a dead end. The single biggest *product* question is #2 (folder
uploads), not any technical blocker.

---

## 2. Architecture: today vs. Android

### Desktop (today)

```
┌─────────────────────────────────────────────┐         ┌─────────────┐
│ PS5Upload.app (Tauri desktop)                │   LAN   │   PS5       │
│                                              │  TCP    │  (payload)  │
│  React UI ──invoke()──▶ Tauri commands ──┐   │ 9113/   │             │
│  (client/src)          (src-tauri)       │   │ 9114    │             │
│                                          ▼   │ ◀─FTX2─▶ │             │
│                            reqwest → 127.0.0.1:19113    │             │
│                                          │   │         │             │
│                        ┌─────────────────▼─┐ │         │             │
│                        │ engine SIDECAR    │─┼─────────┤             │
│                        │ (spawned child    │ │         │             │
│                        │  process, Axum)   │ │         │             │
│                        └───────────────────┘ │         │             │
└─────────────────────────────────────────────┘         └─────────────┘
```

The engine is a **separate binary**, embedded via `include_bytes!`, extracted to
`app_local_data_dir()/engine/`, and **spawned as a child process** (see
`client/src-tauri/src/engine.rs:409`). The frontend never talks to it directly —
it calls `invoke()`, the Tauri command does a `reqwest` to `http://127.0.0.1:19113`.

### Android (target)

```
┌─────────────────────────────────────────────┐         ┌─────────────┐
│ PS5Upload.apk (Tauri Android, one process)   │  WiFi   │   PS5       │
│                                              │  TCP    │  (payload)  │
│  React UI ──invoke()──▶ Tauri commands ──┐   │ 9113/   │             │
│  (UNCHANGED)           (UNCHANGED)        │  │ 9114    │             │
│                                          ▼   │ ◀─FTX2─▶ │             │
│                       reqwest → 127.0.0.1:PORT (in-proc)│             │
│                                          │   │         │             │
│                        ┌─────────────────▼─┐ │         │             │
│                        │ engine as a TOKIO │─┼─────────┤             │
│                        │ TASK (same Axum,  │ │         │             │
│                        │  in-process)      │ │         │             │
│                        └───────────────────┘ │         │             │
└─────────────────────────────────────────────┘         └─────────────┘
```

**Key:** the port `19113` is *what runs the server*, not *where it lives*. On
Android we start the engine's Axum server as an **in-process tokio task** bound
to loopback at app startup, instead of spawning a binary. The `api/` layer and
all Tauri command handlers keep hitting localhost and need **no change**.

The phone must be on the **same WiFi/LAN as the PS5** — same as the desktop tool
talking to the console over the network.

---

## 3. Feasibility by layer

| Layer | Verdict | Notes |
|---|---|---|
| React UI (rendering) | 🟢 reuse | Runs in the Android WebView; same components. |
| `invoke()` IPC | 🟢 reuse | Tauri mobile supports commands/invoke natively. |
| Tauri commands (network proxies) | 🟢 reuse | ~90 of the 145 commands are pure PS5-network proxies → zero change once engine is in-process. |
| Engine HTTP endpoints (45+) | 🟢 reuse | Same Axum routes; runs in-process. |
| TLS / HTTPS (updates, title-meta) | 🟢 reuse | Already `rustls-tls` (`client/src-tauri/Cargo.toml:35`) — cross-compiles to Android cleanly, **no OpenSSL pain**. |
| Engine startup (spawn → in-proc) | 🟡 rework | `engine.rs` spawn/embed/extract path → in-process `serve()` task under `#[cfg(mobile)]`. |
| File access for uploads | 🟡→🔴 rework | Single-file via SAF: doable. **Folder uploads: hard.** See §5. |
| Responsive layout | 🟡 rework | Fixed 240px sidebar, no `sm:` breakpoints, overflowing tables/toolbars. See §6. |
| Keep-awake | 🟡 rework | `caffeinate`/`systemd-inhibit`/Win32 → Android `WAKE_LOCK` / `KeepScreenOn`. |
| Window-state persistence | 🟢 trivial | No-op on mobile (already `try/catch`-guarded in `windowState.ts`). |
| Drag-and-drop | 🟢 trivial | Hide; not applicable on touch. |
| mDNS discovery | 🟡 rework | `mdns-sd` works but needs Android `INTERNET`+`CHANGE_WIFI_MULTICAST_STATE` perms + a multicast lock. |
| USB autoloader | 🔴 / defer | Android has no removable-drive mount enumeration; SAF tree or `UsbManager`. Likely **hide on mobile** initially. |
| Build / signing pipeline | 🟡 setup | New APK/AAB flow, keystore, CI leg. See §7. |

---

## 4. The engine: sidecar → in-process

This is the central change. Today (`client/src-tauri/src/engine.rs`):

- `include_bytes!(env!("PS5UPLOAD_ENGINE_BYTES"))` embeds the binary (line 40)
- extracted to `app_local_data_dir()/engine/` and `chmod 0o755` (lines 70–112)
- spawned via `tokio::process::Command` with stdin-EOF parent-watch + `kill_on_drop` (lines 409–452)
- engine `main()` is `#[tokio::main]`, binds `0.0.0.0:19113` (`engine/.../main.rs:4112`)

**Plan:**

1. Refactor the engine's `main()` into a library entry point, e.g.
   `ps5upload_engine::serve(ServeOpts { bind, ps5_addr, .. }) -> JoinHandle`.
   Desktop's `main.rs` becomes a thin wrapper that parses argv/env and calls it.
2. In `src-tauri`, gate the startup path:
   - `#[cfg(desktop)]` → existing spawn-the-sidecar path (unchanged).
   - `#[cfg(mobile)]` → call `serve()` on a **loopback** bind with an **OS-assigned
     ephemeral port** (Android discourages fixed ports), then point
     `engine::url()` at the chosen port.
3. Bind to `127.0.0.1:0`, read back the actual port, store it for `engine::url()`.
   (Drop the `0.0.0.0` bind and the orphan-reaper / parent-watch machinery on
   mobile — there's no second process.)
4. Drop `tauri_plugin_shell` engine usage on mobile; remove embed/extract.

**De-risked because:** the engine is already a clean Rust workspace
(`ps5upload-core` + `ps5upload-engine`), uses `tokio` + `axum` + `rustls`
(all Android-friendly), and the loopback-guard (`127.0.0.1`/`::1` only) is exactly
right for an in-process server. Cross-compile targets: `aarch64-linux-android`
(primary), `armv7-linux-androideabi` (older devices), `x86_64-linux-android`
(emulator).

**Watch items:** `std::process::exit()` calls in `main.rs` (3962/3972/4157) must
not live in the `serve()` library path; temp-dir / file-path assumptions in
`save_archive.rs` & friends (see §5); blake3 SIMD has an Android NEON path
(fine on aarch64).

---

## 5. File access & uploads (the real product question)

The desktop tool's core job is pushing **multi-GB dumps from local disk** to the
PS5. On Android, user content is **not** addressable by filesystem path — it comes
through the **Storage Access Framework (SAF)** as `content://` URIs.

What we learned:

- The Tauri **dialog** plugin's file picker returns `content://` URIs on Android,
  and the **fs** plugin can read them. → **single-file** picking works.
- There is **no first-party folder picker**; `ACTION_OPEN_DOCUMENT_TREE` returns a
  *tree URI*, and Android exposes two non-interchangeable URIs per directory
  ([open Tauri issue #14587](https://github.com/tauri-apps/tauri/issues/14587)).
  Community plugins exist ([tauri-plugin-android-fs](https://github.com/aiueo13/tauri-plugin-android-fs),
  [file-picker-android](https://github.com/Berrysoft/file-picker-android)).

**Implications, mapped to the upload features:**

| Upload type | Android path | Difficulty |
|---|---|---|
| `.zip` game dump | SAF file picker → stream `content://` into the engine's `transfer_zip` (it already decompresses host-side and streams) | 🟡 Moderate — feed the engine a reader from a content URI / fd instead of a `File` |
| `.pkg` / `.ffpkg` install | SAF file picker → existing `pkg_install` / `ffpkg` paths over a fd | 🟡 Moderate |
| Single file (`payload_send`, etc.) | SAF file picker → fd | 🟡 Moderate |
| **Game *folder* upload** (`transfer_dir`) | SAF tree URI; engine must walk the tree via Android `DocumentsContract` instead of `std::fs::read_dir` over a real path | 🔴 Hard — biggest parity gap |
| Save/screenshot **download** to phone | SAF `ACTION_CREATE_DOCUMENT` → write to a content URI | 🟡 Moderate |

**Recommendation:** treat folder uploads as a **dedicated phase**. The realistic
sequence is: (a) all PS5-side management first (no local files), (b) single-file
uploads (`.zip`/`.pkg`) via SAF — which covers most "compressed dump" workflows,
then (c) folder uploads via a SAF-tree walker in the engine. `.zip` uploads are
the pragmatic mobile answer to "I have a game dump on my phone/SD card."

---

## 6. Responsive UI plan — "nothing cut off, everything looks perfect"

The UI is reusable but desktop-shaped. Findings + the plan to make it phone-perfect
at ~390px:

**Navigation (critical):**
- `Sidebar.tsx:140` is `w-60 shrink-0` (240px fixed) — ~62% of a 390px screen.
  → Replace with a responsive pattern: **slide-in drawer (hamburger)** for the
  20-item nav, or a **bottom tab bar** for the 5 top sections with the rest in a
  "More" sheet. Sidebar stays as-is on `md:`+ (desktop/tablet).
- `ActivityBar` / `StatusBar` are flex-based → mostly fine; tighten spacing and
  allow wrap on narrow widths.

**Layout offenders to fix (add mobile-first breakpoints):**
- The codebase uses `md:`/`lg:`/`xl:` but **zero `sm:`** and no mobile-first base.
  Adopt: single-column by default, columns at `sm:`/`md:`+.
- `Logs/KernelLogPanel` hard-codes `grid-cols-2` on mobile → make 1-col `< sm`.
- `Hardware/NetworkPanel` 4-col `<table>` → wrap in `overflow-x-auto` (or card-ify rows).
- Markdown tables (FAQ/Changelog) → `overflow-x-auto` wrapper.
- Library/FileSystem/Payloads **row toolbars** (5–7 buttons) → collapse all but the
  primary action into the existing `OverflowMenu`.
- Connection/Settings/Search **inline label+input** → `flex-col` under `sm`.
- Bump the densest text (`text-[10px]`/`text-xs`) up a step on small screens.

**Touch:**
- No right-click reliance (good — actions are in `OverflowMenu` buttons already).
- Ensure tap targets ≥ 44px; remove hover-only affordances.
- Drag-drop handlers: hide the "drop a file" hint on mobile, show a picker button.

**Definition of done for "perfect":** every screen at 360/390/430px wide with no
horizontal scroll except where intentional (`overflow-x-auto` tables/logs), no
clipped text, tap targets ≥ 44px, drawer/bottom-nav reachable one-handed.

---

## 7. Build, signing & release pipeline

**Local toolchain status (this machine):**
- `tauri-cli 2.10.1` ✅
- `ANDROID_HOME` set (`~/Library/Android/sdk`) ✅; NDK 28 & 29 installed ✅
- `NDK_HOME` / `ANDROID_NDK_HOME` **unset** ⚠️ (point at e.g. `$ANDROID_HOME/ndk/28.0.12916984`)
- JDK: **broken** ⚠️ — the `jenv` shim errors (`libexec` missing). Need a working
  **JDK 17** (Android Studio bundles one under `.../Android Studio.app/Contents/jbr`).
- Rust Android targets: **none installed** ⚠️ → `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`

**Steps once toolchain is fixed:**
1. `cargo tauri android init` — generates `src-tauri/gen/android/` (Gradle project).
2. `cargo tauri android dev` — debug build, runs in emulator/device with debug signing.
3. Release signing: `keytool -genkeypair -keystore release-key.jks ...`, then a
   `src-tauri/gen/android/keystore.properties` (kept **out** of git). Tauri auto-signs.
4. `cargo tauri android build` → APK (sideload/test) and AAB (Google Play).
5. Min SDK 24 (Android 7.0); use **NDK 28+** for Google's 16 KB page-size alignment.

**Release pipeline:** a **separate** flow from the desktop `publish.yml` (different
artifacts, signing secrets, possibly Play upload). Reuses `VERSION` as the source
of truth (`update-version.js` would also need to stamp the Android
`tauri.conf.json` / Gradle `versionCode`). The `identifier` is already
`com.phantomptr.ps5upload` — reusable as the Android package id.

References: [Tauri sidecar = desktop only](https://v2.tauri.app/develop/sidecar/),
[Prerequisites](https://v2.tauri.app/start/prerequisites/),
[Android signing](https://v2.tauri.app/distribute/sign/android/),
[Google Play](https://v2.tauri.app/distribute/google-play/).

---

## 8. Feature-by-feature parity (all 24 screens)

🟢 ports with little/no change · 🟡 needs responsive/SAF/platform work · 🔴 hard/deferred

| Screen / area | Status | Notes |
|---|---|---|
| Whats-New / Changelog / FAQ / About | 🟢 | Markdown views; wrap tables in `overflow-x-auto`; external links via opener. |
| Connection (host setup, send payload) | 🟡 | Form `flex-col`; "send payload" picks an ELF via SAF. |
| Dashboard | 🟡 | Grid already stacks; tighten card text. |
| Library (browse, launch, mount, register) | 🟡 | Row toolbar → OverflowMenu; grid stacks. All PS5-side ops port free. |
| Search | 🟡 | Input + filters `flex-col`. |
| Volumes / Disk Usage | 🟡 | Card/tree layouts; minor responsive. |
| File System explorer | 🟡 | Breadcrumb collapse; bulk-action toolbar → menu. Ops port free. |
| Hardware (temps/power/fan/net) | 🟡 | Sensor grid stacks; NetworkPanel table → scroll wrapper. |
| Saves / Screenshots | 🟡 | List ports free; download-to-phone via SAF `CREATE_DOCUMENT`. |
| Stats / Activity / Audit-Log / Logs / Shell | 🟡 | Lists/tables → responsive; all PS5-side. |
| Settings / First-Run | 🟡 | Form rows `flex-col`; keep-awake toggle → WakeLock. |
| Payloads (catalog + send + playlists) | 🟡 | Catalog/download port free; "send" + playlist load via SAF. |
| **Upload — `.zip`** | 🟡 | SAF file pick → stream into `transfer_zip`. **The mobile-native upload path.** |
| **Upload — `.pkg`/`.ffpkg` install** | 🟡 | SAF file pick → existing install/inspect flows. |
| **Upload — game *folder*** | 🔴 | SAF tree walk in the engine. Deferred to a dedicated phase. |
| USB Autoloader | 🔴 | No removable-drive enumeration on Android; hide on mobile initially. |

PS5-side management (status, fs ops, hardware, time, SMP, app lifecycle,
diagnostics, power, search index) is the bulk of the 45 endpoints and **all of it
ports for free** once the engine runs in-process.

---

## 9. Phased roadmap

- **Phase 0 — Scaffolding spike (small):** fix JDK 17 + `NDK_HOME`, add Rust
  Android targets, `cargo tauri android init`, refactor engine `main()`→`serve()`
  + in-process `#[cfg(mobile)]` startup, get the app to **launch in the emulator
  and reach a PS5** (status read). Proves the architecture end-to-end.
- **Phase 1 — Management companion (full PS5-side parity):** all browse/manage/
  monitor/diagnostics/power/saves-list screens + responsive navigation (drawer/
  bottom-nav) + the responsive sweep so nothing is cut off. No local-file uploads.
- **Phase 2 — Single-file uploads:** SAF integration for `.zip` / `.pkg` /
  `payload_send` + save/screenshot download-to-phone. Covers the "compressed dump"
  workflow.
- **Phase 3 — Folder uploads & remaining parity:** SAF-tree walker in the engine
  (`transfer_dir`), USB-autoloader decision. True full parity.
- **Phase 4 — Polish & store:** keep-awake/WakeLock, perf on large transfers,
  background-transfer behavior, signing/CI, Play listing.

---

## 10. Risks & open questions

- **Folder uploads (Phase 3)** are the only item without a clean, proven path —
  needs a SAF-tree walker or a community plugin; budget spike time.
- **Background transfers:** a multi-GB upload while the screen sleeps needs a
  foreground service + WakeLock; Tauri mobile's lifecycle story here needs validation.
- **JDK/toolchain** must be repaired before any build (broken `jenv`).
- **mDNS on Android** needs a multicast lock + permissions; manual-IP entry is the
  fallback (already supported).
- **Maintenance cost** — a second release pipeline + platform code, exactly the
  cost the 2026-04-18 note flagged. Phasing keeps each step shippable.

---

## 11. Recommended next step

Execute **Phase 0** as the concrete continuation of this spike: repair the
toolchain, add targets, run `cargo tauri android init`, do the engine
`main()`→`serve()` refactor behind `#[cfg(mobile)]`, and get the app launching in
an emulator and reading PS5 status. That single milestone validates the riskiest
assumption (in-process engine) before investing in the responsive sweep and SAF work.
