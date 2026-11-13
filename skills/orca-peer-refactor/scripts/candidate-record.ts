import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  closeSync,
  writeFileSync,
  fstatSync,
  fsyncSync,
  constants,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { artifactText } from "../../../lib/bun/html-report.ts";
import { parsePeerJSON, peerJSON, equalPeerJSON } from "../../../lib/bun/peer-json.ts";
import folds from "../../../lib/bun/vendor/peer-casefold.json";
import { native, openParent, removeCreated, type Identity } from "../../../lib/bun/file-safety.ts";

export function fail(message: string): never {
  throw new Error(message);
}
export const digest = (raw: Uint8Array): string => createHash("sha256").update(raw).digest("hex");
export function git(...args: string[]): string {
  const result = spawnSync("git", args, { stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) fail("Git リポジトリまたは commit を確認できません");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(result.stdout)
    .replace(
      /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
      "",
    );
}
export const repoIdentity = (): string => realpathSync(git("rev-parse", "--git-common-dir"));
function commitId(value: string): string {
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value))
    fail("source-sha は完全な commit SHA で指定してください");
  return git("rev-parse", "--verify", `${value}^{commit}`);
}
function checkAncestor(source: string): void {
  const head = git("rev-parse", "--verify", "HEAD^{commit}");
  if (
    spawnSync("git", ["merge-base", "--is-ancestor", source, head], { stdio: "ignore" }).status !==
    0
  )
    fail("source commit は現在の HEAD の祖先ではありません");
}
type Reader = (path: string) => Buffer;
function loadJSON(path: string, label: string, read: Reader): any {
  try {
    return parsePeerJSON(read(path));
  } catch {
    return fail(`${label} を読めません`);
  }
}
const normalizeText = (value: string): string =>
  value
    .split(/[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/)
    .filter(Boolean)
    .join(" ");
function validateCandidates(candidates: any, source: string): void {
  if (!Array.isArray(candidates) || !candidates.length)
    fail("候補は空でない JSON 配列で指定してください");
  const ids = new Set(),
    titles = new Set();
  for (const [index, candidate] of candidates.entries()) {
    const label = `候補 ${index + 1}`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      fail(`${label} はオブジェクトではありません`);
    const { id, title } = candidate;
    if (typeof id !== "string" || !normalizeText(id)) fail(`${label} の id が空です`);
    if (ids.has(id)) fail(`候補の id が重複しています: ${id}`);
    ids.add(id);
    if (typeof title !== "string" || !normalizeText(title)) fail(`${label} の title が空です`);
    const titleKey = [...normalizeText(title)]
      .map((c) => (folds as Record<string, string>)[c] ?? c)
      .join("");
    if (titles.has(titleKey)) fail(`候補の title が重複しています: ${title}`);
    titles.add(titleKey);
    for (const [field, nonempty] of [
      ["acceptance", true],
      ["non_goals", false],
      ["owned_files", true],
    ] as const) {
      const value = candidate[field];
      if (!Array.isArray(value) || (nonempty && !value.length))
        fail(`${label} の ${field} は${nonempty ? "空でない配列" : "配列"}にしてください`);
      if (value.some((item: unknown) => typeof item !== "string" || !normalizeText(item)))
        fail(`${label} の ${field} は空でない文字列の配列にしてください`);
    }
    if (!source.includes(normalizeText(title))) fail(`候補 title がレポートにありません: ${title}`);
  }
}
function readArtifact(path: string, read: Reader): [string, Buffer] {
  const absolute = resolve(path);
  try {
    return [absolute, read(absolute)];
  } catch {
    return fail("レポートを読めません");
  }
}
function text(raw: Buffer): string {
  try {
    return artifactText(raw);
  } catch {
    return fail("レポートは UTF-8 で読めません");
  }
}
export function pin(
  artifact: string,
  sourceRepo: string,
  sourceSha: string,
  candidatesPath: string,
  recordPath: string,
): void {
  if (!isAbsolute(sourceRepo)) fail("提示元 repo の共通 Git dir は絶対パスで指定してください");
  const identity = realpathSync(sourceRepo);
  if (repoIdentity() !== identity) fail("提示元と別の Git リポジトリです");
  const [artifactPath, raw] = readArtifact(artifact, readFileSync);
  const source = text(raw);
  const candidates = loadJSON(candidatesPath, "候補ファイル", readFileSync);
  validateCandidates(candidates, source);
  const sourceCommit = commitId(sourceSha);
  checkAncestor(sourceCommit);
  const rawRecord = Buffer.from(
    peerJSON({
      version: 1,
      repo_common_dir: identity,
      artifact_path: artifactPath,
      artifact_sha256: digest(raw),
      source_commit: sourceCommit,
      candidates,
    }),
  );
  try {
    const absolute = resolve(recordPath);
    const parent = openParent(
      absolute.startsWith("/tmp/") ? realpathSync("/tmp") + absolute.slice(4) : absolute,
    );
    const temporary = { fd: parent.fd, leaf: `.candidate-${randomBytes(16).toString("hex")}` };
    let made: Identity | undefined;
    try {
      const fd = native.openat(
        parent.fd,
        temporary.leaf,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o666,
      );
      try {
        made = fstatSync(fd, { bigint: true });
        writeFileSync(fd, rawRecord);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      native.linkat(parent.fd, temporary.leaf, parent.fd, parent.leaf);
    } finally {
      try {
        if (made) removeCreated(temporary, made);
      } finally {
        closeSync(parent.fd);
      }
    }
  } catch (error) {
    fail(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "記録ファイルは既に存在します。上書きしません"
        : `記録ファイルを作成できません: ${(error as Error).message}`,
    );
  }
  console.log(digest(rawRecord));
}
export function check(
  recordPath: string,
  candidatesPath: string,
  fingerprint: string,
  read: Reader = readFileSync,
): void {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) fail("record fingerprint は SHA-256 で指定してください");
  const rawRecord = read(recordPath);
  if (digest(rawRecord) !== fingerprint) fail("記録ファイルの fingerprint が一致しません");
  let record: any;
  try {
    record = parsePeerJSON(rawRecord);
  } catch {
    fail("記録ファイルを読めません");
  }
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !equalPeerJSON(record.version, 1)
  )
    fail("記録ファイルの形式が不正です");
  if (
    ["repo_common_dir", "artifact_path", "artifact_sha256", "source_commit"].some(
      (field) => typeof record[field] !== "string",
    )
  )
    fail("記録ファイルの形式が不正です");
  if (!isAbsolute(record.artifact_path) || !isAbsolute(record.repo_common_dir))
    fail("記録ファイルの provenance が不正です");
  if (repoIdentity() !== record.repo_common_dir) fail("別の Git リポジトリです");
  const [artifactPath, raw] = readArtifact(record.artifact_path, read);
  if (artifactPath !== record.artifact_path || digest(raw) !== record.artifact_sha256)
    fail("レポートが記録後に変更または移動されています");
  const source = text(raw);
  validateCandidates(record.candidates, source);
  const sourceCommit = commitId(record.source_commit);
  if (sourceCommit !== record.source_commit) fail("記録された source commit が不正です");
  checkAncestor(sourceCommit);
  const proposed = loadJSON(candidatesPath, "候補ファイル", read);
  validateCandidates(proposed, source);
  if (!equalPeerJSON(proposed, record.candidates)) fail("候補が固定記録と一致しません");
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "pin" && args.length === 6)
      pin(...(args.slice(1) as [string, string, string, string, string]));
    else if (args[0] === "check" && args.length === 4)
      check(...(args.slice(1) as [string, string, string]));
    else
      fail(
        "使い方: candidate-record pin <artifact> <source-repo-common-dir> <source-sha> <candidates.json> <record.json> | check <record.json> <candidates.json> <record-sha256>",
      );
  } catch (error) {
    console.error(`エラー: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
