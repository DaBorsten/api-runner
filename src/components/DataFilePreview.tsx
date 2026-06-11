import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Minus, Search, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { DataPreview } from "../types";

interface Props {
  path: string;
  selected: number[] | null;
  onChange: (next: number[] | null) => void;
  onCollapse: () => void;
  onTotalChange: (total: number) => void;
  onColumnsChange?: (cols: number) => void;
}

/**
 * Renders a CSV/JSON data file as a table with a select-all header checkbox and
 * a per-row checkbox, so the user can pick exactly which rows feed the run.
 */
const MIN_SCROLL_HEIGHT = 80;
const MAX_SCROLL_HEIGHT = 600;
const DEFAULT_SCROLL_HEIGHT = 240;

export function DataFilePreview({
  path,
  selected,
  onChange,
  onCollapse,
  onTotalChange,
  onColumnsChange,
}: Props) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const headRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Anchor row for shift-click range selection.
  const lastIndexRef = useRef<number | null>(null);

  // User-resizable height of the scrollable table area. Drag the top handle.
  const [scrollHeight, setScrollHeight] = useState(DEFAULT_SCROLL_HEIGHT);
  const [resizing, setResizing] = useState(false);

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = scrollHeight;
    setResizing(true);

    const onMove = (ev: PointerEvent) => {
      // Handle sits on the top edge, so dragging up (negative delta) grows it.
      const next = startHeight + (startY - ev.clientY);
      setScrollHeight(
        Math.min(MAX_SCROLL_HEIGHT, Math.max(MIN_SCROLL_HEIGHT, next)),
      );
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    lastIndexRef.current = null;
    invoke<DataPreview>("read_data_file", { path })
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const total = preview?.rows.length ?? 0;
  const selectedCount = selected === null ? total : selected.length;
  const allSelected = total > 0 && selectedCount === total;
  const noneSelected = selectedCount === 0;

  useEffect(() => {
    onTotalChange(total);
    onColumnsChange?.(preview?.headers.length ?? 0);
  }, [total, preview?.headers.length]);

  // Drive the header checkbox's indeterminate state imperatively (React has no
  // prop for it).
  useEffect(() => {
    if (headRef.current) {
      headRef.current.indeterminate = !allSelected && !noneSelected;
    }
  }, [allSelected, noneSelected]);

  if (loading) return <div className="data-preview-status">{t("dataPreviewLoading")}</div>;
  if (error)
    return (
      <div className="data-preview-status data-preview-status--error">
        {error}
      </div>
    );
  if (!preview || total === 0) {
    return (
      <div className="data-preview-status">
        {t("dataPreviewEmpty")}
      </div>
    );
  }

  const filteredRows: Array<{ origIndex: number; cells: string[] }> =
    searchQuery.trim()
      ? preview.rows.reduce<Array<{ origIndex: number; cells: string[] }>>(
          (acc, row, i) => {
            const lower = searchQuery.toLowerCase();
            if (
              row.some((cell) =>
                String(cell ?? "")
                  .toLowerCase()
                  .includes(lower),
              )
            ) {
              acc.push({ origIndex: i, cells: row });
            }
            return acc;
          },
          [],
        )
      : preview.rows.map((row, i) => ({ origIndex: i, cells: row }));

  const isRowSelected = (i: number) =>
    selected === null || selected.includes(i);

  function toggleAll() {
    onChange(allSelected ? [] : null);
  }

  function toggleRow(i: number, shiftKey: boolean) {
    const set = new Set(
      selected === null ? preview!.rows.map((_, idx) => idx) : selected,
    );

    if (
      shiftKey &&
      lastIndexRef.current !== null &&
      lastIndexRef.current !== i
    ) {
      const visibleOrigIndices = filteredRows.map((r) => r.origIndex);
      const anchorPos = visibleOrigIndices.indexOf(lastIndexRef.current);
      const currPos = visibleOrigIndices.indexOf(i);
      if (anchorPos !== -1 && currPos !== -1) {
        const target = !set.has(i);
        const [from, to] =
          anchorPos < currPos ? [anchorPos, currPos] : [currPos, anchorPos];
        visibleOrigIndices.slice(from, to + 1).forEach((k) => {
          if (target) set.add(k);
          else set.delete(k);
        });
      } else {
        if (set.has(i)) set.delete(i);
        else set.add(i);
      }
    } else {
      if (set.has(i)) set.delete(i);
      else set.add(i);
    }

    lastIndexRef.current = i;
    const next = [...set].sort((a, b) => a - b);
    onChange(next.length === total ? null : next);
  }

  return (
    <div className="data-preview">
      <div
        className={`data-preview-resizer${resizing ? " data-preview-resizer--active" : ""}`}
        onPointerDown={startResize}
        role="separator"
        aria-orientation="horizontal"
        title={t("dataPreviewResize")}
      />
      <div className="data-preview-head">
        <span className="data-preview-title">{t("dataPreviewTitle")}</span>
        <span className="data-preview-count">
          {t("dataPreviewRowCount", { selected: selectedCount, total })}
        </span>
        <div className="data-preview-search-wrap">
          <Search size={13} className="data-preview-search-icon" />
          <input
            ref={searchRef}
            className="data-preview-search"
            placeholder={t("dataPreviewFilter")}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              lastIndexRef.current = null;
            }}
          />
          {searchQuery && (
            <button
              className="data-preview-search-clear"
              onClick={() => {
                setSearchQuery("");
                lastIndexRef.current = null;
              }}
              title={t("dataPreviewFilterClear")}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <button
          className="data-preview-minimize"
          onClick={onCollapse}
          title={t("dataPreviewMinimize")}
        >
          <Minus size={14} />
        </button>
      </div>
      <div className="data-preview-scroll" style={{ height: scrollHeight }}>
        <table className="data-table">
          <thead>
            <tr onClick={toggleAll} style={{ cursor: "pointer" }}>
              <th className="data-table-check">
                <input
                  ref={headRef}
                  type="checkbox"
                  className="tree-checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  onClick={(e) => e.stopPropagation()}
                  title={t("dataPreviewToggleAll")}
                />
              </th>
              {preview.headers.map((h, j) => (
                <th key={j}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 && (
              <tr>
                <td
                  colSpan={preview.headers.length + 1}
                  style={{
                    textAlign: "center",
                    padding: "12px 0",
                    opacity: 0.5,
                  }}
                >
                  {t("dataPreviewNoMatch", { query: searchQuery })}
                </td>
              </tr>
            )}
            {filteredRows.map(({ origIndex, cells }) => (
              <tr
                key={origIndex}
                className={isRowSelected(origIndex) ? "data-row--selected" : ""}
                onClick={(e) => toggleRow(origIndex, e.shiftKey)}
                style={{ cursor: "pointer" }}
              >
                <td className="data-table-check">
                  <input
                    type="checkbox"
                    className="tree-checkbox"
                    checked={isRowSelected(origIndex)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      toggleRow(
                        origIndex,
                        (e.nativeEvent as MouseEvent).shiftKey,
                      )
                    }
                  />
                </td>
                {preview.headers.map((_, j) => (
                  <td key={j}>{cells[j] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
