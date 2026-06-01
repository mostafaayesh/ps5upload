import { afterEach, describe, expect, it } from "vitest";

import { transferScreenBusy } from "./ps5Transfers";
import { useUploadQueueStore } from "../state/uploadQueue";
import { useTransferStore } from "../state/transfer";

describe("transferScreenBusy", () => {
  afterEach(() => {
    useUploadQueueStore.setState({ running: false });
    useTransferStore.setState({ phase: { kind: "idle" } });
  });

  it("is false when nothing is transferring", () => {
    expect(transferScreenBusy()).toBe(false);
  });

  it("is true while the upload queue is running", () => {
    useUploadQueueStore.setState({ running: true });
    expect(transferScreenBusy()).toBe(true);
  });

  it("is true during a one-shot transfer (starting/running phase)", () => {
    useTransferStore.setState({ phase: { kind: "starting" } });
    expect(transferScreenBusy()).toBe(true);
  });
});
