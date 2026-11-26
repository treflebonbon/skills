import { closeSync, writeSync } from "node:fs";

const [mode, python, supervisor, lock] = process.argv.slice(2);
if (!python || !supervisor || !lock) throw new Error("raw launcher proof requires a supervisor");

const argv = [python, "-I", "-B", supervisor, "target", lock, "quoted argument"];
const frame = ["exec-proof-v1", "search", python, String(argv.length), ...argv, "0", "0", ""].join(
  "\0",
);
writeSync(1, frame);
if (mode === "hold") {
  Bun.spawn([python, "-I", "-B", supervisor, "descendant"], { stdout: "ignore" });
  closeSync(1);
  setInterval(() => {}, 1_000);
}
