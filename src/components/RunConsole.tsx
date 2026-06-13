import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Square } from "lucide-react";
import { AppAction, AppState } from "../types";

interface Props {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  onCancel: () => void;
  onBack: () => void;
}

export function RunConsole({ state, onCancel, onBack }: Props) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [state.outputLines]);

  const isRunning = state.runStatus === "running";

  return (
    <div className="step-panel step-panel--console">
      <div className="console-header">
        <h2 className="step-title">
          {isRunning ? t("running") : state.runStatus === "error" ? t("error") : t("runComplete")}
        </h2>
        <div className="console-actions">
          {isRunning && (
            <button className="btn btn--danger" onClick={onCancel}>
              <Square size={14} fill="currentColor" strokeWidth={0} />
              Cancel
            </button>
          )}
          {!isRunning && (
            <button className="btn btn--ghost" onClick={onBack} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <ArrowLeft size={14} />
              {t("back")}
            </button>
          )}
        </div>
      </div>

      <div className="console-output">
        {state.outputLines.map((line, i) => (
          <div key={i} className={`console-line ${getLineClass(line)}`}>
            {line}
          </div>
        ))}
        {state.outputLines.length === 0 && (
          <div className="console-line">{t("noOutput")}</div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function getLineClass(line: string): string {
  if (line.includes("failed") || line.includes("AssertionError") || line.includes("[stderr]")) {
    return "console-line--error";
  }
  if (line.includes("✓") || line.includes("passed")) {
    return "console-line--success";
  }
  if (line.startsWith("→") || line.startsWith("  GET") || line.startsWith("  POST") ||
      line.startsWith("  PUT") || line.startsWith("  DELETE") || line.startsWith("  PATCH")) {
    return "console-line--request";
  }
  return "";
}
