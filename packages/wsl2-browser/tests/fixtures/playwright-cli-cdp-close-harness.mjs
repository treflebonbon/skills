import { pathToFileURL } from "node:url";

const cdpClosePath = process.argv.at(2);
const responseMode = process.argv.at(3) ?? "success";

globalThis.fetch = () =>
  Promise.resolve({
    json: () =>
      Promise.resolve({ webSocketDebuggerUrl: "ws://managed-chrome" }),
    ok: true,
  });

globalThis.WebSocket = class extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send() {
    queueMicrotask(() => {
      if (responseMode === "event-then-success") {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              method: "Target.targetCreated",
              params: {},
            }),
          })
        );
      }
      const response =
        responseMode === "error"
          ? { error: { code: -32_000, message: "close refused" }, id: 1 }
          : { id: 1, result: {} };
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(response) })
      );
    });
  }

  close() {
    this.dispatchEvent(new Event("close"));
  }
};

process.argv = [process.execPath, cdpClosePath, "http://127.0.0.1:9222"];
await import(pathToFileURL(cdpClosePath));

// A ref'd timer left after Browser.close keeps the process alive; check it deterministically, not by wall-clock time.
const resources = process.getActiveResourcesInfo();
if (resources.includes("Timeout")) {
  console.error(`active timer after Browser.close: ${resources.join(", ")}`);
  process.exit(1);
}
