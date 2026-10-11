import { Bookmark, Check, Copy, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RunPreset } from "../types";

interface Props {
  presets: RunPreset[];
  canSave: boolean;
  defaultName: string;
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
  onApply: (preset: RunPreset) => void;
}

function cliCommand(name: string): string {
  return `api-runner run "${name.replace(/"/g, '\\"')}"`;
}

export function PresetMenu({
  presets,
  canSave,
  defaultName,
  onSave,
  onDelete,
  onApply,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const trimmed = name.trim();
  const overwrites = presets.some(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase(),
  );

  function save() {
    if (!trimmed || !canSave) return;
    onSave(trimmed);
    setName("");
  }

  function copyCli(p: RunPreset) {
    void navigator.clipboard.writeText(cliCommand(p.name)).then(() => {
      setCopiedId(p.id);
      setTimeout(() => setCopiedId((id) => (id === p.id ? null : id)), 1500);
    });
  }

  return (
    <div className="preset-menu" ref={rootRef}>
      <button
        type="button"
        className="btn"
        onClick={() => {
          setOpen((v) => !v);
          if (!name) setName(defaultName);
        }}
        aria-expanded={open}
      >
        <Bookmark size={13} /> {t("presets")}
        {presets.length > 0 && (
          <span className="run-options-badge">{presets.length}</span>
        )}
      </button>

      {open && (
        <div className="preset-popover" role="dialog">
          <div className="bc-dropdown-header">
            {t("presetsCount", { count: presets.length })}
          </div>
          <div className="preset-list">
            {presets.map((p) => {
              const source =
                p.selectedLocalCollection?.name ??
                p.selectedCollection?.name ??
                "–";
              return (
                <div key={p.id} className="preset-item">
                  <button
                    type="button"
                    className="preset-item-main"
                    onClick={() => {
                      onApply(p);
                      setOpen(false);
                    }}
                    title={t("presetApply")}
                  >
                    <span className="preset-item-name">{p.name}</span>
                    <span className="preset-item-meta">{source}</span>
                  </button>
                  <button
                    type="button"
                    className="preset-item-icon"
                    onClick={() => copyCli(p)}
                    title={`${t("presetCopyCli")}: ${cliCommand(p.name)}`}
                  >
                    {copiedId === p.id ? (
                      <Check size={13} />
                    ) : (
                      <span className="preset-item-cli">
                        <Terminal size={12} />
                        <Copy size={10} />
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="preset-item-icon preset-item-icon--danger"
                    onClick={() => onDelete(p.id)}
                    title={t("delete")}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {presets.length === 0 && (
              <div className="bc-dropdown-loading">{t("presetsEmpty")}</div>
            )}
          </div>
          <div className="preset-save">
            <input
              className="input"
              placeholder={t("presetNamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              disabled={!canSave}
            />
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={save}
              disabled={!trimmed || !canSave}
            >
              {overwrites ? t("presetOverwrite") : t("save")}
            </button>
          </div>
          {!canSave && (
            <div className="preset-hint">{t("presetNeedsCollection")}</div>
          )}
        </div>
      )}
    </div>
  );
}
