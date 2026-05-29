import { listen } from "@tauri-apps/api/event";
import { useConnectionStore } from "./connection";
import { log } from "./logs";

let installed = false;

export function installEngineStartupEvents(): void {
  if (installed) return;
  installed = true;
  void listen<string>("ps5upload-engine-startup-error", (event) => {
    const message =
      typeof event.payload === "string"
        ? event.payload
        : "engine failed to start";
    useConnectionStore.getState().setStatus({
      engineStatus: "down",
      engineError: message,
    });
    log.error("engine", message);
  }).catch((e) => {
    log.warn(
      "engine",
      "could not subscribe to engine startup diagnostics",
      e,
    );
  });
}
