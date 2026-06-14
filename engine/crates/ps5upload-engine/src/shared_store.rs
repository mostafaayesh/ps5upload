//! Versioned, durable document store for the engine's *shared* state.
//!
//! In the Docker / web deployment the engine is the single process every
//! browser talks to, so state that should be the same for all users lives
//! here instead of each browser's `localStorage`. The desktop Tauri build
//! keeps its own per-machine file persistence and does not use this module.
//!
//! ## Storage
//!
//! Documents are held in an `Arc<Mutex<HashMap<key, (value, version)>>>` for
//! fast in-memory access. On every mutation the document is atomically written
//! to a JSON file in the state directory (temp → fsync → rename, same pattern
//! as `commands/persistence.rs`) so state survives a container restart.  On
//! startup all known files in the directory are loaded back in.
//!
//! ## Optimistic concurrency
//!
//! Every document carries a monotonic `version`. A reader gets the value plus
//! its version (surfaced to HTTP clients as an `ETag`). A writer may supply
//! the version it last saw as `expected`; the write only commits when the
//! live version still matches, otherwise [`PutError::Conflict`] is returned
//! (HTTP 409). Omitting `expected` retains the original last-write-wins
//! behavior so un-migrated clients continue to work.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;

// ─── Public types ─────────────────────────────────────────────────────────────

/// A document plus the version it was read at.
#[derive(Debug, Clone)]
pub struct Doc {
    pub value: Value,
    pub version: i64,
}

/// Why a [`SharedStore::put`] failed.
#[derive(Debug)]
pub enum PutError {
    /// The caller's `expected` version no longer matches the stored one.
    /// `current` is the live version so the HTTP layer can hand it back.
    Conflict { current: i64 },
    /// I/O or serialization failure.
    Io(String),
}

impl std::fmt::Display for PutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PutError::Conflict { current } => write!(f, "version conflict (current={current})"),
            PutError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

// ─── SharedStore ──────────────────────────────────────────────────────────────

struct Inner {
    docs: HashMap<String, (Value, i64)>,
    state_dir: Option<PathBuf>,
    tmp_seq: u64,
}

/// Process-wide handle to the shared-state store.
pub struct SharedStore {
    inner: Mutex<Inner>,
}

impl SharedStore {
    /// Create (or re-open) a store backed by `state_dir`.
    /// Any `<key>.json` files already in the directory are loaded on startup
    /// so that state persists across container restarts.
    pub fn open(state_dir: &Path) -> Result<Arc<Self>, String> {
        if let Err(e) = std::fs::create_dir_all(state_dir) {
            return Err(format!("create state dir {:?}: {e}", state_dir));
        }
        let mut docs: HashMap<String, (Value, i64)> = HashMap::new();
        // Load every <key>.json file present in the directory.
        if let Ok(rd) = std::fs::read_dir(state_dir) {
            for entry in rd.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if stem.is_empty() {
                    continue;
                }
                if let Ok(raw) = std::fs::read(&path) {
                    if let Ok(envelope) = serde_json::from_slice::<serde_json::Map<String, Value>>(&raw) {
                        if let (Some(v), Some(ver)) = (
                            envelope.get("value").cloned(),
                            envelope.get("version").and_then(|v| v.as_i64()),
                        ) {
                            docs.insert(stem, (v, ver));
                        }
                    }
                }
            }
        }
        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                docs,
                state_dir: Some(state_dir.to_path_buf()),
                tmp_seq: 0,
            }),
        }))
    }

    /// Create an ephemeral in-memory-only store (no disk writes). Used in
    /// tests and as a last-resort fallback when the state directory is not
    /// writable (state is non-durable but endpoints still work).
    pub fn open_in_memory() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                docs: HashMap::new(),
                state_dir: None,
                tmp_seq: 0,
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Read `key`. Returns `default` at version 0 when the key is absent.
    pub fn get(&self, key: &str, default: Value) -> Doc {
        let g = self.lock();
        match g.docs.get(key) {
            Some((v, ver)) => Doc { value: v.clone(), version: *ver },
            None => Doc { value: default, version: 0 },
        }
    }

    /// Write `key`. With `expected = Some(v)` the write is compare-and-swap:
    /// commits only when the stored version equals `v`, else [`PutError::Conflict`].
    /// With `expected = None` it is an unconditional last-write-wins replace.
    /// Returns the new (incremented) version on success.
    pub fn put(&self, key: &str, value: &Value, expected: Option<i64>) -> Result<i64, PutError> {
        let mut g = self.lock();
        let current = g.docs.get(key).map(|(_, v)| *v).unwrap_or(0);
        if let Some(exp) = expected {
            if exp != current {
                return Err(PutError::Conflict { current });
            }
        }
        let next = current + 1;
        g.docs.insert(key.to_string(), (value.clone(), next));
        if let Some(dir) = &g.state_dir.clone() {
            let path = dir.join(format!("{key}.json"));
            let envelope = serde_json::json!({"version": next, "value": value});
            let seq = g.tmp_seq;
            g.tmp_seq += 1;
            drop(g); // release lock before I/O
            // Best-effort atomic write; a failure is logged by the caller.
            if let Err(e) = write_atomic(&path, &envelope, seq) {
                eprintln!("[shared-store] write {key}: {e}");
            }
        }
        Ok(next)
    }

    /// Append `entry` to the JSON array stored at `key`, trimming the oldest
    /// entries so the array never exceeds `cap`. Seeds an empty array on first
    /// use. Always succeeds (no conflict check). Returns the resulting `Doc`.
    pub fn append(&self, key: &str, entry: Value, cap: usize) -> Doc {
        let mut g = self.lock();
        let (mut items, current) = match g.docs.get(key) {
            Some((v, ver)) => (v.as_array().cloned().unwrap_or_default(), *ver),
            None => (Vec::new(), 0),
        };
        items.push(entry);
        if items.len() > cap {
            let excess = items.len() - cap;
            items.drain(..excess);
        }
        let value = Value::Array(items);
        let next = current + 1;
        g.docs.insert(key.to_string(), (value.clone(), next));
        if let Some(dir) = &g.state_dir.clone() {
            let path = dir.join(format!("{key}.json"));
            let envelope = serde_json::json!({"version": next, "value": &value});
            let seq = g.tmp_seq;
            g.tmp_seq += 1;
            drop(g);
            if let Err(e) = write_atomic(&path, &envelope, seq) {
                eprintln!("[shared-store] append {key}: {e}");
            }
        }
        Doc { value, version: next }
    }
}

// ─── Atomic file write ────────────────────────────────────────────────────────

/// Write `value` to `path` atomically: write to a unique tmp path, fsync,
/// then rename. A crash mid-write leaves at most a tmp file — the live
/// file is never partially overwritten. Matches the pattern in
/// `commands/persistence.rs`.
fn write_atomic(path: &Path, value: &Value, seq: u64) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension(format!("json.tmp.{seq}"));
    let bytes = serde_json::to_vec(value).map_err(|e| format!("serialize: {e}"))?;
    let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create {tmp:?}: {e}"))?;
    f.write_all(&bytes).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write {tmp:?}: {e}")
    })?;
    f.sync_all().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("fsync {tmp:?}: {e}")
    })?;
    drop(f);
    // On Windows, `rename` fails if the target already exists; use
    // `replace_file` (which calls `ReplaceFileW` / `rename` as appropriate).
    replace_file(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename {tmp:?} -> {path:?}: {e}")
    })
}

/// Atomically replace `dest` with `src`. On Linux (inside Docker) `rename` is
/// atomic even when `dest` exists. On Windows, rename fails if the destination
/// exists so we remove it first (same pattern as `commands/mod.rs`).
fn replace_file(src: &Path, dest: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(first_err) if dest.exists() => {
            std::fs::remove_file(dest)?;
            std::fs::rename(src, dest).map_err(|e| {
                std::io::Error::new(
                    e.kind(),
                    format!("replace retry failed: {e}; initial: {first_err}"),
                )
            })
        }
        Err(e) => Err(e),
    }
    #[cfg(not(windows))]
    std::fs::rename(src, dest)
}

// ─── DB path resolution ───────────────────────────────────────────────────────

/// Resolve where the shared-state directory lives.
///
/// Priority:
///  1. `PS5UPLOAD_STATE_DIR` env var — explicit override.
///  2. `/var/log/ps5upload/shared-state` — the Docker volume already mounted
///     in the shipped compose file; existing deployments get durability with
///     no config change.
///  3. OS temp dir — last resort (non-durable, a warning is logged).
pub fn resolve_state_dir() -> PathBuf {
    if let Ok(v) = std::env::var("PS5UPLOAD_STATE_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    let volume = Path::new("/var/log/ps5upload/shared-state");
    // Only use the volume path if the *parent* `/var/log/ps5upload` already
    // exists and is writable (i.e., the bind-mount is in place).
    let parent = Path::new("/var/log/ps5upload");
    if parent.is_dir() {
        let probe = parent.join(".write-probe");
        if std::fs::write(&probe, b"").is_ok() {
            let _ = std::fs::remove_file(&probe);
            return volume.to_path_buf();
        }
    }
    std::env::temp_dir().join("ps5upload-shared-state")
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> Arc<SharedStore> {
        SharedStore::open_in_memory()
    }

    #[test]
    fn get_absent_returns_default_at_version_zero() {
        let s = store();
        let doc = s.get("queue", json!({"items": []}));
        assert_eq!(doc.version, 0);
        assert_eq!(doc.value, json!({"items": []}));
    }

    #[test]
    fn put_then_get_roundtrips_and_bumps_version() {
        let s = store();
        let v1 = s.put("queue", &json!({"items": [1]}), None).unwrap();
        assert_eq!(v1, 1);
        let doc = s.get("queue", json!({}));
        assert_eq!(doc.version, 1);
        assert_eq!(doc.value, json!({"items": [1]}));
        let v2 = s.put("queue", &json!({"items": [1, 2]}), None).unwrap();
        assert_eq!(v2, 2);
    }

    #[test]
    fn conditional_put_with_matching_version_succeeds() {
        let s = store();
        let v1 = s.put("k", &json!(1), None).unwrap();
        let v2 = s.put("k", &json!(2), Some(v1)).unwrap();
        assert_eq!(v2, 2);
    }

    #[test]
    fn conditional_put_with_stale_version_conflicts() {
        let s = store();
        s.put("k", &json!("a"), Some(0)).unwrap();
        match s.put("k", &json!("b"), Some(0)) {
            Err(PutError::Conflict { current }) => assert_eq!(current, 1),
            other => panic!("expected conflict, got {other:?}"),
        }
        assert_eq!(s.get("k", json!(null)).value, json!("a"));
    }

    #[test]
    fn append_caps_and_keeps_newest() {
        let s = store();
        for i in 0..5 {
            s.append("log", json!(i), 3);
        }
        let doc = s.get("log", json!([]));
        assert_eq!(doc.value, json!([2, 3, 4]));
        assert_eq!(doc.version, 5);
    }
}
