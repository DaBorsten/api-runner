import { ArrowLeftRight, ArrowRight, GitCompare, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RunHistoryEntry } from "../App";
import {
  type CompareVerdict,
  compareRuns,
  type LatencyStats,
  runMetaLabel,
} from "../utils/runResults";

interface Props {
  baseline: RunHistoryEntry;
  candidate: RunHistoryEntry;
  onSwap: () => void;
  onClose: () => void;
}

const VERDICT_CLASS: Record<CompareVerdict, string> = {
  regressed: "bad",
  failing: "bad",
  slower: "warn",
  added: "neutral",
  removed: "neutral",
  fixed: "good",
  faster: "good",
  unchanged: "neutral",
};

function RunLabel({ run, role }: { run: RunHistoryEntry; role: string }) {
  const { i18n } = useTranslation();
  return (
    <div className="compare-run">
      <span className="compare-run-role">{role}</span>
      <span className="compare-run-name">
        <span
          className={`history-dot ${run.failed > 0 ? "history-dot--fail" : "history-dot--pass"}`}
        />
        <span className="compare-run-name-text">{run.collectionName}</span>
      </span>
      <span className="compare-run-meta">
        {run.timestamp.toLocaleString(i18n.language)} · {runMetaLabel(run)}
      </span>
    </div>
  );
}

function Cell({ s }: { s: LatencyStats | null }) {
  const { t } = useTranslation();
  if (!s) return <td className="num compare-missing">–</td>;
  return (
    <td className="num">
      {s.median}ms
      {s.failed > 0 && (
        <span className="latency-failed">
          {t("failedShort", { count: s.failed })}
        </span>
      )}
    </td>
  );
}

function Delta({ a, b }: { a: LatencyStats | null; b: LatencyStats | null }) {
  if (!a || !b) return <td className="num compare-missing">–</td>;
  const d = b.median - a.median;
  const pct = a.median > 0 ? Math.round((d / a.median) * 100) : 0;
  const cls = d > 0 ? "compare-delta--up" : d < 0 ? "compare-delta--down" : "";
  return (
    <td className={`num compare-delta ${cls}`}>
      {d > 0 ? "+" : ""}
      {d}ms
      {a.median > 0 && d !== 0 && (
        <span className="compare-sub">
          {" "}
          ({d > 0 ? "+" : ""}
          {pct}%)
        </span>
      )}
    </td>
  );
}

// Side-by-side comparison of two runs, per request: failures that appeared or
// went away, and notable median response-time shifts.
export function RunCompare({ baseline, candidate, onSwap, onClose }: Props) {
  const { t } = useTranslation();
  const [showUnchanged, setShowUnchanged] = useState(false);
  const rows = compareRuns(baseline, candidate);

  const counts = rows.reduce<Partial<Record<CompareVerdict, number>>>(
    (acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }),
    {},
  );
  const visible = showUnchanged
    ? rows
    : rows.filter((r) => r.verdict !== "unchanged");

  return (
    <div className="result-panel">
      <div className="result-header">
        <div className="result-status">
          <GitCompare size={13} /> {t("compareRuns")}
        </div>
        <button className="btn btn--sm result-header-btn" onClick={onSwap}>
          <ArrowLeftRight size={13} /> {t("swap")}
        </button>
        <button className="btn btn--sm result-header-btn" onClick={onClose}>
          <X size={13} /> {t("close")}
        </button>
      </div>

      <div className="result-panel-scroll">
        <div className="compare-runs">
          <RunLabel run={baseline} role={t("compareBaseline")} />
          <ArrowRight size={16} className="compare-arrow" />
          <RunLabel run={candidate} role={t("compareCandidate")} />
        </div>

        <div className="compare-summary">
          {(
            [
              "regressed",
              "failing",
              "slower",
              "fixed",
              "faster",
              "added",
              "removed",
            ] as CompareVerdict[]
          ).map((v) => (
            <div
              key={v}
              className={`compare-chip compare-chip--${VERDICT_CLASS[v]}${counts[v] ? "" : " compare-chip--zero"}`}
            >
              <b>{counts[v] ?? 0}</b> {t(`verdict_${v}`)}
            </div>
          ))}
        </div>

        <div className="result-section">
          <div className="result-section-header">
            <span className="result-section-title">
              {t("compareByRequest")}
            </span>
            <label className="responses-filter-chip">
              <input
                type="checkbox"
                checked={showUnchanged}
                onChange={(e) => setShowUnchanged(e.target.checked)}
              />
              {t("showUnchanged", { count: counts.unchanged ?? 0 })}
            </label>
          </div>
          {visible.length === 0 ? (
            <div className="drawer-empty responses-empty">
              {t("compareNoChanges")}
            </div>
          ) : (
            <div className="latency-table-wrap">
              <table className="latency-table compare-table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>{t("compareVerdict")}</th>
                    <th className="num">{t("compareMedianA")}</th>
                    <th className="num">{t("compareMedianB")}</th>
                    <th className="num">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <span className="req-method">{r.method}</span> {r.name}
                      </td>
                      <td>
                        <span
                          className={`compare-verdict compare-verdict--${VERDICT_CLASS[r.verdict]}`}
                        >
                          {t(`verdict_${r.verdict}`)}
                        </span>
                      </td>
                      <Cell s={r.a} />
                      <Cell s={r.b} />
                      <Delta a={r.a} b={r.b} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
