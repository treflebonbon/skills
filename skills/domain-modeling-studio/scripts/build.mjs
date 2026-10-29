import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  cp,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { join, dirname, resolve } = path;

const root = fileURLToPath(new URL("../", import.meta.url));
// Keep npm's installation outside the skill tree: chezmoi deploys every skill file.
const buildDir = await mkdtemp(join(tmpdir(), "domain-studio-build-"));
await Promise.all(
  ["package.json", "package-lock.json"].map((file) =>
    cp(join(root, file), join(buildDir, file))
  )
);
await cp(join(root, "src"), join(buildDir, "src"), { recursive: true });
execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: buildDir,
  stdio: "inherit",
});
const { build } = await import(
  pathToFileURL(join(buildDir, "node_modules/esbuild/lib/main.js"))
);
const result = await build({
  absWorkingDir: buildDir,
  bundle: true,
  define: { "process.env.NODE_ENV": '"production"' },
  entryPoints: ["src/app.jsx"],
  format: "iife",
  legalComments: "inline",
  metafile: true,
  minify: true,
  outfile: "editor.js",
  target: "es2022",
  write: false,
});
const js = result.outputFiles
  .find((f) => f.path.endsWith(".js"))
  .text.replaceAll("</script", "<\\/script");
const css = result.outputFiles.find((f) => f.path.endsWith(".css")).text;
const packageLicense = async (dir) => {
  if (!dir.startsWith(join(buildDir, "node_modules"))) {
    return null;
  }
  const files = await readdir(dir);
  if (!files.includes("package.json")) {
    return packageLicense(dirname(dir));
  }
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
  const names = files.filter((name) => /^licen[sc]e(?:\.|$)/iu.test(name));
  if (!names.length) {
    return null;
  }
  const texts = await Promise.all(
    names.map((name) => readFile(join(dir, name), "utf-8"))
  );
  return [pkg.name, `${pkg.name}@${pkg.version}\n${texts.join("\n")}`];
};
const found = await Promise.all(
  Object.keys(result.metafile.inputs)
    .filter((input) => input.includes("node_modules/"))
    .map((input) => packageLicense(dirname(resolve(buildDir, input))))
);
const licenses = new Map(found.filter(Boolean));
const notices = [...licenses.values()].join("\n\n---\n\n");
const html = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><link rel="icon" href="data:,"><title>ドメインモデリング・スタジオ</title><style>${css}</style></head><body><div id="root"></div><script type="application/json" id="studio-document">__STUDIO_DOCUMENT__</script><script>${js}</script><!-- ${notices.replaceAll("--", "—")} --></body></html>`;
await mkdir(join(root, "dist"), { recursive: true });
await writeFile(join(root, "dist/studio.html"), html);
await writeFile(join(root, "dist/THIRD-PARTY-LICENSES.txt"), notices);
console.log(
  `Built ${Buffer.byteLength(html)} bytes. Build dependencies retained outside skill: ${buildDir}`
);
