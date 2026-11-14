import { accessSync, constants, statSync } from "node:fs";

// case cwd への切替後も、旧 shutil.which が返した PATH 表記を使う。
export function findCLI(name: string): string | null {
  const path = process.env.PATH ?? "/bin:/usr/bin";
  if (!path) return null;
  for (const directory of path.split(":")) {
    const candidate = directory ? directory + (directory.endsWith("/") ? "" : "/") + name : name;
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return null;
}
