import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { check, digest, fail, git, repoIdentity } from "./candidate-record.ts";
import { equalPeerJSON, parsePeerJSON, peerJSON } from "../../../lib/bun/peer-json.ts";
import {
  native,
  openParent,
  readRegular,
  removeCreated,
  type Identity,
  type Parent,
} from "../../../lib/bun/file-safety.ts";

const SHARED = "/tmp/codex";
const sensitive =
  /^(?:.*\.(?:pem|key|pfx|p12)|credentials.*\.json|auth\.json|secrets?\.json|service-account.*\.json|id_.*|tokens?\.json|token\..*\.json|credentials|\.netrc|\.npmrc|\.pypirc|application_default_credentials\.json|access_tokens\.db|\.git-credentials|\.credentials.*\.json)$/;
const directories = new Set([".aws", ".ssh", ".gnupg", ".kube", ".docker", ".azure", "gcloud"]);
function publicPath(value: string, artifactPath?: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.split("/").includes("..") ||
    resolve(value) === SHARED ||
    !value.isWellFormed() ||
    value.includes("\0")
  )
    fail("証跡は正規の絶対パスで指定してください");
  const path = resolve(value);
  const shared = path.startsWith(SHARED + "/");
  if (!shared && path !== artifactPath) fail("証跡は /tmp/codex 配下の絶対パスで指定してください");
  const parts = path.toLowerCase().split("/");
  if (
    parts.some(
      (part, index) =>
        (part.startsWith(".env") && part !== ".env.example") ||
        sensitive.test(part) ||
        directories.has(part) ||
        (part === ".config" && parts[index + 1] === "gh"),
    )
  )
    fail("機密ファイル名を証跡に含められません");
  for (let parent = path; ; parent = dirname(parent)) {
    try {
      const stat = fs.lstatSync(parent);
      if (stat.isSymbolicLink()) fail("証跡のパスに symlink を含められません");
      if (parent !== path && !stat.isDirectory()) fail("証跡の親パスが directory ではありません");
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (parent === "/" || (shared && parent === SHARED)) break;
  }
  return path;
}
function parentFor(path: string, create = false): Parent {
  return openParent(path, path.startsWith(SHARED + "/") ? SHARED : "/", create);
}
function readPublic(value: string, artifactPath?: string): Buffer {
  const path = publicPath(value, artifactPath);
  let parent: Parent;
  try {
    parent = parentFor(path);
  } catch (error) {
    throw Object.assign(new Error(`証跡のパスを安全に開けません: ${(error as Error).message}`), {
      code: (error as NodeJS.ErrnoException).code,
    });
  }
  try {
    return readRegular(parent);
  } finally {
    fs.closeSync(parent.fd);
  }
}
function originalArtifact(raw: Buffer, fingerprint: string): string {
  if (digest(raw) !== fingerprint) fail("記録ファイルの fingerprint が一致しません");
  const record = parsePeerJSON(raw);
  if (!record || typeof record !== "object" || typeof record.artifact_path !== "string")
    fail("記録ファイルの形式が不正です");
  return record.artifact_path;
}
function storage(fingerprint: string, digestName: string, create = false): Parent {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) fail("record fingerprint は SHA-256 で指定してください");
  const root = repoIdentity();
  // 共通 Git dir は Git が返した canonical path。以降は保持した FD だけを使う。
  const path = join(root, "peer-refactor-evidence", fingerprint, digestName + ".json");
  const parent = openParent(path, "/", create);
  return parent;
}
function writeNew(
  parent: Parent,
  content: Buffer,
  created: { parent: Parent; made: Identity }[],
  sync = false,
): void {
  const fd = native.openat(
    parent.fd,
    parent.leaf,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    created.push({ parent, made: fs.fstatSync(fd, { bigint: true }) });
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content);
    if (sync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function rollback(created: { parent: Parent; made: Identity }[]): void {
  for (const item of created) {
    try {
      removeCreated(item.parent, item.made);
    } catch {
      /* 元の復元エラーを保持する。 */
    }
  }
}
function probe(
  recordPath: string,
  candidatesPath: string,
  fingerprint: string,
  nonce: string,
  receiptPath: string,
): number {
  if (!/^[0-9a-f]{16,64}$/.test(nonce))
    fail("probe nonce は16〜64桁の小文字の16進数で指定してください");
  const artifact = originalArtifact(readPublic(recordPath), fingerprint);
  publicPath(artifact, artifact);
  readPublic(candidatesPath);
  const destination = publicPath(receiptPath);
  const parent = parentFor(destination);
  try {
    const head = git("rev-parse", "--verify", "HEAD^{commit}");
    const command = [
      join(import.meta.dir, "candidate-record"),
      "check",
      recordPath,
      candidatesPath,
      fingerprint,
    ];
    const result = spawnSync(command[0]!, command.slice(1), {
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    let exitCode: number;
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      exitCode = 124;
      console.error("エラー: checker の実行がタイムアウトしました");
    } else if (result.error) throw result.error;
    else
      exitCode =
        result.status ??
        -(osConstants.signals[result.signal as keyof typeof osConstants.signals] ?? 1);
    const raw = Buffer.from(
      peerJSON({
        version: 1,
        nonce,
        fingerprint,
        head,
        cwd: fs.realpathSync(process.cwd()),
        command,
        exit_code: exitCode,
      }),
    );
    writeNew(parent, raw, []);
    process.stdout.write(raw);
    return exitCode;
  } finally {
    fs.closeSync(parent.fd);
  }
}
// Python の sorted(str) は UTF-16 code unit でなく Unicode code point 順。
function pathOrder(left: string, right: string): number {
  const a = [...left],
    b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
function checkpoint(
  recordPath: string,
  candidatesPath: string,
  fingerprint: string,
  ...extra: string[]
): void {
  const artifact = originalArtifact(readPublic(recordPath), fingerprint);
  publicPath(candidatesPath);
  const paths = [...new Set([recordPath, candidatesPath, artifact, ...extra])].sort(pathOrder);
  const files = new Map(paths.map((path) => [path, readPublic(path, artifact)]));
  const read = (path: string): Buffer =>
    files.get(path) ?? fail("checkpoint に必要なファイルがありません");
  check(recordPath, candidatesPath, fingerprint, read);
  const raw = Buffer.from(
    peerJSON({
      version: 1,
      record_path: recordPath,
      candidates_path: candidatesPath,
      fingerprint,
      files: Object.fromEntries(paths.map((path) => [path, read(path).toString("base64")])),
    }),
  );
  const hash = digest(raw);
  const parent = storage(fingerprint, hash, true);
  const temporary = { fd: parent.fd, leaf: `.checkpoint-${randomBytes(16).toString("hex")}` };
  const made: { parent: Parent; made: Identity }[] = [];
  try {
    writeNew(temporary, raw, made, true);
    try {
      native.linkat(parent.fd, temporary.leaf, parent.fd, parent.leaf);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!readRegular(parent).equals(raw)) fail("既存の checkpoint が破損しています");
    }
  } finally {
    rollback(made);
    fs.closeSync(parent.fd);
  }
  console.log(
    JSON.stringify({
      checkpoint: hash,
      fingerprint,
      path: join(repoIdentity(), "peer-refactor-evidence", fingerprint, parent.leaf),
    }),
  );
}
function base64(value: string): Buffer {
  const match = /^([A-Za-z0-9+/]*)(=*)$/.exec(value);
  if (!match) fail("checkpoint のファイル内容が不正です");
  const count = match[1]!.length,
    padding = match[2]!.length;
  if (
    (count === 0 && padding > 0) ||
    count % 4 === 1 ||
    (count % 4 === 2 && padding !== 2) ||
    (count % 4 === 3 && padding !== 1)
  )
    fail("checkpoint のファイル内容が不正です");
  return Buffer.from(value, "base64");
}
function restore(fingerprint: string, hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) fail("checkpoint は SHA-256 で指定してください");
  const parent = storage(fingerprint, hash);
  let raw: Buffer;
  try {
    raw = readRegular(parent);
  } finally {
    fs.closeSync(parent.fd);
  }
  if (digest(raw) !== hash) fail("checkpoint の hash が一致しません");
  const data = parsePeerJSON(raw);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !equalPeerJSON(data.version, 1) ||
    data.fingerprint !== fingerprint
  )
    fail("checkpoint の形式または fingerprint が不正です");
  if (
    !data.files ||
    typeof data.files !== "object" ||
    Array.isArray(data.files) ||
    !Object.keys(data.files).length
  )
    fail("checkpoint のファイル一覧が不正です");
  const files = new Map<string, Buffer>();
  for (const [path, value] of Object.entries(data.files)) {
    if (typeof value !== "string") fail("checkpoint のファイル内容が不正です");
    files.set(path, base64(value));
  }
  publicPath(data.record_path);
  publicPath(data.candidates_path);
  const read = (path: string): Buffer =>
    files.get(path) ?? fail("checkpoint に必要なファイルがありません");
  const artifact = originalArtifact(read(data.record_path), fingerprint);
  check(data.record_path, data.candidates_path, fingerprint, read);
  for (const [path, content] of files) {
    publicPath(path, artifact);
    try {
      if (!readPublic(path, artifact).equals(content))
        fail("既存の証跡と異なるため復元を中止しました。待機台帳も上書きしません");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // 親の欠落だけを許す。file / symlink の拒否は publicPath で検査済み。
    }
  }
  const created: { parent: Parent; made: Identity }[] = [];
  const parents: Parent[] = [];
  try {
    for (const [path, content] of files) {
      const target = parentFor(publicPath(path, artifact), true);
      parents.push(target);
      try {
        writeNew(target, content, created);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!readRegular(target).equals(content))
          fail("既存の証跡と異なるため復元を中止しました。待機台帳も上書きしません");
      }
    }
  } catch (error) {
    rollback(created);
    throw error;
  } finally {
    for (const target of parents) fs.closeSync(target.fd);
  }
  check(data.record_path, data.candidates_path, fingerprint, (path) => readPublic(path, artifact));
  console.log(
    JSON.stringify({ restored: files.size, record_path: data.record_path, checkpoint: hash }),
  );
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "probe" && args.length === 6) {
      const code = probe(...(args.slice(1) as [string, string, string, string, string]));
      process.exitCode = code < 0 ? 256 + code : code;
    } else if (args[0] === "checkpoint" && args.length >= 4)
      checkpoint(args[1]!, args[2]!, args[3]!, ...args.slice(4));
    else if (args[0] === "restore" && args.length === 3) restore(args[1]!, args[2]!);
    else
      fail(
        "使い方: run-evidence probe <record> <candidates> <record-sha256> <nonce> <receipt.json> | checkpoint <record> <candidates> <record-sha256> [public-file ...] | restore <record-sha256> <checkpoint-sha256>",
      );
  } catch (error) {
    console.error(`エラー: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
