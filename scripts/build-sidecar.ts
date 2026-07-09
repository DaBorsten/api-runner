/**
 * Compiles the newman sidecar into a standalone executable with
 * `bun build --compile`, named with the Rust host target triple so Tauri's
 * sidecar resolver (`bundle.externalBin`) can find it.
 *
 * Run with: bun run scripts/build-sidecar.ts
 *
 * Why the sandbox-cache step
 * --------------------------
 * newman → postman-runtime → postman-sandbox runs request scripts inside a VM
 * whose "bootcode" is normally either shipped pre-built or live-compiled with
 * browserify + terser. Bun does not run package postinstall scripts, so the
 * pre-built `lib/.cache/bootcode.js` is missing, and bundling browserify into a
 * `--compile` binary is fragile (it resolves node builtins dynamically at
 * runtime). Instead we live-compile the bootcode ONCE here, write it to the
 * cache file, and mark browserify/terser external so they never enter the exe.
 * At runtime postman-sandbox just reads the cached bootcode string.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src-tauri", "sidecar", "newman-runner.ts");
const outDir = join(root, "src-tauri", "binaries");
const require = createRequire(import.meta.url);

/** Pre-compile postman-sandbox's bootcode into its file cache if absent. */
async function ensureSandboxCache(): Promise<void> {
  const sandboxLib = join(root, "node_modules", "postman-sandbox", "lib");
  const cacheFile = join(sandboxLib, ".cache", "bootcode.js");
  if (existsSync(cacheFile)) {
    console.log("Sandbox bootcode cache present.");
    return;
  }
  // postman-sandbox browserifies a curated set of libraries (crypto-js, ajv,
  // cheerio, …) into the bootcode. Those are postman-sandbox's OWN devDeps and
  // are not installed by a normal `bun install`, so install them in-place
  // (version-faithful, scoped to the package, no root-manifest pollution).
  const sandboxRoot = join(root, "node_modules", "postman-sandbox");
  if (!existsSync(join(sandboxRoot, "node_modules", "crypto-js"))) {
    console.log("Installing postman-sandbox build deps (one-time)…");
    const install = Bun.spawnSync(["bun", "install", "--cwd", sandboxRoot], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (install.exitCode !== 0) {
      throw new Error("failed to install postman-sandbox build deps");
    }
  }

  console.log("Generating postman-sandbox bootcode cache…");
  const Bundle = require("postman-sandbox/lib/bundle");
  const env = require("postman-sandbox/lib/environment");
  const code: string = await new Promise((resolve, reject) => {
    Bundle.load(env).compile((err: Error | null, out: string) =>
      err ? reject(err) : resolve(out),
    );
  });
  mkdirSync(dirname(cacheFile), { recursive: true });
  // bootcode.js expects this module to export a `(done) => done(null, code)`
  // function (see postman-sandbox/lib/bootcode.js).
  writeFileSync(
    cacheFile,
    `module.exports = function (done) { return done(null, ${JSON.stringify(code)}); };\n`,
  );
  console.log(`Wrote ${cacheFile} (${code.length} bytes of bootcode).`);
}

/** Parse the host target triple out of `rustc -Vv` (the `host:` line). */
function hostTriple(): string {
  const { stdout, exitCode } = Bun.spawnSync(["rustc", "-Vv"]);
  if (exitCode !== 0) {
    throw new Error("rustc not found — install Rust to build the sidecar.");
  }
  const text = new TextDecoder().decode(stdout);
  const match = text.match(/^host:\s*(\S+)$/m);
  if (!match) throw new Error("could not parse host triple from `rustc -Vv`");
  return match[1];
}

await ensureSandboxCache();

const triple = hostTriple();
const ext = triple.includes("windows") ? ".exe" : "";
const exeName = `newman-runner-${triple}${ext}`;
const outfile = join(outDir, exeName);

// A warm sidecar from a previous `tauri dev` keeps the exe locked on Windows,
// which makes `bun build --compile` fail with EPERM when overwriting it. Kill
// any stale instance first (best-effort) and give the OS a moment to release
// the file handle.
function killStaleSidecar(): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/F", "/IM", exeName], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      Bun.spawnSync(["pkill", "-f", "newman-runner"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  } catch {
    /* nothing to kill */
  }
}

if (existsSync(outfile)) {
  killStaleSidecar();
  Bun.sleepSync(300);
}

mkdirSync(outDir, { recursive: true });

console.log(`Building sidecar → ${outfile}`);
const { exitCode } = Bun.spawnSync(
  [
    "bun",
    "build",
    entry,
    "--compile",
    "--outfile",
    outfile,
    // Build-only modules reachable from postman-sandbox's dead live-compile
    // path; never executed at runtime once the bootcode cache exists.
    "--external",
    "terser",
    "--external",
    "browserify",
  ],
  { stdout: "inherit", stderr: "inherit" },
);

if (exitCode !== 0) process.exit(exitCode);
console.log("Sidecar built.");
