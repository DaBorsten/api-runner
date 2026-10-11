import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_RUN_OPTIONS, type RunOptions } from "../types";

interface Props {
  options: RunOptions | undefined;
  onChange: (options: RunOptions) => void;
}

function activeCount(o: RunOptions): number {
  return (
    (o.delayRequest ? 1 : 0) +
    (o.timeoutRequest ? 1 : 0) +
    (o.bail ? 1 : 0) +
    (o.insecure ? 1 : 0) +
    o.envVars.filter((v) => v.key.trim()).length
  );
}

function parseMs(text: string): number | null {
  const n = parseInt(text.replace(/\D/g, ""), 10);
  return Number.isNaN(n) || n <= 0 ? null : n;
}

// Newman flags beyond data/env: --delay-request, --timeout-request, --bail,
// --insecure and --env-var overrides.
export function RunOptionsSection({ options, onChange }: Props) {
  const { t } = useTranslation();
  const opts = { ...DEFAULT_RUN_OPTIONS, ...options };
  const count = activeCount(opts);
  const [open, setOpen] = useState(count > 0);

  function patch(p: Partial<RunOptions>) {
    onChange({ ...opts, ...p });
  }

  function setEnvVar(i: number, p: Partial<{ key: string; value: string }>) {
    patch({
      envVars: opts.envVars.map((v, j) => (j === i ? { ...v, ...p } : v)),
    });
  }

  return (
    <div className="config-summary-section">
      <button
        type="button"
        className="run-options-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="config-summary-label">{t("runOptions")}</span>
        {count > 0 && <span className="run-options-badge">{count}</span>}
      </button>

      {open && (
        <div className="run-options">
          <label className="run-option-field">
            <span className="run-option-label">{t("optDelay")}</span>
            <span className="run-option-input-wrap">
              <input
                className="input input--sm run-option-number"
                inputMode="numeric"
                placeholder="0"
                value={opts.delayRequest ?? ""}
                onChange={(e) =>
                  patch({ delayRequest: parseMs(e.target.value) })
                }
              />
              <span className="run-option-unit">ms</span>
            </span>
          </label>
          <div className="run-option-hint">{t("optDelayHint")}</div>

          <label className="run-option-field">
            <span className="run-option-label">{t("optTimeout")}</span>
            <span className="run-option-input-wrap">
              <input
                className="input input--sm run-option-number"
                inputMode="numeric"
                placeholder="∞"
                value={opts.timeoutRequest ?? ""}
                onChange={(e) =>
                  patch({ timeoutRequest: parseMs(e.target.value) })
                }
              />
              <span className="run-option-unit">ms</span>
            </span>
          </label>

          <label className="run-option-check">
            <input
              type="checkbox"
              checked={opts.bail}
              onChange={(e) => patch({ bail: e.target.checked })}
            />
            <span>
              {t("optBail")}
              <span className="run-option-hint">{t("optBailHint")}</span>
            </span>
          </label>

          <label className="run-option-check">
            <input
              type="checkbox"
              checked={opts.insecure}
              onChange={(e) => patch({ insecure: e.target.checked })}
            />
            <span>
              {t("optInsecure")}
              <span className="run-option-hint">{t("optInsecureHint")}</span>
            </span>
          </label>

          <div className="run-option-label run-option-label--block">
            {t("optEnvVars")}
          </div>
          {opts.envVars.map((v, i) => (
            <div key={i} className="run-option-envvar">
              <input
                className="input run-option-envvar-key"
                placeholder={t("optEnvVarKey")}
                value={v.key}
                onChange={(e) => setEnvVar(i, { key: e.target.value })}
              />
              <input
                className="input"
                placeholder={t("optEnvVarValue")}
                value={v.value}
                onChange={(e) => setEnvVar(i, { value: e.target.value })}
              />
              <button
                type="button"
                className="data-file-card-remove"
                title={t("delete")}
                onClick={() =>
                  patch({ envVars: opts.envVars.filter((_, j) => j !== i) })
                }
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn--sm btn--ghost run-option-add"
            onClick={() =>
              patch({ envVars: [...opts.envVars, { key: "", value: "" }] })
            }
          >
            <Plus size={12} /> {t("optEnvVarAdd")}
          </button>
        </div>
      )}
    </div>
  );
}
