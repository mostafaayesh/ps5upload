import { create } from "zustand";
import type { LibraryEntry, Volume } from "../api/ps5";

/**
 * Library state lives in a zustand store (not `useState` in the
 * component) so entries survive navigation. When the user clicks
 * Library → Upload → Library again, they see their last-scanned list
 * immediately while a background refresh (fired by the effect in
 * LibraryScreen) updates it in place — no "blank then pop" flicker.
 *
 * Also holds the image-path → mount-point map used to show the
 * MOUNTED badge on archive rows, same caching rationale: switching
 * tabs shouldn't lose the information you already had.
 */
export interface LibraryState {
  entries: LibraryEntry[] | null;
  /** image_path → mount_point, derived from the probe (authoritative).
   *  Empty until first refresh completes. The probe-derived map can
   *  lag the actual kernel state by a beat right after fs_mount —
   *  that's what `pendingMounts` covers. */
  mountMap: Map<string, string>;
  /** image_path → mount_point for fs_mount calls the client just
   *  made, kept here until the next probe surfaces them in `mountMap`
   *  (or `removeMount` is called explicitly). The Library row reads
   *  the *union* — `mountMap.get(p) ?? pendingMounts.get(p)` — so a
   *  successful fs_mount immediately flips the row to MOUNTED even
   *  if the upstream `getmntinfo` listing hasn't caught up. */
  pendingMounts: Map<string, string>;
  /** Writable, non-placeholder volumes the PS5 reports — used by the
   *  Move modal so the user picks a destination from real attached
   *  drives. Same probe that feeds `mountMap`, kept here so move's
   *  destination dropdown doesn't have to re-fetch on every modal open. */
  volumes: Volume[];
  /** When the data was last refreshed (unix ms). null = never loaded. */
  lastRefreshedAt: number | null;
  /** True while a refresh is in flight. Used for the header spinner
   *  without wiping the existing entries. */
  loading: boolean;
  error: string | null;

  setData: (
    entries: LibraryEntry[],
    mountMap: Map<string, string>,
    volumes: Volume[],
  ) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  /** Optimistic mount add. Lets the UI flip the row to MOUNTED +
   *  Unmount-button immediately on a successful fs_mount, before the
   *  background rescan picks the new mount up in `getmntinfo`. The
   *  entry lives in `pendingMounts` and the row reads the union of
   *  the probe-derived map and the pending map. The next setData()
   *  prunes pending entries that the probe has now confirmed. */
  addMount: (imagePath: string, mountPoint: string) => void;
  /** Optimistic mount remove. Counterpart to addMount; flips the row
   *  back to NOT-mounted immediately on a successful fs_unmount.
   *  Removes from BOTH `mountMap` and `pendingMounts`. */
  removeMount: (imagePath: string) => void;
  clear: () => void;
}

/** Effective mount lookup — probe-derived `mountMap` is authoritative,
 *  but a not-yet-confirmed `pendingMounts` entry covers the post-
 *  fs_mount window where the probe hasn't caught up. The Library row
 *  reads through this so a freshly-mounted image flips to MOUNTED in
 *  the same render the user clicks. */
export function effectiveMount(
  s: Pick<LibraryState, "mountMap" | "pendingMounts">,
  imagePath: string,
): string | null {
  return s.mountMap.get(imagePath) ?? s.pendingMounts.get(imagePath) ?? null;
}

/** Reverse lookup: given a path that lives somewhere inside one of
 *  the active mounts, return the backing image_path. Used by the
 *  Library row to render a "from disk image" badge on game folders
 *  that live inside a currently-mounted image (so the user can tell
 *  uploaded-folder games apart from games-that-disappear-on-unmount).
 *
 *  Longest mount-point match wins so nested mounts attribute
 *  correctly — i.e., a game at `/mnt/ext1/foo/bar` where both
 *  `/mnt/ext1` and `/mnt/ext1/foo` are mounted attributes the row
 *  to the deeper mount.
 *
 *  Centralised here (vs reimplementing the union loop inline) so the
 *  badge always matches the row's MOUNTED-state — both ultimately
 *  derive from the same source of truth. */
export function findOwningImage(
  s: Pick<LibraryState, "mountMap" | "pendingMounts">,
  candidatePath: string,
): string | null {
  let bestImage: string | null = null;
  let bestMountLen = -1;
  const consider = (image: string, mount: string) => {
    const root = mount.endsWith("/") ? mount : mount + "/";
    if (candidatePath === mount || candidatePath.startsWith(root)) {
      if (mount.length > bestMountLen) {
        bestImage = image;
        bestMountLen = mount.length;
      }
    }
  };
  for (const [image, mount] of s.mountMap) consider(image, mount);
  for (const [image, mount] of s.pendingMounts) consider(image, mount);
  return bestImage;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  entries: null,
  mountMap: new Map(),
  pendingMounts: new Map(),
  volumes: [],
  lastRefreshedAt: null,
  loading: false,
  error: null,
  setData: (entries, mountMap, volumes) =>
    set((s) => {
      // Prune pending entries that the probe has now confirmed (or
      // that the probe disagrees with — the probe wins because it
      // reads getmntinfo directly). Anything still in pendingMounts
      // after this is a mount the probe hasn't picked up yet, which
      // we keep so the user's row doesn't flip back to "Mount".
      const prunedPending = new Map<string, string>();
      for (const [imagePath, mountPoint] of s.pendingMounts) {
        if (!mountMap.has(imagePath)) {
          prunedPending.set(imagePath, mountPoint);
        }
      }
      return {
        entries,
        mountMap,
        pendingMounts: prunedPending,
        volumes,
        lastRefreshedAt: Date.now(),
        error: null,
      };
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  addMount: (imagePath, mountPoint) =>
    set((s) => {
      const next = new Map(s.pendingMounts);
      next.set(imagePath, mountPoint);
      return { pendingMounts: next };
    }),
  removeMount: (imagePath) =>
    set((s) => {
      const inProbe = s.mountMap.has(imagePath);
      const inPending = s.pendingMounts.has(imagePath);
      if (!inProbe && !inPending) return {};
      const nextProbe = inProbe ? new Map(s.mountMap) : s.mountMap;
      if (inProbe) (nextProbe as Map<string, string>).delete(imagePath);
      const nextPending = inPending
        ? new Map(s.pendingMounts)
        : s.pendingMounts;
      if (inPending) (nextPending as Map<string, string>).delete(imagePath);
      return { mountMap: nextProbe, pendingMounts: nextPending };
    }),
  clear: () =>
    set({
      entries: null,
      mountMap: new Map(),
      pendingMounts: new Map(),
      volumes: [],
      lastRefreshedAt: null,
      loading: false,
      error: null,
    }),
}));
