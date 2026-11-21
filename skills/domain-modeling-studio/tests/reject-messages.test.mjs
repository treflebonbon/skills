import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// The literal message a need(...) call rejects with; template messages are skipped.
const messages = [
  ...read("src/model.mjs").matchAll(/need\((?:[^;])*?,\s*"([^"\n]+)"\s*\);/gu),
].map((match) => match[1]);
const patterns = readdirSync(new URL("./", import.meta.url))
  .filter((file) => file.endsWith(".mjs"))
  .flatMap((file) => [...read(`tests/${file}`).matchAll(/\/((?:[^/\n\\]|\\.)+)\/u/gu)])
  .flatMap((match) => {
    try {
      return [new RegExp(match[1], "u")];
    } catch {
      return [];
    }
  });
// ponytail: any matching pattern counts, so a broad one like /根拠/u covers every
// message containing it; require exact patterns if that hides a gap.
const untested = (list) => list.filter((message) => !patterns.some((p) => p.test(message)));

test("model.mjsの拒否メッセージは、どれもテストの正規表現で検証されている", () => {
  assert.ok(messages.length > 50, `抽出できた拒否メッセージが少なすぎます: ${messages.length}`);
  assert.ok(messages.includes("要素のサイズが不正です"));
  assert.deepEqual(untested(["存在しない拒否メッセージ"]), ["存在しない拒否メッセージ"]);
  assert.deepEqual(untested(messages), []);
});
