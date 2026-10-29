import { execFile } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const run = async (command, args, options = {}) => {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: 2 * 1024 * 1024,
      ...options,
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`, {
      cause: error,
    });
  }
};

export const isWsl = () => {
  if (process.env.DOGFOOD_TEST_WSL !== undefined) {
    return process.env.DOGFOOD_TEST_WSL === "1";
  }
  return Boolean(
    process.env.WSL_DISTRO_NAME ||
    (() => {
      try {
        return /microsoft|wsl/iu.test(
          fsSync.readFileSync("/proc/sys/kernel/osrelease", "utf-8")
        );
      } catch {
        return false;
      }
    })()
  );
};

const ownerCommand = () =>
  process.env.MANAGED_CHROME_OWNER || "managed-chrome-owner";
const ownership = (...args) => run(ownerCommand(), args);

const powershell = () => process.env.DOGFOOD_POWERSHELL || "powershell.exe";
const script = () => {
  if (!process.env.DOGFOOD_WINDOWS_SCRIPT) {
    throw new Error(
      "DOGFOOD_WINDOWS_SCRIPT is unavailable. Start dogfood through the plugin runtime entrypoint so it can resolve the bundled Windows script."
    );
  }
  return process.env.DOGFOOD_WINDOWS_SCRIPT;
};
const wslpath = () => process.env.DOGFOOD_WSLPATH || "wslpath";

let windowsScriptPath;
const windowsScript = async () => {
  if (windowsScriptPath) {
    return windowsScriptPath;
  }
  const value = script();
  windowsScriptPath =
    value.includes("\\") || /^[A-Za-z]:/u.test(value)
      ? value
      : await run(wslpath(), ["-w", value]);
  return windowsScriptPath;
};

const powershellAction = async (args, token, identity) => {
  const scriptPath = await windowsScript();
  const command = [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...args,
  ];
  return token
    ? ownership(
        "--identity",
        identity,
        "run",
        token,
        "--",
        powershell(),
        ...command
      )
    : run(powershell(), command);
};

const choosePort = () => {
  if (process.env.DOGFOOD_CDP_ENDPOINT) {
    return new URL(process.env.DOGFOOD_CDP_ENDPOINT).port;
  }
  // Windows mirrored networking does not guarantee that a Linux-assigned
  // ephemeral port is bindable by a Windows process. Do not bind-and-release
  // a Linux socket here: the mirrored port proxy may still be draining when
  // Chrome starts. The owner atomically allocates an unreserved port from the
  // dedicated Dogfood range unless the caller explicitly selects one.
  if (!process.env.DOGFOOD_CDP_PORT) {
    return null;
  }
  const port = Number(process.env.DOGFOOD_CDP_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`DOGFOOD_CDP_PORT must be a TCP port, got '${port}'.`);
  }
  return String(port);
};

const waitForCdp = async (endpoint, attempts = 100) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- poll the endpoint sequentially
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Chrome is still starting.
    }
    // eslint-disable-next-line no-await-in-loop -- keep the retry cadence bounded
    await delay(100);
  }
  throw new Error(
    `Managed Dogfood Chrome did not expose CDP at ${endpoint}. Verify Windows Chrome, WSL2 mirrored networking, and the dedicated loopback port; no WSL browser fallback was attempted.`
  );
};

// eslint-disable-next-line complexity -- this is the fail-closed lifecycle boundary
export const acquireManagedDogfoodChrome = async ({
  extension,
  headed = false,
  runId,
}) => {
  if (!isWsl()) {
    return null;
  }
  const id = runId || `dogfood-${process.pid}-${Date.now()}`;
  const identity = `dogfood-${id}`;
  const owned = (...args) => ownership("--identity", identity, ...args);
  const endpointOverride = process.env.DOGFOOD_CDP_ENDPOINT;
  if (endpointOverride && process.env.DOGFOOD_TEST_ALLOW_CDP_ENDPOINT !== "1") {
    throw new Error(
      "DOGFOOD_CDP_ENDPOINT is restricted to tests; dogfood must use the managed Windows Chrome launcher."
    );
  }
  let port = choosePort();
  let endpoint =
    endpointOverride || (port ? `http://127.0.0.1:${port}` : "auto");
  const profile = await powershellAction(["-Action", "Resolve", "-RunId", id]);
  const extensionPath = extension
    ? await run(wslpath(), ["-w", path.resolve(extension)])
    : "";
  const token = await owned(
    "reserve",
    "--role",
    "dogfood",
    "--id",
    id,
    "--pid",
    String(process.pid),
    "--mode",
    headed ? "headed" : "headless",
    "--profile",
    profile,
    "--endpoint",
    endpoint
  );

  let started = false;
  try {
    if (endpoint === "auto") {
      const reservation = JSON.parse(await owned("status"));
      if (reservation?.token !== token) {
        throw new Error(
          "Dogfood reservation changed before startup; ownership was preserved."
        );
      }
      ({ endpoint } = reservation);
      ({ port } = new URL(endpoint));
    }
    if (!endpointOverride) {
      const status = await powershellAction([
        "-Action",
        "Inspect",
        "-RunId",
        id,
        "-Mode",
        headed ? "headed" : "headless",
        "-DebugPort",
        port,
        "-ProfileDir",
        profile,
      ]);
      if (status !== "absent") {
        let remediation =
          "Verify the Windows Chrome process and its dedicated profile before retrying.";
        if (status === "chrome-missing") {
          remediation = "Install the stable Windows Google Chrome release.";
        } else if (status.startsWith("port-conflict:")) {
          remediation =
            "Free the dedicated loopback CDP port; another process will not be replaced automatically.";
        } else if (status.startsWith("profile-conflict:")) {
          remediation =
            "Close the dedicated dogfood Chrome using that profile before retrying.";
        }
        throw new Error(
          `Managed Dogfood Chrome is not available for a fresh run (status: ${status}). ${remediation}`
        );
      }
      started = true;
      await powershellAction(
        [
          "-Action",
          "Start",
          "-RunId",
          id,
          "-Mode",
          headed ? "headed" : "headless",
          "-DebugPort",
          port,
          "-ProfileDir",
          profile,
          ...(extensionPath ? ["-ExtensionPath", extensionPath] : []),
        ],
        token,
        identity
      );
      await waitForCdp(endpoint);
      await owned("activate", token);
    }
  } catch (error) {
    if (started) {
      try {
        await powershellAction([
          "-Action",
          "Cleanup",
          "-RunId",
          id,
          "-ProfileDir",
          profile,
        ]);
      } catch (cleanupError) {
        error.message = `${error.message}; cleanup failed: ${cleanupError.message}`;
      }
    }
    try {
      await owned("release", token);
    } catch (releaseError) {
      error.message = `${error.message}; ${releaseError.message}`;
    }
    throw error;
  }

  return {
    async close() {
      let cleanupError;
      let releaseError;
      try {
        if (started) {
          await powershellAction([
            "-Action",
            "Cleanup",
            "-RunId",
            id,
            "-ProfileDir",
            profile,
          ]);
        }
      } catch (error) {
        cleanupError = error;
      } finally {
        try {
          await owned("release", token);
        } catch (error) {
          releaseError = error;
        }
      }
      if (releaseError) {
        const releaseMessage =
          releaseError instanceof Error
            ? releaseError.message
            : String(releaseError);
        const cleanupMessage = cleanupError
          ? `; cleanup failed: ${
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
            }`
          : "";
        throw new Error(`${releaseMessage}${cleanupMessage}`, {
          cause: releaseError,
        });
      }
      if (cleanupError) {
        throw cleanupError instanceof Error
          ? cleanupError
          : new Error(String(cleanupError));
      }
    },
    endpoint,
    id,
    mode: headed ? "headed" : "headless",
    profile,
  };
};
