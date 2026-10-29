import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const [endpoint] = process.argv.slice(2);

if (!endpoint) {
  throw new Error("CDP endpoint is required");
}

const response = await fetch(`${endpoint}/json/version`);
if (!response.ok) {
  throw new Error(`CDP version request failed with HTTP ${response.status}`);
}

const { webSocketDebuggerUrl } = await response.json();
if (!webSocketDebuggerUrl) {
  throw new Error("CDP response did not include webSocketDebuggerUrl");
}

const socket = new WebSocket(webSocketDebuggerUrl);
const opened = await Promise.race([
  once(socket, "open").then(() => true),
  once(socket, "error").then(() => false),
  delay(5000, undefined, { ref: false }).then(() => false),
]);
if (!opened) {
  socket.close();
  throw new Error("Browser.close connection failed");
}

/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks -- one listener must stay attached while unrelated CDP events are skipped */
const result = await new Promise((resolve, reject) => {
  let timeout = null;
  const cleanup = () => {
    clearTimeout(timeout);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
  };
  const finish = (value) => {
    cleanup();
    resolve(value);
  };
  const fail = (error) => {
    cleanup();
    socket.close();
    reject(error);
  };
  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id !== 1) {
      return;
    }
    if (message.error) {
      const detail = message.error.message ?? JSON.stringify(message.error);
      fail(new Error(`Browser.close failed: ${detail}`));
      return;
    }
    finish("message");
  };
  const onClose = () => finish("close");
  const onError = () => finish("error");

  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  timeout = setTimeout(() => finish("timeout"), 5000);
  timeout.unref();
  socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
});
/* oxlint-enable promise/avoid-new, promise/prefer-await-to-callbacks */
if (result === "error" || result === "timeout") {
  socket.close();
  throw new Error(`Browser.close ${result}`);
}
if (result === "message") {
  socket.close();
}
