import React, { useState, useRef, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, X, ChevronUp, ChevronDown, Play, Terminal } from "lucide-react";
import { AppAction, AppState, RequestResult } from "../types";
import { RunHistoryEntry } from "../App";

interface Props {
  run: RunHistoryEntry | null;
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  onNewRun: () => void;
  onRerun?: (run: RunHistoryEntry) => void;
}

export function RunSummary({ run, onNewRun, onRerun }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"summary" | "console">("summary");
  const leftCardRef = useRef<HTMLDivElement>(null);
  const rightCardRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const right = rightCardRef.current;
    const left = leftCardRef.current;
    if (!right || !left) return;
    const sync = () => { left.style.height = `${right.offsetHeight}px`; };
    const observer = new ResizeObserver(sync);
    observer.observe(right);
    sync();
    return () => observer.disconnect();
  }, [run, tab]);

  if (!run) return null;

  const exitCode = run.outputLines.find(l => l.startsWith("__exit:"));
  const success = (!exitCode || exitCode === "__exit:0") && run.failed === 0;
  const avgLatency = run.requestResults.length > 0
    ? Math.round(run.requestResults.reduce((s, r) => s + r.response_time, 0) / run.requestResults.length)
    : 0;
  const minLatency = run.requestResults.length > 0
    ? Math.min(...run.requestResults.map(r => r.response_time))
    : 0;
  const maxLatency = run.requestResults.length > 0
    ? Math.max(...run.requestResults.map(r => r.response_time))
    : 0;

  // Prefer the authoritative JSON-report count; fall back to scraping the CLI
  // table for runs recorded before that field existed.
  const assertions = run.assertionsTotal ?? parseCount(run.outputLines, /assertions\s+(\d+)/);
  const passedDenominator = run.checksTotal ?? run.total;
  const recentResponses = run.requestResults.slice(0, 5);

  return (
    <div className={`result-panel${tab === "console" ? " result-panel--console" : ""}`}>
      <div className="result-header">
        <div className="result-breadcrumb">{run.collectionName} · Run #{run.id % 1000}</div>
        <div className={`result-status ${success ? "result-status--pass" : "result-status--fail"}`}>
          {success ? <><Check size={13} /> Passed</> : <><X size={13} /> Failed</>}
          <span className="result-duration"> in {(run.duration / 1000).toFixed(1)}s</span>
        </div>
        <div className="result-tabs">
          <button className={`result-tab ${tab === "summary" ? "result-tab--active" : ""}`} onClick={() => setTab("summary")}>Summary</button>
          <button className={`result-tab ${tab === "console" ? "result-tab--active" : ""}`} onClick={() => setTab("console")}><Terminal size={12} /> Console</button>
        </div>
        <button className="btn btn--primary btn--sm re-run-btn" onClick={() => onRerun ? onRerun(run) : onNewRun()}>
          <Play size={13} /> Re-Run
        </button>
      </div>

      <div className="result-panel-scroll">
        {tab === "console" && (
          <div className="console-output console-output--summary">
            {run.outputLines.filter(l => !l.startsWith("__exit:")).map((line, i) => {
              const clean = stripAnsi(line);
              return <div key={i} className={`console-line ${getConsoleLineClass(clean)}`}>{clean}</div>;
            })}
            {run.outputLines.length === 0 && <div className="console-line">{t("noOutput")}</div>}
          </div>
        )}

        {tab === "summary" && (
          <>
            <div className="result-stat-grid">
              <StatCard label="PASSED" value={`${run.passed}`} sub={`/${passedDenominator}`} highlight={success ? "pass" : undefined} />
              <StatCard label="ASSERTIONS" value={String(assertions)} sub={assertions === 0 ? "no scripts" : undefined} />
              <StatCard
                label="AVG LATENCY"
                value={`${avgLatency}`}
                unit="ms"
                sub={`range ${minLatency}-${maxLatency}ms`}
              />
              <StatCard
                label="DATA ROWS"
                value={String(run.total)}
                sub={run.runConfig.dataFile ? run.runConfig.dataFile.split(/[\\/]/).pop() : undefined}
              />
            </div>

            <div className="result-charts-row">
              <div ref={leftCardRef} className="result-section result-section--chart">
                <div className="result-section-header">
                  <span className="result-section-title">{t("responseTime")}</span>
                  <span className="result-section-meta">{t("msOver", { count: run.total })}</span>
                </div>
                <ResponseChart results={run.requestResults} noDataText={t("noData")} />
              </div>

              <div ref={rightCardRef} className="result-section result-section--responses">
                <div className="result-section-header">
                  <span className="result-section-title">{t("recentResponses")}</span>
                  <span className="result-section-meta">{t("latest", { count: recentResponses.length })}</span>
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
              <AllResponsesSection results={run.requestResults} showIter={run.total > 1} title={t("allResponses")} emptyResponse={t("emptyResponse")} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, unit, highlight }: {
  label: string;
  value: string;
  sub?: string;
  unit?: string;
  highlight?: "pass" | "fail";
}) {
  return (
    <div className={`result-stat-card ${highlight ? `result-stat-card--${highlight}` : ""}`}>
      <div className="result-stat-label">{label}</div>
      <div className="result-stat-value">
        {value}
        {unit && <span className="result-stat-unit">{unit}</span>}
        {label === "PASSED" && <span className="result-stat-sub-inline">{sub}</span>}
      </div>
      {sub && label !== "PASSED" && <div className="result-stat-sub">{sub}</div>}
    </div>
  );
}

function ResponseChart({ results, noDataText }: { results: RequestResult[]; noDataText: string }) {
  if (results.length === 0) {
    return <div className="chart-empty">{noDataText}</div>;
  }
  const max = Math.max(...results.map(r => r.response_time), 1);
  const min = Math.min(...results.map(r => r.response_time));

  const PAD_TOP = 8;
  const PAD_BOTTOM = 8;
  const chartH = 100 - PAD_TOP - PAD_BOTTOM;

  const yOf = (v: number) => PAD_TOP + chartH - ((v - min) / (max - min || 1)) * chartH;
  const xOf = (i: number) => results.length === 1 ? 50 : (i / (results.length - 1)) * 100;

  const yLabels: [number, number][] = [
    [max, PAD_TOP],
    [Math.round((max + min) / 2), PAD_TOP + chartH / 2],
    [min, PAD_TOP + chartH],
  ];

  return (
    <div className="response-chart">
      <div className="response-chart-labels">
        {yLabels.map(([val, pct]) => (
          <span key={pct} className="response-chart-label" style={{ top: `${pct}%` }}>{val}</span>
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
            x1={0} y1={pct} x2={100} y2={pct}
            stroke="var(--border)" strokeWidth="0.4" strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          points={results.map((r, i) => `${xOf(i)},${yOf(r.response_time)}`).join(" ")}
        />
      </svg>
    </div>
  );
}

function RecentResponseRow({ result, index }: { result: RequestResult; index: number }) {
  const statusOk = result.status < 400;
  return (
    <div className="recent-response-row">
      <span className={`req-method-badge req-method-badge--${result.method.toLowerCase()}`}>{result.method}</span>
      <span className="recent-response-name">{result.name}</span>
      <span className="recent-response-index">#{index}</span>
      <span className={`recent-response-status ${statusOk ? "recent-response-status--ok" : "recent-response-status--err"}`}>
        {result.status}
      </span>
      <span className="recent-response-time">{result.response_time}ms</span>
    </div>
  );
}

function AllResponsesSection({ results, showIter, title, emptyResponse }: { results: RequestResult[]; showIter: boolean; title: string; emptyResponse: string }) {
  return (
    <div className="result-section">
      <div className="result-section-header">
        <span className="result-section-title">{title}</span>
      </div>
      {results.map((r, i) => (
        <RequestResultRow key={i} result={r} showIter={showIter} emptyResponse={emptyResponse} />
      ))}
    </div>
  );
}

function RequestResultRow({ result, showIter, emptyResponse }: { result: RequestResult; showIter: boolean; emptyResponse: string }) {
  const [open, setOpen] = useState(false);
  const formattedBody = tryFormatJson(result.response_body);
  const statusClass = result.status >= 400 ? "req-status--error" : "req-status--ok";

  return (
    <div className={`req-row ${open ? "req-row--open" : ""}`}>
      <button className="req-row__header" onClick={() => setOpen((v) => !v)}>
        <span className="req-method">{result.method}</span>
        <span className="req-name">{result.name}</span>
        {showIter && <span className="req-iter">#{result.iteration + 1}</span>}
        <span className={`req-status ${statusClass}`}>{result.status}</span>
        <span className="req-time">{result.response_time}ms</span>
        <span className="req-chevron">{open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
      </button>
      {open && (
        <div className="req-body-wrap">
          <pre className="req-body">{formattedBody || emptyResponse}</pre>
        </div>
      )}
    </div>
  );
}

function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function getConsoleLineClass(line: string): string {
  if (line.includes("failed") || line.includes("AssertionError") || line.includes("[stderr]")) return "console-line--error";
  if (line.includes("✓") || line.includes("passed")) return "console-line--success";
  if (line.startsWith("→") || /^\s+(GET|POST|PUT|DELETE|PATCH)/.test(line)) return "console-line--request";
  return "";
}

function tryFormatJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}

function parseCount(lines: string[], re: RegExp): number {
  for (const line of lines) {
    const strip = line.replace(/[│├└┤┐┘┌┼─\s]/g, " ").trim();
    const m = strip.match(re);
    if (m) return parseInt(m[1]);
  }
  return 0;
}
