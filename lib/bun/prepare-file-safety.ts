import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  cacheDirectory,
  hash,
  privateDirectory,
  source,
  validateFileSafetyArtifact,
} from "./file-safety.ts";

try {
  if (process.argv.length !== 2)
    throw new Error(
      "使い方: prepare-file-safety（TREFLEBONBON_FILE_SAFETY_DIR で保存先を指定できます）",
    );
  const sourceBytes = fs.readFileSync(source);
  const sourceHash = hash(sourceBytes);
  const directory = cacheDirectory(sourceHash);
  const payload = resolve(import.meta.dir, "../..");
  if (directory === payload || directory.startsWith(payload + "/"))
    throw new Error("native module は payload 外に準備してください");
  privateDirectory(directory, true);
  const published = join(directory, "artifact");
  if (fs.lstatSync(published, { throwIfNoEntry: false })) {
    validateFileSafetyArtifact(published, sourceHash);
    console.log(published);
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
  try {
    const snapshot = join(temporary, "file-safety-native.c");
    fs.writeFileSync(snapshot, sourceBytes, { mode: 0o600, flag: "wx" });
    const artifact = join(temporary, "artifact");
    fs.mkdirSync(artifact, { mode: 0o700 });
    const binary = join(artifact, "file-safety.node");
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
      snapshot,
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
      sourceHash,
      binaryHash: hash(fs.readFileSync(binary)),
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      node: installation.version,
      compiler: compiler.stdout.split("\n")[0],
      headerDirectory,
      arguments: args,
    };
    fs.writeFileSync(join(artifact, "build.json"), JSON.stringify(metadata, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    validateFileSafetyArtifact(artifact, sourceHash);
    // rename publishes both single-link files together and cannot replace a nonempty generation.
    try {
      fs.renameSync(artifact, published);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      validateFileSafetyArtifact(published, sourceHash);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
  console.log(published);
} catch (error) {
  console.error(`エラー: ${(error as Error).message}`);
  process.exitCode = 1;
}
