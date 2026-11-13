import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDirectory, hash, privateDirectory, source } from "./file-safety.ts";

try {
  if (process.argv.length !== 2)
    throw new Error(
      "使い方: prepare-file-safety（TREFLEBONBON_FILE_SAFETY_DIR で保存先を指定できます）",
    );
  const directory = cacheDirectory();
  const payload = resolve(import.meta.dir, "../..");
  if (directory === payload || directory.startsWith(payload + "/"))
    throw new Error("native module は payload 外に準備してください");
  privateDirectory(directory, true);
  const output = join(directory, "file-safety.node");
  if (fs.existsSync(output)) {
    const { native } = await import("./file-safety.ts");
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      native.fstatat(fd, "file-safety.node");
    } finally {
      fs.closeSync(fd);
    }
    console.log(directory);
    process.exit(0);
  }
  const node = spawnSync(
    "node",
    ["-p", "JSON.stringify({executable:process.execPath,version:process.version})"],
    { encoding: "utf8" },
  );
  if (node.status !== 0) throw new Error("導入済み Node.js と Node-API header が必要です");
  const installation = JSON.parse(node.stdout);
  const headerDirectory = join(
    dirname(fs.realpathSync(installation.executable)),
    "../include/node",
  );
  if (!fs.existsSync(join(headerDirectory, "node_api.h")))
    throw new Error(`Node-API header が必要です: ${headerDirectory}`);
  const temporary = fs.mkdtempSync(join(directory, ".build-"));
  const published: { path: string; dev: bigint; ino: bigint }[] = [];
  try {
    const binary = join(temporary, "file-safety.node");
    const args = [
      "-std=c11",
      "-D_POSIX_C_SOURCE=200809L",
      "-DNAPI_VERSION=6",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      ...(process.platform === "darwin"
        ? ["-bundle", "-undefined", "dynamic_lookup"]
        : ["-shared", "-fPIC"]),
      "-I",
      headerDirectory,
      fileURLToPath(source),
      "-o",
      binary,
    ];
    const build = spawnSync("cc", args, { encoding: "utf8", timeout: 30_000 });
    if (build.error || build.status !== 0)
      throw new Error(`native build に失敗しました: ${build.error?.message ?? build.stderr}`);
    fs.chmodSync(binary, 0o500);
    const compiler = spawnSync("cc", ["--version"], { encoding: "utf8" });
    if (compiler.status !== 0) throw new Error("compiler の版を取得できません");
    const metadata = {
      sourceHash: hash(fs.readFileSync(source)),
      binaryHash: hash(fs.readFileSync(binary)),
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      node: installation.version,
      compiler: compiler.stdout.split("\n")[0],
      headerDirectory,
      arguments: args,
    };
    fs.writeFileSync(join(temporary, "build.json"), JSON.stringify(metadata, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    // binary を最後に公開する。別の build が先に公開しても置換しない。
    for (const name of ["build.json", "file-safety.node"]) {
      const from = join(temporary, name),
        path = join(directory, name);
      published.push({ path, ...fs.lstatSync(from, { bigint: true }) });
      fs.linkSync(from, path);
    }
  } catch (error) {
    for (const made of published.reverse()) {
      try {
        const current = fs.lstatSync(made.path, { bigint: true });
        if (current.dev === made.dev && current.ino === made.ino) fs.unlinkSync(made.path);
      } catch {
        /* 元の公開エラーを保持する。 */
      }
    }
    throw error;
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
  console.log(directory);
} catch (error) {
  console.error(`エラー: ${(error as Error).message}`);
  process.exitCode = 1;
}
