import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const testTmpRoot = process.env.WSL2_BROWSER_TEST_TMPDIR || "/tmp/codex";

test("attachment commands outside WSL2 stop before calling managed services", async () => {
  await mkdir(testTmpRoot, { mode: 0o700, recursive: true });
  const temporary = await mkdtemp(path.join(testTmpRoot, "wsl2-browser-attachments."));
  const calls = path.join(temporary, "calls");
  const owner = path.join(temporary, "owner");

  try {
    await writeFile(
      owner,
      "#!/usr/bin/env bash\nprintf 'called\\n' >>\"$CALLS\"\nexit 1\n",
      { mode: 0o700 },
    );
    const result = spawnSync(
      path.join(packageRoot, "bin/browser-attachments"),
      ["auth"],
      {
        cwd: temporary,
        encoding: "utf8",
        env: {
          ...process.env,
          BROWSER_ATTACHMENTS_CALLS: calls,
          CALLS: calls,
          MANAGED_CHROME_OWNER: owner,
          PWCLI_TEST_WSL: "0",
        },
      },
    );
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr ?? result.error?.message ?? "", /WSL2/u);
    assert.equal(
      await readFile(calls, "utf8").then(() => true, () => false),
      false,
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("attachment commands in NAT networking stop before Windows process checks", async () => {
  await mkdir(testTmpRoot, { mode: 0o700, recursive: true });
  const temporary = await mkdtemp(path.join(testTmpRoot, "wsl2-browser-nat."));
  const fakeBin = path.join(temporary, "bin");
  const ownerCalls = path.join(temporary, "owner-calls");
  const powershellCalls = path.join(temporary, "powershell-calls");
  const owner = path.join(fakeBin, "owner");
  const wslinfo = path.join(fakeBin, "wslinfo");
  const powershell = path.join(fakeBin, "powershell.exe");
  const wslpath = path.join(fakeBin, "wslpath");

  try {
    await mkdir(fakeBin, { mode: 0o700 });
    await writeFile(owner, "#!/usr/bin/env bash\necho call >>\"$OWNER_CALLS\"\n", { mode: 0o700 });
    await writeFile(wslinfo, "#!/usr/bin/env bash\nprintf 'nat\\n'\n", { mode: 0o700 });
    await writeFile(powershell, "#!/usr/bin/env bash\necho call >>\"$POWERSHELL_CALLS\"\n", { mode: 0o700 });
    await writeFile(wslpath, "#!/usr/bin/env bash\nprintf '%s\\n' \"$2\"\n", { mode: 0o700 });

    const result = spawnSync(
      path.join(packageRoot, "bin/browser-attachments"),
      ["auth"],
      {
        cwd: temporary,
        encoding: "utf8",
        env: {
          ...process.env,
          MANAGED_CHROME_OWNER: owner,
          OWNER_CALLS: ownerCalls,
          PATH: `${fakeBin}:${process.env.PATH}`,
          POWERSHELL_CALLS: powershellCalls,
          PWCLI_POWERSHELL: powershell,
          PWCLI_TEST_WSL: "1",
          PWCLI_WSLINFO: wslinfo,
          PWCLI_WSLPATH: wslpath,
        },
      },
    );
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr ?? "", /mirrored networking/u);
    assert.equal(
      await readFile(ownerCalls, "utf8").then(() => true, () => false),
      false,
    );
    assert.equal(
      await readFile(powershellCalls, "utf8").then(() => true, () => false),
      false,
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
