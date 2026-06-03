import { useUploadSettingsStore } from "../state/uploadSettings";
import { useConnectionStore } from "../state/connection";

/**
 * Resolve the parallel upload stream count to actually use for a transfer:
 * the user's setting, clamped by what the connected payload advertises
 * (`max_transfer_streams`). A payload that predates multi-stream advertises
 * nothing → treated as 1, so multi-stream silently no-ops on old payloads and
 * the engine takes its single-stream path. Returns at least 1, so callers can
 * always pass the result straight through to `startTransferDirReconcile`.
 *
 * Lives in its own module (rather than in a store) so neither the upload-
 * settings nor connection store has to import the other, avoiding a cycle.
 */
export function effectiveUploadStreams(): number {
  const want = useUploadSettingsStore.getState().uploadStreams;
  const payloadMax = useConnectionStore.getState().maxTransferStreams ?? 1;
  return Math.max(1, Math.min(want, payloadMax));
}
