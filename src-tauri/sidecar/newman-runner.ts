/**
 * Newman sidecar — a long-lived Bun process driven over stdin.
 *
 * The Rust backend spawns this once at app start and keeps it warm, which
 * avoids the ~1–2 s `cmd.exe` + Node bootstrap cost that the previous
 * `cmd /c newman` approach paid on every run.
 *
 * Protocol
 * --------
 * Rust → sidecar: one JSON command per line on stdin, e.g.
 *   {"cmd":"run","collectionPath":"…","folder":null,"dataFile":null,
 *    "envFile":null,"iterations":1,"reportPath":"…"}
 *
 * sidecar → Rust: newman's `cli` reporter writes human-readable output
 *   straight to stdout (Rust forwards it verbatim as `newman://output`).
 *   Structured control messages are written as a single line prefixed with
 *   CTRL so Rust can tell them apart from reporter output:
 *     <CTRL>{"type":"ready","newmanVersion":"6.2.2"}
 *     <CTRL>{"type":"done","code":0}
 *
 * Cancellation is handled entirely on the Rust side by killing this process
 * and respawning a fresh one, so there is no `cancel` command here.
 */
import { createInterface } from "node:readline";
import newman from "newman";
// Bundled at build time by `bun build --compile`; gives us the exact newman
// version to show in the UI badge.
import { version as NEWMAN_VERSION } from "newman/package.json";

/** Marker prefixing every control line. Newman reporter output never emits it. */
const CTRL = "__NEWMAN_RUNNER__";

interface RunCommand {
  cmd: "run";
  collectionPath: string;
  folder?: string | null;
  dataFile?: string | null;
  envFile?: string | null;
  iterations?: number;
  reportPath: string;
}

function control(payload: Record<string, unknown>): void {
  process.stdout.write(CTRL + JSON.stringify(payload) + "\n");
}

let running = false;

function handleRun(command: RunCommand): void {
  if (running) {
    // Rust guarantees one run at a time (it kills+respawns to supersede a
    // run), so this is defensive only.
    control({ type: "done", code: 1 });
    return;
  }
  running = true;

  // Always respect the explicit iteration count.
  // With a data file: fewer iterations → stops early using first N rows;
  // more iterations → cycles through the data file from the beginning.
  const iterationCount = (command.iterations ?? 1) > 1 ? command.iterations : undefined;

  newman.run(
    {
      collection: command.collectionPath,
      folder: command.folder || undefined,
      iterationData: command.dataFile || undefined,
      iterationCount,
      environment: command.envFile || undefined,
      reporters: ["cli", "json"],
      reporter: { json: { export: command.reportPath } },
    },
    (err, summary) => {
      running = false;
      const failed = Boolean(err) || (summary?.run?.failures?.length ?? 0) > 0;
      if (err) {
        process.stderr.write(String(err.message ?? err) + "\n");
      }
      control({ type: "done", code: failed ? 1 : 0 });
    }
  );
}

function dispatch(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: RunCommand;
  try {
    msg = JSON.parse(trimmed) as RunCommand;
  } catch {
    process.stderr.write(`invalid command: ${trimmed}\n`);
    return;
  }
  if (msg.cmd === "run") handleRun(msg);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", dispatch);
// Keep the process alive once stdin closes only if a run is still streaming;
// otherwise exit so the OS reclaims us when the parent app goes away.
rl.on("close", () => {
  if (!running) process.exit(0);
});

// Announce readiness (and the bundled newman version) so Rust can answer
// `check_newman` for the UI badge.
control({ type: "ready", newmanVersion: NEWMAN_VERSION });
