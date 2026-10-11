import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Play,
  RotateCcw,
  Search,
  Terminal,
  X,
} from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RunHistoryEntry } from "../App";
import type { AppAction, AppState, Header, RequestResult } from "../types";
import {
  exportFileName,
  failedAssertions,
  failedDataRows,
  isFailedResult,
  latencyStats,
  resultsToCsv,
  resultsToHtml,
  runUsedDataRows,
} from "../utils/runResults";

interface Props {
  run: RunHistoryEntry | null;
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  onNewRun: () => void;
  onRerun?: (run: RunHistoryEntry) => void;
  onRerunFailed?: (run: RunHistoryEntry, rows: number[]) => void;
}

// Rendering thousands of rows at once makes the summary sluggish; show them in
// pages instead.
const PAGE_SIZE = 200;

export function RunSummary({
  run,
  dispatch,
  onNewRun,
  onRerun,
  onRerunFailed,
}: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"summary" | "console">("summary");
  const leftCardRef = useRef<HTMLDivElement>(null);
  const rightCardRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const right = rightCardRef.current;
    const left = leftCardRef.current;
    if (!right || !left) return;
    const sync = () => {
      left.style.height = `${right.offsetHeight}px`;
    };
    const observer = new ResizeObserver(sync);
    observer.observe(right);
    sync();
    return () => observer.disconnect();
  }, [run, tab]);

  if (!run) return null;

  const exitCode = run.outputLines.find((l) => l.startsWith("__exit:"));
  const success = (!exitCode || exitCode === "__exit:0") && run.failed === 0;
  const times = run.requestResults.map((r) => r.response_time);
  const avgLatency =
    times.length > 0
      ? Math.round(times.reduce((s, x) => s + x, 0) / times.length)
      : 0;
  const minLatency = times.length > 0 ? Math.min(...times) : 0;
  const maxLatency = times.length > 0 ? Math.max(...times) : 0;

  // Prefer the authoritative JSON-report count; fall back to scraping the CLI
  // table for runs recorded before that field existed.
  const assertions =
    run.assertionsTotal ?? parseCount(run.outputLines, /assertions\s+(\d+)/);
  const passedDenominator = run.checksTotal ?? run.total;
  const recentResponses = run.requestResults.slice(0, 5);
  const failedResults = run.requestResults.filter(isFailedResult);
  const retryRows = runUsedDataRows(run) ? failedDataRows(run) : [];

  async function exportAs(kind: "csv" | "html") {
    if (!run) return;
    try {
      await invoke<boolean>("save_export_file", {
        defaultName: exportFileName(run, kind),
        filterName: kind === "csv" ? "CSV" : "HTML",
        extension: kind,
        content: kind === "csv" ? resultsToCsv(run) : resultsToHtml(run),
      });
    } catch (e) {
      dispatch({ type: "SET_ERROR", payload: String(e) });
    }
  }

  return (
    <div
      className={`result-panel${tab === "console" ? " result-panel--console" : ""}`}
    >
      <div className="result-header">
        <div className="result-breadcrumb">
          {run.collectionName} · Run #{run.id % 1000}
        </div>
        <div
          className={`result-status ${success ? "result-status--pass" : "result-status--fail"}`}
        >
          {success ? (
            <>
              <Check size={13} /> Passed
            </>
          ) : (
            <>
              <X size={13} /> Failed
            </>
          )}
          <span className="result-duration">
            {" "}
            in {(run.duration / 1000).toFixed(1)}s
          </span>
        </div>
        <div className="result-tabs">
          <button
            className={`result-tab ${tab === "summary" ? "result-tab--active" : ""}`}
            onClick={() => setTab("summary")}
          >
            Summary
          </button>
          <button
            className={`result-tab ${tab === "console" ? "result-tab--active" : ""}`}
            onClick={() => setTab("console")}
          >
            <Terminal size={12} /> Console
          </button>
        </div>
        <ExportMenu
          disabled={run.requestResults.length === 0}
          onExport={(kind) => void exportAs(kind)}
        />
        {onRerunFailed && retryRows.length > 0 && (
          <button
            className="btn btn--sm result-header-btn"
            onClick={() => onRerunFailed(run, retryRows)}
            title={t("rerunFailedTitle")}
          >
            <RotateCcw size={13} />{" "}
            {t("rerunFailed", { count: retryRows.length })}
          </button>
        )}
        <button
          className="btn btn--primary btn--sm re-run-btn"
          onClick={() => (onRerun ? onRerun(run) : onNewRun())}
        >
          <Play size={13} /> Re-Run
        </button>
      </div>

      <div className="result-panel-scroll">
        {tab === "console" && (
          <div className="console-output console-output--summary">
            {run.outputLines
              .filter((l) => !l.startsWith("__exit:"))
              .map((line, i) => {
                const clean = stripAnsi(line);
                return (
                  <div
                    key={i}
                    className={`console-line ${getConsoleLineClass(clean)}`}
                  >
                    {clean}
                  </div>
                );
              })}
            {run.outputLines.length === 0 && (
              <div className="console-line">{t("noOutput")}</div>
            )}
          </div>
        )}

        {tab === "summary" && (
          <>
            <div className="result-stat-grid">
              <StatCard
                label="PASSED"
                value={`${run.passed}`}
                sub={`/${passedDenominator}`}
                highlight={success ? "pass" : undefined}
              />
              <StatCard
                label="ASSERTIONS"
                value={String(assertions)}
                sub={assertions === 0 ? "no scripts" : undefined}
              />
              <StatCard
                label="AVG LATENCY"
                value={`${avgLatency}`}
                unit="ms"
                sub={`range ${minLatency}-${maxLatency}ms`}
              />
              <StatCard
                label="DATA ROWS"
                value={String(run.total)}
                sub={
                  run.runConfig.dataFile
                    ? run.runConfig.dataFile.split(/[\\/]/).pop()
                    : undefined
                }
              />
            </div>

            {failedResults.length > 0 && (
              <FailuresSection
                results={failedResults}
                showIter={run.total > 1}
              />
            )}

            <div className="result-charts-row">
              <div
                ref={leftCardRef}
                className="result-section result-section--chart"
              >
                <div className="result-section-header">
                  <span className="result-section-title">
                    {t("responseTime")}
                  </span>
                  <span className="result-section-meta">
                    {t("msOver", { count: run.total })}
                  </span>
                </div>
                <ResponseChart
                  results={run.requestResults}
                  noDataText={t("noData")}
                />
              </div>

              <div
                ref={rightCardRef}
                className="result-section result-section--responses"
              >
                <div className="result-section-header">
                  <span className="result-section-title">
                    {t("recentResponses")}
                  </span>
                  <span className="result-section-meta">
                    {t("latest", { count: recentResponses.length })}
                  </span>
                </div>
                <div className="recent-responses">
                  {recentResponses.map((r, i) => (
                    <RecentResponseRow key={i} result={r} index={i + 1} />
                  ))}
                  {recentResponses.length === 0 && (
                    <div className="drawer-empty">{t("noResponses")}</div>
                  )}
                </div>
              </div>
            </div>

            {run.requestResults.length > 0 && (
              <LatencySection results={run.requestResults} />
            )}

            {run.requestResults.length > 0 && (
              <AllResponsesSection
                // Reset filters/paging when switching runs.
                key={run.id}
                results={run.requestResults}
                showIter={run.total > 1}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ExportMenu({
  disabled,
  onExport,
}: {
  disabled: boolean;
  onExport: (kind: "csv" | "html") => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(kind: "csv" | "html") {
    setOpen(false);
    onExport(kind);
  }

  return (
    <div className="export-menu" ref={ref}>
      <button
        className="btn btn--sm result-header-btn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Download size={13} /> {t("export")}
      </button>
      {open && (
        <div className="export-menu-popover">
          <button onClick={() => pick("csv")}>
            <span>CSV</span>
            <span className="export-menu-desc">{t("exportCsvDesc")}</span>
          </button>
          <button onClick={() => pick("html")}>
            <span>HTML</span>
            <span className="export-menu-desc">{t("exportHtmlDesc")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function FailuresSection({
  results,
  showIter,
}: {
  results: RequestResult[];
  showIter: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 8;
  const shown = expanded ? results : results.slice(0, LIMIT);

  return (
    <div className="result-section result-section--failures">
      <div className="result-section-header">
        <span className="result-section-title">
          <AlertCircle size={13} /> {t("failures")}
        </span>
        <span className="result-section-meta">
          {t("failedRequests", { count: results.length })}
        </span>
      </div>
      <div className="failure-list">
        {shown.map((r, i) => (
          <div key={i} className="failure-item">
            <div className="failure-item-head">
              <span className="req-method">{r.method}</span>
              <span className="failure-item-name">{r.name}</span>
              {showIter && <span className="req-iter">#{r.iteration + 1}</span>}
              <span className="req-status req-status--error">
                {r.status || "–"}
              </span>
            </div>
            <FailureReasons result={r} />
          </div>
        ))}
      </div>
      {results.length > LIMIT && (
        <button
          className="btn btn--sm btn--ghost failure-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? t("showLess")
            : t("showAllFailures", { count: results.length })}
        </button>
      )}
    </div>
  );
}

function FailureReasons({ result }: { result: RequestResult }) {
  const { t } = useTranslation();
  const failed = failedAssertions(result);
  return (
    <ul className="failure-reasons">
      {result.error && (
        <li>
          <span className="failure-reason-name">{t("requestError")}</span>
          {result.error}
        </li>
      )}
      {failed.map((a, i) => (
        <li key={i}>
          <span className="failure-reason-name">{a.name}</span>
          {a.error}
        </li>
      ))}
      {!result.error && failed.length === 0 && (
        <li>
          <span className="failure-reason-name">HTTP {result.status}</span>
          {t("httpErrorNoTests")}
        </li>
      )}
    </ul>
  );
}

function LatencySection({ results }: { results: RequestResult[] }) {
  const { t } = useTranslation();
  const stats = latencyStats(results);
  const scaleMax = Math.max(1, ...stats.map((s) => s.max));

  return (
    <div className="result-section">
      <div className="result-section-header">
        <span className="result-section-title">{t("latencyPerRequest")}</span>
        <span className="result-section-meta">ms</span>
      </div>
      <div className="latency-table-wrap">
        <table className="latency-table">
          <thead>
            <tr>
              <th>Request</th>
              <th className="num">{t("runsCol")}</th>
              <th className="num">Min</th>
              <th className="num">Median</th>
              <th className="num">p95</th>
              <th className="num">Max</th>
              <th className="latency-bar-col" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.key}>
                <td>
                  <span className="req-method">{s.method}</span> {s.name}
                  {s.failed > 0 && (
                    <span className="latency-failed">
                      {t("failedShort", { count: s.failed })}
                    </span>
                  )}
                </td>
                <td className="num">{s.count}</td>
                <td className="num">{s.min}</td>
                <td className="num">{s.median}</td>
                <td className="num">{s.p95}</td>
                <td className="num">{s.max}</td>
                <td className="latency-bar-col">
                  {/* Range bar: min→max track, median tick, p95 fill. */}
                  <div
                    className="latency-bar"
                    title={`min ${s.min} · median ${s.median} · p95 ${s.p95} · max ${s.max}`}
                  >
                    <span
                      className="latency-bar-range"
                      style={{
                        left: `${(s.min / scaleMax) * 100}%`,
                        width: `${((s.max - s.min) / scaleMax) * 100}%`,
                      }}
                    />
                    <span
                      className="latency-bar-p95"
                      style={{
                        left: `${(s.min / scaleMax) * 100}%`,
                        width: `${((s.p95 - s.min) / scaleMax) * 100}%`,
                      }}
                    />
                    <span
                      className="latency-bar-median"
                      style={{ left: `${(s.median / scaleMax) * 100}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  unit,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  unit?: string;
  highlight?: "pass" | "fail";
}) {
  return (
    <div
      className={`result-stat-card ${highlight ? `result-stat-card--${highlight}` : ""}`}
    >
      <div className="result-stat-label">{label}</div>
      <div className="result-stat-value">
        {value}
        {unit && <span className="result-stat-unit">{unit}</span>}
        {label === "PASSED" && (
          <span className="result-stat-sub-inline">{sub}</span>
        )}
      </div>
      {sub && label !== "PASSED" && (
        <div className="result-stat-sub">{sub}</div>
      )}
    </div>
  );
}

function ResponseChart({
  results,
  noDataText,
}: {
  results: RequestResult[];
  noDataText: string;
}) {
  if (results.length === 0) {
    return <div className="chart-empty">{noDataText}</div>;
  }
  const max = Math.max(...results.map((r) => r.response_time), 1);
  const min = Math.min(...results.map((r) => r.response_time));

  const PAD_TOP = 8;
  const PAD_BOTTOM = 8;
  const chartH = 100 - PAD_TOP - PAD_BOTTOM;

  const yOf = (v: number) =>
    PAD_TOP + chartH - ((v - min) / (max - min || 1)) * chartH;
  const xOf = (i: number) =>
    results.length === 1 ? 50 : (i / (results.length - 1)) * 100;

  const yLabels: [number, number][] = [
    [max, PAD_TOP],
    [Math.round((max + min) / 2), PAD_TOP + chartH / 2],
    [min, PAD_TOP + chartH],
  ];

  return (
    <div className="response-chart">
      <div className="response-chart-labels">
        {yLabels.map(([val, pct]) => (
          <span
            key={pct}
            className="response-chart-label"
            style={{ top: `${pct}%` }}
          >
            {val}
          </span>
        ))}
      </div>
      <svg
        className="response-chart-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {yLabels.map(([, pct]) => (
          <line
            key={pct}
            x1={0}
            y1={pct}
            x2={100}
            y2={pct}
            stroke="var(--border)"
            strokeWidth="0.4"
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          points={results
            .map((r, i) => `${xOf(i)},${yOf(r.response_time)}`)
            .join(" ")}
        />
      </svg>
    </div>
  );
}

function RecentResponseRow({
  result,
  index,
}: {
  result: RequestResult;
  index: number;
}) {
  const statusOk = !isFailedResult(result);
  return (
    <div className="recent-response-row">
      <span
        className={`req-method-badge req-method-badge--${result.method.toLowerCase()}`}
      >
        {result.method}
      </span>
      <span className="recent-response-name">{result.name}</span>
      <span className="recent-response-index">#{index}</span>
      <span
        className={`recent-response-status ${statusOk ? "recent-response-status--ok" : "recent-response-status--err"}`}
      >
        {result.status || "–"}
      </span>
      <span className="recent-response-time">{result.response_time}ms</span>
    </div>
  );
}

function AllResponsesSection({
  results,
  showIter,
}: {
  results: RequestResult[];
  showIter: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const q = query.trim().toLowerCase();
  const filtered = results.filter((r) => {
    if (onlyFailed && !isFailedResult(r)) return false;
    if (!q) return true;
    // `#12` jumps to an iteration; anything else matches name, URL, status
    // or a failure message.
    const iterMatch = /^#(\d+)$/.exec(q);
    if (iterMatch) return r.iteration + 1 === Number(iterMatch[1]);
    return (
      r.name.toLowerCase().includes(q) ||
      r.url.toLowerCase().includes(q) ||
      String(r.status) === q ||
      (r.error ?? "").toLowerCase().includes(q) ||
      failedAssertions(r).some(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.error ?? "").toLowerCase().includes(q),
      )
    );
  });
  const failedCount = results.filter(isFailedResult).length;

  return (
    <div className="result-section">
      <div className="result-section-header">
        <span className="result-section-title">{t("allResponses")}</span>
        <span className="result-section-meta">
          {filtered.length === results.length
            ? results.length
            : `${filtered.length} / ${results.length}`}
        </span>
      </div>
      <div className="responses-toolbar">
        <div className="responses-search">
          <Search size={13} />
          <input
            placeholder={t("searchResponses")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE_SIZE);
            }}
          />
          {query && (
            <button onClick={() => setQuery("")} title={t("clear")}>
              <X size={12} />
            </button>
          )}
        </div>
        <label
          className={`responses-filter-chip${onlyFailed ? " responses-filter-chip--active" : ""}`}
        >
          <input
            type="checkbox"
            checked={onlyFailed}
            onChange={(e) => {
              setOnlyFailed(e.target.checked);
              setLimit(PAGE_SIZE);
            }}
          />
          {t("onlyFailed", { count: failedCount })}
        </label>
      </div>
      {filtered.slice(0, limit).map((r, i) => (
        <RequestResultRow key={i} result={r} showIter={showIter} />
      ))}
      {filtered.length === 0 && (
        <div className="drawer-empty responses-empty">{t("noMatches")}</div>
      )}
      {filtered.length > limit && (
        <button
          className="btn btn--sm btn--ghost failure-more"
          onClick={() => setLimit((l) => l + PAGE_SIZE)}
        >
          {t("showMore", { count: filtered.length - limit })}
        </button>
      )}
    </div>
  );
}

type DetailTab = "tests" | "response" | "headers" | "request";

function RequestResultRow({
  result,
  showIter,
}: {
  result: RequestResult;
  showIter: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const failed = isFailedResult(result);
  const hasTests = (result.assertions ?? []).length > 0 || !!result.error;
  const [detail, setDetail] = useState<DetailTab>(
    failed && hasTests ? "tests" : "response",
  );
  const statusClass = failed ? "req-status--error" : "req-status--ok";

  const tabs: [DetailTab, string][] = [
    ["tests", t("detailTests")],
    ["response", t("detailResponse")],
    ["headers", t("detailHeaders")],
    ["request", t("detailRequest")],
  ];

  return (
    <div
      className={`req-row ${open ? "req-row--open" : ""} ${failed ? "req-row--failed" : ""}`}
    >
      <button className="req-row__header" onClick={() => setOpen((v) => !v)}>
        <span className="req-method">{result.method}</span>
        <span className="req-name">{result.name}</span>
        {showIter && <span className="req-iter">#{result.iteration + 1}</span>}
        {failed && <AlertCircle size={12} className="req-failed-icon" />}
        <span className={`req-status ${statusClass}`}>
          {result.status || "–"}
        </span>
        <span className="req-time">{result.response_time}ms</span>
        <span className="req-chevron">
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>
      {open && (
        <div className="req-body-wrap">
          <div className="req-detail-tabs">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                className={`req-detail-tab${detail === id ? " req-detail-tab--active" : ""}`}
                onClick={() => setDetail(id)}
              >
                {label}
                {id === "tests" && (result.assertions ?? []).length > 0 && (
                  <span className="req-detail-count">
                    {(result.assertions ?? []).length}
                  </span>
                )}
              </button>
            ))}
          </div>
          {detail === "tests" && <TestsDetail result={result} />}
          {detail === "response" && (
            <>
              <pre className="req-body">
                {tryFormatJson(result.response_body) || t("emptyResponse")}
              </pre>
              {result.response_truncated && (
                <div className="req-detail-note">{t("bodyTruncated")}</div>
              )}
            </>
          )}
          {detail === "headers" && (
            <HeaderTable headers={result.response_headers} />
          )}
          {detail === "request" && (
            <div className="req-detail-request">
              <div className="req-detail-url">
                <span className="req-method">{result.method}</span>
                <code>{result.url || "–"}</code>
              </div>
              <HeaderTable headers={result.request_headers} />
              {result.request_body && (
                <pre className="req-body">
                  {tryFormatJson(result.request_body)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TestsDetail({ result }: { result: RequestResult }) {
  const { t } = useTranslation();
  const list = result.assertions ?? [];
  if (list.length === 0 && !result.error) {
    return <div className="req-detail-note">{t("noTests")}</div>;
  }
  return (
    <ul className="test-list">
      {result.error && (
        <li className="test-item test-item--fail">
          <X size={12} />
          <span>
            <span className="test-name">{t("requestError")}</span>
            <span className="test-error">{result.error}</span>
          </span>
        </li>
      )}
      {list.map((a, i) => {
        const state = a.skipped ? "skip" : a.error ? "fail" : "pass";
        return (
          <li key={i} className={`test-item test-item--${state}`}>
            {state === "pass" ? (
              <Check size={12} />
            ) : state === "fail" ? (
              <X size={12} />
            ) : (
              <span className="test-skip-dot">–</span>
            )}
            <span>
              <span className="test-name">{a.name}</span>
              {a.error && <span className="test-error">{a.error}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function HeaderTable({ headers }: { headers: Header[] | undefined }) {
  const { t } = useTranslation();
  if (!headers || headers.length === 0) {
    return <div className="req-detail-note">{t("noHeaders")}</div>;
  }
  return (
    <table className="header-table">
      <tbody>
        {headers.map((h, i) => (
          <tr key={i}>
            <th>{h.key}</th>
            <td>{h.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-9;]*m`,
  "g",
);

function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE_RE, "");
}

function getConsoleLineClass(line: string): string {
  if (
    line.includes("failed") ||
    line.includes("AssertionError") ||
    line.includes("[stderr]")
  )
    return "console-line--error";
  if (line.includes("✓") || line.includes("passed"))
    return "console-line--success";
  if (line.startsWith("→") || /^\s+(GET|POST|PUT|DELETE|PATCH)/.test(line))
    return "console-line--request";
  return "";
}

function tryFormatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function parseCount(lines: string[], re: RegExp): number {
  for (const line of lines) {
    const strip = line.replace(/[│├└┤┐┘┌┼─\s]/g, " ").trim();
    const m = strip.match(re);
    if (m) return parseInt(m[1]);
  }
  return 0;
}
