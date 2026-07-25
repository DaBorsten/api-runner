import { invoke } from "@tauri-apps/api/core";
import { Copy, Minus, Plus, RotateCcw, Search, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type DataPreview } from "../types";

interface Props {
  // null when the user builds a table from scratch instead of loading a file.
  path: string | null;
  selected: number[] | null;
  onChange: (next: number[] | null) => void;
  onCollapse: () => void;
  onTotalChange: (total: number) => void;
  onColumnsChange?: (cols: number) => void;
  // Edited table, or null when the file's own contents are in use. Edits are
  // held here (never written to the original file) and the run uses them.
  table: DataPreview | null;
  onTableChange: (next: DataPreview | null) => void;
}

interface RowProps {
  rowIndex: number;
  cells: string[];
  // Only the count, never the header array — so typing in a column name does
  // not invalidate every row.
  colCount: number;
  isSelected: boolean;
  onCell: (rowIndex: number, col: number, value: string) => void;
  onCommit: () => void;
  onToggle: (rowIndex: number, shiftKey: boolean) => void;
  onDuplicate: (rowIndex: number) => void;
  onDelete: (rowIndex: number) => void;
  duplicateTitle: string;
  deleteTitle: string;
}

/**
 * One table row. Memoized, and every callback it gets is stable, so a keystroke
 * in one cell re-renders that row alone instead of all of them.
 */
const DataRow = memo(function DataRow({
  rowIndex,
  cells,
  colCount,
  isSelected,
  onCell,
  onCommit,
  onToggle,
  onDuplicate,
  onDelete,
  duplicateTitle,
  deleteTitle,
}: RowProps) {
  return (
    <tr
      className={isSelected ? "data-row--selected" : ""}
      onClick={(e) => onToggle(rowIndex, e.shiftKey)}
      style={{ cursor: "pointer" }}
    >
      <td className="data-table-check data-table-check--first">
        <input
          type="checkbox"
          className="tree-checkbox"
          checked={isSelected}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) =>
            onToggle(rowIndex, (e.nativeEvent as MouseEvent).shiftKey)
          }
        />
      </td>
      {Array.from({ length: colCount }, (_, j) => (
        <td key={j}>
          <input
            className="data-cell-input"
            value={cells[j] ?? ""}
            onChange={(e) => onCell(rowIndex, j, e.target.value)}
            onBlur={onCommit}
            onClick={(e) => e.stopPropagation()}
          />
        </td>
      ))}
      {colCount === 0 && <td />}
      <td className="data-table-check data-table-check--last">
        <div className="data-row-actions">
          <button
            className="data-cell-del data-cell-del--neutral"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate(rowIndex);
            }}
            title={duplicateTitle}
          >
            <Copy size={14} />
          </button>
          <button
            className="data-cell-del"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(rowIndex);
            }}
            title={deleteTitle}
          >
            <X size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
});

/**
 * Renders a CSV/JSON data file as a table with a select-all header checkbox and
 * a per-row checkbox, so the user can pick exactly which rows feed the run.
 */
const MIN_SCROLL_HEIGHT = 80;
const MAX_SCROLL_HEIGHT = 600;
const DEFAULT_SCROLL_HEIGHT = 240;

export const DataFilePreview = memo(function DataFilePreview({
  path,
  selected,
  onChange,
  onCollapse,
  onTotalChange,
  onColumnsChange,
  table,
  onTableChange,
}: Props) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<DataPreview | null>(null);
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

  // Text being typed lives here instead of in the app-wide run config: a
  // keystroke would otherwise re-render the whole config drawer. Committed
  // upward on blur, on any structural edit, and on unmount.
  const [draft, setDraft] = useState<DataPreview | null>(null);

  const [prevPath, setPrevPath] = useState(path);
  if (prevPath !== path) {
    setPrevPath(path);
    setLoading(true);
    setError(null);
    setLoaded(null);
    setDraft(null);
  }

  useEffect(() => {
    let cancelled = false;
    lastIndexRef.current = null;
    if (!path) {
      setLoading(false);
      return;
    }
    invoke<DataPreview>("read_data_file", { path })
      .then((p) => {
        if (!cancelled) setLoaded(p);
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

  // Edited table wins; `loaded` stays around untouched so reset is instant.
  const preview = draft ?? table ?? loaded;
  const total = preview?.rows.length ?? 0;
  const selectedCount = selected === null ? total : selected.length;
  const allSelected = total > 0 && selectedCount === total;
  const noneSelected = selectedCount === 0;

  useEffect(() => {
    onTotalChange(total);
    onColumnsChange?.(preview?.headers.length ?? 0);
  }, [total, preview?.headers.length, onTotalChange, onColumnsChange]);

  // Drive the header checkbox's indeterminate state imperatively (React has no
  // prop for it).
  useEffect(() => {
    if (headRef.current) {
      headRef.current.indeterminate = !allSelected && !noneSelected;
    }
  }, [allSelected, noneSelected, total]);

  // This render's data, for the stable callbacks below: they must not close
  // over state, or a memoized row would keep calling an outdated version.
  // Filled in just before the JSX, so it is current whenever an event fires.
  const latest = useRef({
    preview,
    selected,
    total,
    visible: [] as number[],
    onChange,
    onTableChange,
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onTableChangeRef = useRef(onTableChange);
  onTableChangeRef.current = onTableChange;

  // Collapsed or closed with text still in the draft — don't drop it.
  useEffect(
    () => () => {
      if (draftRef.current) onTableChangeRef.current(draftRef.current);
    },
    [],
  );

  const commitDraft = useCallback(() => {
    if (draftRef.current) {
      onTableChangeRef.current(draftRef.current);
      setDraft(null);
    }
  }, []);

  /** Structural edits skip the draft and go straight to the run config. */
  const applyTable = useCallback((next: DataPreview) => {
    latest.current.onTableChange(next);
    setDraft(null);
  }, []);

  const setCell = useCallback(
    (rowIndex: number, col: number, value: string) => {
      const { preview: p } = latest.current;
      if (!p) return;
      setDraft({
        headers: p.headers,
        rows: p.rows.map((row, i) =>
          i === rowIndex
            ? p.headers.map((_, j) => (j === col ? value : (row[j] ?? "")))
            : row,
        ),
      });
    },
    [],
  );

  const deleteRow = useCallback(
    (rowIndex: number) => {
      const { preview: p, selected: sel, onChange: change } = latest.current;
      if (!p) return;
      applyTable({
        headers: p.headers,
        rows: p.rows.filter((_, i) => i !== rowIndex),
      });
      lastIndexRef.current = null;
      // Indices above the removed row shift down by one.
      if (sel !== null) {
        change(
          sel.filter((i) => i !== rowIndex).map((i) => (i > rowIndex ? i - 1 : i)),
        );
      }
    },
    [applyTable],
  );

  const duplicateRow = useCallback(
    (rowIndex: number) => {
      const { preview: p, selected: sel, onChange: change } = latest.current;
      if (!p) return;
      const copy = p.headers.map((_, j) => p.rows[rowIndex][j] ?? "");
      applyTable({
        headers: p.headers,
        rows: p.rows.flatMap((row, i) => (i === rowIndex ? [row, copy] : [row])),
      });
      lastIndexRef.current = null;
      // The copy lands right after its source, so later indices shift up by one.
      // It inherits the source row's selection state.
      if (sel !== null) {
        const next = sel.map((i) => (i > rowIndex ? i + 1 : i));
        if (sel.includes(rowIndex)) next.push(rowIndex + 1);
        change(next.sort((a, b) => a - b));
      }
    },
    [applyTable],
  );

  const toggleRow = useCallback((i: number, shiftKey: boolean) => {
    const {
      preview: p,
      selected: sel,
      total: rowTotal,
      visible,
      onChange: change,
    } = latest.current;
    const set = new Set(sel ?? (p?.rows ?? []).map((_, idx) => idx));

    if (
      shiftKey &&
      lastIndexRef.current !== null &&
      lastIndexRef.current !== i
    ) {
      const anchorPos = visible.indexOf(lastIndexRef.current);
      const currPos = visible.indexOf(i);
      if (anchorPos !== -1 && currPos !== -1) {
        const target = !set.has(i);
        const [from, to] =
          anchorPos < currPos ? [anchorPos, currPos] : [currPos, anchorPos];
        visible.slice(from, to + 1).forEach((k) => {
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
    change(next.length === rowTotal ? null : next);
  }, []);

  if (loading)
    return <div className="data-preview-status">{t("dataPreviewLoading")}</div>;
  if (error)
    return (
      <div className="data-preview-status data-preview-status--error">
        {error}
      </div>
    );
  // An edited table keeps the editor up even when emptied out, otherwise the
  // user deletes the last row/column and loses the add buttons with it.
  if (
    !preview ||
    (!table && !draft && total === 0 && preview.headers.length === 0)
  ) {
    return <div className="data-preview-status">{t("dataPreviewEmpty")}</div>;
  }

  const headers = preview.headers;
  // Empty or repeated column names silently collide (JSON keeps only the last
  // one, CSV writes an unusable column), so flag them in place.
  const badHeaders = new Set(
    headers.filter((h, j) => h.trim() === "" || headers.indexOf(h) !== j),
  );

  // Column names are typed too, so they go through the draft like cells do.
  function renameColumn(col: number, value: string) {
    setDraft({
      headers: headers.map((h, j) => (j === col ? value : h)),
      rows: preview!.rows,
    });
  }

  function addColumn() {
    let name = t("dataPreviewNewColumn");
    let n = 1;
    while (headers.includes(name)) name = `${t("dataPreviewNewColumn")}_${++n}`;
    applyTable({
      headers: [...headers, name],
      rows: preview!.rows.map((row) => [
        ...headers.map((_, j) => row[j] ?? ""),
        "",
      ]),
    });
  }

  function deleteColumn(col: number) {
    applyTable({
      headers: headers.filter((_, j) => j !== col),
      rows: preview!.rows.map((row) =>
        headers.map((_, j) => row[j] ?? "").filter((_, j) => j !== col),
      ),
    });
  }

  function addRow() {
    applyTable({
      headers,
      rows: [...preview!.rows, headers.map(() => "")],
    });
    // An empty row matches no filter, so it would be added invisibly — drop the
    // filter instead of leaving the user staring at an unchanged table.
    setSearchQuery("");
    // Keep an explicit selection inclusive of the new row, so a freshly added
    // row actually runs instead of being silently skipped.
    if (selected !== null) onChange([...selected, total]);
  }

  // While text is being typed, match against the last committed values instead
  // of the draft — otherwise editing a matching cell into a non-matching one
  // unmounts the row (and the focused input) after a single keystroke.
  // Membership is re-evaluated on commit, i.e. once the user leaves the cell.
  const matchRows = (draft ? (table ?? loaded)?.rows : null) ?? preview.rows;
  const filteredRows: Array<{ origIndex: number; cells: string[] }> =
    searchQuery.trim()
      ? preview.rows.reduce<Array<{ origIndex: number; cells: string[] }>>(
          (acc, row, i) => {
            const lower = searchQuery.toLowerCase();
            const against = matchRows[i] ?? row;
            if (against.some((cell) => cell.toLowerCase().includes(lower))) {
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

  latest.current = {
    preview,
    selected,
    total,
    visible: filteredRows.map((r) => r.origIndex),
    onChange,
    onTableChange,
  };

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
          onClick={() => {
            setDraft(null);
            onTableChange(null);
            // Rows added on top of the file are gone after the reset, so their
            // indices would dangle — go back to "all rows".
            onChange(null);
            lastIndexRef.current = null;
          }}
          disabled={(!table && !draft) || !path}
          title={t("dataPreviewReset")}
        >
          <RotateCcw size={13} />
        </button>
        <button
          className="data-preview-minimize"
          onClick={onCollapse}
          title={t("dataPreviewMinimize")}
        >
          <Minus size={14} />
        </button>
      </div>
      <div className="data-preview-table-box">
        {filteredRows.length === 0 && searchQuery !== "" && (
          <div className="data-preview-empty">
            {t("dataPreviewNoMatch", { query: searchQuery })}
          </div>
        )}
        <div className="data-preview-scroll" style={{ height: scrollHeight }}>
          <table className="data-table">
            <thead>
              <tr onClick={toggleAll} style={{ cursor: "pointer" }}>
                <th className="data-table-check data-table-check--first">
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
                {headers.map((h, j) => (
                  <th key={j}>
                    <div className="data-cell-wrap">
                      <input
                        className={`data-cell-input data-cell-input--head${
                          badHeaders.has(h) ? " data-cell-input--invalid" : ""
                        }`}
                        value={h}
                        onChange={(e) => renameColumn(j, e.target.value)}
                        onBlur={commitDraft}
                        onClick={(e) => e.stopPropagation()}
                        title={
                          badHeaders.has(h)
                            ? t("dataPreviewBadColumn")
                            : t("dataPreviewRenameColumn")
                        }
                      />
                      <button
                        className="data-cell-del"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteColumn(j);
                        }}
                        title={t("dataPreviewDeleteColumn")}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </th>
                ))}
                {/* ponytail: filler eats the leftover width when there are no
                    columns, so the checkbox stays left and actions stay right
                    instead of the two 1%-wide cells splitting the table. */}
                {headers.length === 0 && <th />}
                <th className="data-table-check data-table-check--last">
                  <button
                    className="data-cell-add"
                    onClick={(e) => {
                      e.stopPropagation();
                      addColumn();
                    }}
                    title={t("dataPreviewAddColumn")}
                  >
                    <Plus size={15} />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ origIndex, cells }) => (
                <DataRow
                  key={origIndex}
                  rowIndex={origIndex}
                  cells={cells}
                  colCount={headers.length}
                  isSelected={isRowSelected(origIndex)}
                  onCell={setCell}
                  onCommit={commitDraft}
                  onToggle={toggleRow}
                  onDuplicate={duplicateRow}
                  onDelete={deleteRow}
                  duplicateTitle={t("dataPreviewDuplicateRow")}
                  deleteTitle={t("dataPreviewDeleteRow")}
                />
              ))}
            </tbody>
          </table>
        </div>
        {/* Outside the scroll area, so it stays visible without sticky tricks. */}
        <button className="data-add-row" onClick={addRow}>
          <Plus size={12} />
          {t("dataPreviewAddRow")}
        </button>
      </div>
    </div>
  );
});
