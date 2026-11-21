import * as fs from "node:fs";
import { join } from "node:path";

/** 空環境でも起動できる短いshebang用symlinkを、専用directoryで所有する。 */
export function createFixtureInterpreter(executable: string) {
  fs.mkdirSync("/tmp/codex", { recursive: true, mode: 0o700 });
  const info = fs.lstatSync("/tmp/codex");
  if (!info.isDirectory() || info.uid !== process.getuid!())
    throw Error("/tmp/codex は実行ユーザー所有の通常directoryが必要です");
  const directory = fs.mkdtempSync("/tmp/codex/ns-");
  const path = join(directory, "runtime");
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    fs.symlinkSync(fs.realpathSync(executable), path);
  } catch (error) {
    cleanup();
    throw error;
  }
  return { path, cleanup };
}
