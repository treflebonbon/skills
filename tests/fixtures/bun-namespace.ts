import { readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { constants, networkInterfaces } from "node:os";
import { resolve } from "node:path";

const runner = resolve(import.meta.dir, "../../lib/bun/run");
const fixture = import.meta.filename;
const [stage, originalUser, originalNetwork, control = "normal"] = process.argv.slice(2);
const text = (path: string) => readFileSync(path, "utf8").trim();
const namespace = (name: string) => String(statSync(`/proc/self/ns/${name}`).ino);

function snapshot() {
  const mapping = (name: string) =>
    text(`/proc/self/${name}_map`)
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
  return {
    uid: process.getuid!(),
    gid: process.getgid!(),
    uidMap: mapping("uid"),
    gidMap: mapping("gid"),
    setgroups: text("/proc/self/setgroups"),
    namespaces: { user: namespace("user"), net: namespace("net") },
    capabilities: Object.fromEntries(
      [...text("/proc/self/status").matchAll(/^(Cap\w+):\s+(\w+)$/gm)].map((match) => [
        match[1]!,
        match[2]!,
      ]),
    ),
    unprivilegedPortStart: Number(text("/proc/sys/net/ipv4/ip_unprivileged_port_start")),
    interfaces: Object.keys(networkInterfaces()).sort(),
    addresses: (networkInterfaces().lo ?? []).map((address) => address.address),
  };
}
export type NamespaceSnapshot = ReturnType<typeof snapshot>;

function report(event: string, details: object) {
  console.log(JSON.stringify({ event, ...details }));
}

function command(name: string, args: string[]) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  return result;
}

function finish(name: string, args: string[]): never {
  const result = command(name, args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  report("exit", { stage, status: result.status, signal: result.signal });
  process.exit(result.status ?? 128 + constants.signals[result.signal!]);
}

function checked(name: string, args: string[]) {
  const result = command(name, args);
  if (result.status !== 0) {
    console.error(
      JSON.stringify({
        event: "failure",
        stage,
        command: name,
        status: result.status,
        signal: result.signal,
        reason: result.stderr.trim(),
      }),
    );
    process.exit(result.status ?? 128 + constants.signals[result.signal!]);
  }
}

async function loopback53() {
  const server = createSocket("udp4");
  const client = createSocket("udp4");
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("loopback の受信期限を超えました")), 2_000);
      const end = (error?: Error) => {
        clearTimeout(timer);
        error ? fail(error) : done();
      };
      server.once("error", end);
      client.once("error", end);
      server.once("message", (message) => {
        if (message.toString() !== "namespace-fixture")
          end(new Error("loopback の内容が不一致です"));
        else end();
      });
      server.bind(53, "127.0.0.1", () => client.send("namespace-fixture", 53, "127.0.0.1"));
    });
  } finally {
    for (const socket of [server, client]) {
      try {
        socket.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error;
      }
    }
  }
}

try {
  if (process.platform !== "linux") throw new Error("namespace 実証は Linux / WSL2 専用です");
  if (stage === "launch") {
    const variant = originalUser ?? "normal";
    if (!["normal", "retain-caps", "no-keep-caps", "privileged-port"].includes(variant))
      throw new Error("未知の実証対照です");
    const parent = snapshot();
    report("parent", { snapshot: parent });
    finish("unshare", [
      "--user",
      "--map-current-user",
      "--net",
      ...(variant === "no-keep-caps" ? [] : ["--keep-caps"]),
      runner,
      "run",
      fixture,
      "prepare",
      parent.namespaces.user,
      parent.namespaces.net,
      variant,
    ]);
  } else if (stage === "prepare") {
    if (!originalNetwork || namespace("net") === originalNetwork)
      throw new Error("private network namespace が必要です");
    if (!originalUser || namespace("user") === originalUser)
      throw new Error("private user namespace が必要です");
    if (text("/proc/self/setgroups") !== "deny") throw new Error("setgroups=deny が必要です");
    writeFileSync(
      "/proc/sys/net/ipv4/ip_unprivileged_port_start",
      control === "privileged-port" ? "1024" : "0",
    );
    checked("ip", ["link", "set", "lo", "up"]);
    report("prepared", { snapshot: snapshot() });
    if (control === "retain-caps") finish(runner, ["run", fixture, "bwrap"]);
    finish("setpriv", ["--inh-caps=-all", "--ambient-caps=-all", runner, "run", fixture, "bwrap"]);
  } else if (stage === "bwrap") {
    report("before-bwrap", { snapshot: snapshot() });
    finish("bwrap", [
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--",
      runner,
      "run",
      fixture,
      "observe",
    ]);
  } else if (stage === "observe") {
    await loopback53();
    report("target", { snapshot: snapshot(), port53: "bound" });
    process.exit(37);
  } else throw new Error("未知の実証 stage です");
} catch (error) {
  console.error(JSON.stringify({ event: "failure", stage, reason: String(error) }));
  process.exit(1);
}
