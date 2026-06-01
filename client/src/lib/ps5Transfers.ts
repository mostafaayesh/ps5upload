import { useUploadQueueStore } from "../state/uploadQueue";
import { useTransferStore } from "../state/transfer";

/**
 * Coordination for the PS5's single-client transfer port (:9113) and the
 * payload itself. Only ONE of {Upload-screen one-shot, Upload-screen queue,
 * Install-screen .pkg upload, Install-screen install} can safely touch the
 * console at a time — an install swaps the payload out, and the transfer port
 * serves one client. When they overlap the loser dies with "PS5 stopped
 * responding". These helpers let a caller WAIT its turn instead of colliding.
 */

/**
 * True while an Upload-screen transfer (one-shot or queue) holds the port.
 *
 * Callers on the Install screen poll this (alongside their own .pkg-upload
 * state) to WAIT their turn instead of colliding — installing swaps the
 * payload, and the transfer port serves one client, so an install or .pkg
 * upload that starts mid-transfer kills the loser with "PS5 stopped
 * responding". No hard timeout is needed: a legitimate multi-GB upload can run
 * a long time and the transfers have their own stall watchdogs, so this always
 * clears eventually; cancellation is the escape hatch.
 */
export function transferScreenBusy(): boolean {
  const queueRunning = useUploadQueueStore.getState().running;
  const phase = useTransferStore.getState().phase.kind;
  return queueRunning || phase === "starting" || phase === "running";
}
