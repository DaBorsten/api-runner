import type { RunHistoryEntry } from "../App";
import type { RequestResult } from "../types";

// ── Failure classification ───────────────────────────────────────────────────

export function failedAssertions(r: RequestResult) {
  return (r.assertions ?? []).filter((a) => a.error && !a.skipped);
}

// A request counts as failed when it never got a response, when any of its
// tests failed, or — for requests without tests — when the status is an HTTP
// error. Requests *with* tests are judged by the tests alone, since a test may
// deliberately expect a 4xx.
export function isFailedResult(r: RequestResult): boolean {
  if (r.error) return true;
  if (r.status === 0) return true;
  const assertions = r.assertions ?? [];
  if (assertions.length > 0) return failedAssertions(r).length > 0;
  return r.status >= 400;
}

export function requestKey(r: Pick<RequestResult, "method" | "name">): string {
  return `${r.method} ${r.name}`;
}

// One-line run summary, shared by the history list and the compare view.
export function runMetaLabel(run: RunHistoryEntry): string {
  const base = `${run.total} iter · ${(run.duration / 1000).toFixed(1)}s`;
  return run.failed > 0 ? `${base} · ${run.failed} fail` : base;
}

// ── Data rows ────────────────────────────────────────────────────────────────

export function runUsedDataRows(entry: RunHistoryEntry): boolean {
  return !!(entry.runConfig.dataFile || entry.runConfig.dataTable);
}

// Map each failed iteration back to the data row it ran with. The backend
// feeds newman the kept rows in ascending index order (`kept_rows` /
// `write_filtered_data_file`), so iteration i ran with the i-th smallest
// selected index — or simply row i when every row was used.
export function failedDataRows(entry: RunHistoryEntry): number[] {
  const failedIterations = new Set(
    entry.requestResults.filter(isFailedResult).map((r) => r.iteration),
  );
  const selected = entry.runConfig.dataRowIndices;
  const order =
    selected === null ? null : [...new Set(selected)].sort((a, b) => a - b);
  const rows: number[] = [];
  for (const it of [...failedIterations].sort((a, b) => a - b)) {
    const row = order === null ? it : order[it];
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

// ── Latency statistics ───────────────────────────────────────────────────────

export interface LatencyStats {
  key: string;
  method: string;
  name: string;
  count: number;
  failed: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  avg: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank method: small samples report an actual observed value.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function latencyStats(results: RequestResult[]): LatencyStats[] {
  const groups = new Map<string, RequestResult[]>();
  for (const r of results) {
    const key = requestKey(r);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const times = list.map((r) => r.response_time).sort((a, b) => a - b);
    return {
      key,
      method: list[0].method,
      name: list[0].name,
      count: list.length,
      failed: list.filter(isFailedResult).length,
      min: times[0],
      median: percentile(times, 50),
      p95: percentile(times, 95),
      max: times[times.length - 1],
      avg: Math.round(times.reduce((s, t) => s + t, 0) / times.length),
    };
  });
}

// ── Run comparison ───────────────────────────────────────────────────────────

export type CompareVerdict =
  | "regressed"
  | "failing"
  | "fixed"
  | "slower"
  | "faster"
  | "unchanged"
  | "added"
  | "removed";

export interface RequestComparison {
  key: string;
  method: string;
  name: string;
  a: LatencyStats | null;
  b: LatencyStats | null;
  verdict: CompareVerdict;
}

// A median shift only counts when it is both relative (±50%) and absolute
// (≥50ms), so fast endpoints jittering between 3ms and 6ms don't show up.
const SLOWER_RATIO = 1.5;
const MIN_DELTA_MS = 50;

function verdictFor(
  a: LatencyStats | null,
  b: LatencyStats | null,
): CompareVerdict {
  if (!a) return "added";
  if (!b) return "removed";
  if (a.failed === 0 && b.failed > 0) return "regressed";
  if (a.failed > 0 && b.failed === 0) return "fixed";
  // Failing in both runs is not "unchanged": it must stay visible.
  if (a.failed > 0 && b.failed > 0) return "failing";
  const delta = b.median - a.median;
  if (delta >= MIN_DELTA_MS && b.median >= a.median * SLOWER_RATIO)
    return "slower";
  if (-delta >= MIN_DELTA_MS && a.median >= b.median * SLOWER_RATIO)
    return "faster";
  return "unchanged";
}

const VERDICT_ORDER: CompareVerdict[] = [
  "regressed",
  "failing",
  "slower",
  "added",
  "removed",
  "fixed",
  "faster",
  "unchanged",
];

// `a` is the baseline (older) run, `b` the one being checked against it.
export function compareRuns(
  a: RunHistoryEntry,
  b: RunHistoryEntry,
): RequestComparison[] {
  const statsA = new Map(latencyStats(a.requestResults).map((s) => [s.key, s]));
  const statsB = new Map(latencyStats(b.requestResults).map((s) => [s.key, s]));
  const keys = [...new Set([...statsA.keys(), ...statsB.keys()])];
  return keys
    .map((key) => {
      const sa = statsA.get(key) ?? null;
      const sb = statsB.get(key) ?? null;
      const ref = (sb ?? sa)!;
      return {
        key,
        method: ref.method,
        name: ref.name,
        a: sa,
        b: sb,
        verdict: verdictFor(sa, sb),
      };
    })
    .sort(
      (x, y) =>
        VERDICT_ORDER.indexOf(x.verdict) - VERDICT_ORDER.indexOf(y.verdict),
    );
}

// ── Export ───────────────────────────────────────────────────────────────────

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function resultsToCsv(entry: RunHistoryEntry): string {
  const header = [
    "iteration",
    "request",
    "method",
    "url",
    "status",
    "response_time_ms",
    "result",
    "failed_tests",
    "error",
  ];
  const lines = entry.requestResults.map((r) =>
    [
      r.iteration + 1,
      r.name,
      r.method,
      r.url,
      r.status,
      r.response_time,
      isFailedResult(r) ? "failed" : "passed",
      failedAssertions(r)
        .map((a) => `${a.name}: ${a.error}`)
        .join(" | "),
      r.error ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  // BOM so Excel opens UTF-8 (umlauts in request names) correctly.
  return "﻿" + [header.join(","), ...lines].join("\r\n");
}

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A self-contained HTML report (no external assets) that can be mailed or
// attached to a ticket.
export function resultsToHtml(entry: RunHistoryEntry): string {
  const failed = entry.requestResults.filter(isFailedResult);
  const stats = latencyStats(entry.requestResults);
  const when = entry.timestamp.toLocaleString();
  const passedTotal = entry.checksTotal ?? entry.total;

  const statRows = stats
    .map(
      (s) => `<tr${s.failed > 0 ? ' class="fail"' : ""}>
  <td><b>${esc(s.method)}</b> ${esc(s.name)}</td><td>${s.count}</td><td>${s.failed}</td>
  <td>${s.min}</td><td>${s.median}</td><td>${s.p95}</td><td>${s.max}</td></tr>`,
    )
    .join("\n");

  const execRows = entry.requestResults
    .map((r) => {
      const bad = isFailedResult(r);
      const details = [
        ...failedAssertions(r).map(
          (a) => `<div>✗ ${esc(a.name)}: ${esc(a.error ?? "")}</div>`,
        ),
        r.error ? `<div>✗ ${esc(r.error)}</div>` : "",
      ].join("");
      return `<tr${bad ? ' class="fail"' : ""}>
  <td>${r.iteration + 1}</td><td><b>${esc(r.method)}</b> ${esc(r.name)}<div class="url">${esc(r.url)}</div>${details}</td>
  <td>${r.status || "–"}</td><td>${r.response_time}</td><td>${bad ? "✗" : "✓"}</td></tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(entry.collectionName)} – API Runner report</title>
<style>
  :root { color-scheme: light dark; --fail: #d92d20; --ok: #12833f; --border: #8884; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 24px 16px; max-width: 1100px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 8px; }
  .meta { opacity: .7; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
  .card b { display: block; font-size: 22px; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr.fail td { color: var(--fail); }
  .url { font: 12px ui-monospace, monospace; opacity: .7; word-break: break-all; }
  .pass { color: var(--ok); } .failtxt { color: var(--fail); }
</style></head><body>
<h1>${esc(entry.collectionName)}</h1>
<div class="meta">${esc(when)} · ${(entry.duration / 1000).toFixed(1)}s</div>
<div class="cards">
  <div class="card">Result<b class="${entry.failed === 0 ? "pass" : "failtxt"}">${entry.failed === 0 ? "Passed" : "Failed"}</b></div>
  <div class="card">Passed checks<b>${entry.passed}/${passedTotal}</b></div>
  <div class="card">Iterations<b>${entry.total}</b></div>
  <div class="card">Requests<b>${entry.requestResults.length}</b></div>
  <div class="card">Failed requests<b>${failed.length}</b></div>
</div>
<h2>Response times per request (ms)</h2>
<div class="table-wrap"><table>
<thead><tr><th>Request</th><th>Runs</th><th>Failed</th><th>Min</th><th>Median</th><th>p95</th><th>Max</th></tr></thead>
<tbody>${statRows}</tbody></table></div>
<h2>All requests</h2>
<div class="table-wrap"><table>
<thead><tr><th>#</th><th>Request</th><th>Status</th><th>ms</th><th></th></tr></thead>
<tbody>${execRows}</tbody></table></div>
</body></html>`;
}

export function exportFileName(entry: RunHistoryEntry, ext: string): string {
  const base = entry.collectionName.replace(/[\\/:*?"<>|]+/g, "_").trim();
  const d = entry.timestamp;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${base || "run"}_${stamp}.${ext}`;
}
