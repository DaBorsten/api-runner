import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { RefreshCw, CheckCircle, XCircle, X, Download } from "lucide-react";
import type { ThemeMode } from "../hooks/useTheme";

type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "error";

interface SettingsPopupProps {
  theme: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
  onClose: () => void;
}

export function SettingsPopup({
  theme,
  onThemeChange,
  onClose,
}: SettingsPopupProps) {
  const { t, i18n } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const langPillRef = useRef<HTMLSpanElement>(null);
  const langBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const THEME_OPTIONS: { value: ThemeMode; label: string }[] = useMemo(
    () => [
      { value: "light", label: t("theme_light") },
      { value: "dark", label: t("theme_dark") },
      { value: "system", label: t("theme_system") },
    ],
    [t],
  );

  const LANG_OPTIONS = useMemo(
    () => [
      { value: "de", label: t("langGerman") },
      { value: "en", label: t("langEnglish") },
    ],
    [t],
  );

  const [version, setVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(onClose, 180);
  }, [onClose]);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((e) => {
        console.error("Failed to get app version:", e);
      });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // Animate theme segmented-control pill
  useEffect(() => {
    const idx = THEME_OPTIONS.findIndex((o) => o.value === theme);
    const btn = btnRefs.current[idx];
    const pill = pillRef.current;
    if (!btn || !pill) return;
    const containerPad = 3;
    pill.style.width = `${btn.offsetWidth}px`;
    pill.style.transform = `translateX(${btn.offsetLeft - containerPad}px)`;
  }, [theme, i18n.language, THEME_OPTIONS]);

  // Animate language segmented-control pill
  useEffect(() => {
    const idx = LANG_OPTIONS.findIndex((o) => o.value === i18n.language);
    const btn = langBtnRefs.current[idx];
    const pill = langPillRef.current;
    if (!btn || !pill) return;
    const containerPad = 3;
    pill.style.width = `${btn.offsetWidth}px`;
    pill.style.transform = `translateX(${btn.offsetLeft - containerPad}px)`;
  }, [i18n.language, LANG_OPTIONS]);

  async function handleCheckForUpdates() {
    setUpdateStatus("checking");
    setStatusMsg("");
    setPendingUpdate(null);
    try {
      const update = await check();
      if (update) {
        setUpdateStatus("available");
        setStatusMsg(t("updateAvailable", { version: update.version }));
        setPendingUpdate(update);
      } else {
        setUpdateStatus("up-to-date");
        setStatusMsg(t("upToDate"));
      }
    } catch (err) {
      setUpdateStatus("error");
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMsg(`${t("updateFailed")}: ${msg}`);
      console.error("[updater]", err);
    }
  }

  async function handleInstall() {
    if (!pendingUpdate) return;
    setIsInstalling(true);
    setDownloadProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0)
            setDownloadProgress(Math.round((downloaded / total) * 100));
        }
      });
      await relaunch();
    } catch (err) {
      setUpdateStatus("error");
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMsg(`${t("installFailed")}: ${msg}`);
      console.error("[updater install]", err);
      setIsInstalling(false);
      setDownloadProgress(null);
    }
  }

  return (
    <div
      className={`sp-overlay${isClosing ? " sp-overlay--closing" : ""}`}
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) handleClose();
      }}
    >
      <div className="sp-popup">
        {/* Header */}
        <div className="sp-header">
          <span className="sp-title">{t("settings")}</span>
          <button className="sp-close" onClick={handleClose} title={t("close")}>
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="sp-body">
          {/* Theme row */}
          <div className="sp-row">
            <div className="sp-row-left">
              <span className="sp-row-label">{t("appearance")}</span>
              <span className="sp-row-desc">{t("appearanceDesc")}</span>
            </div>
            <div className="sp-seg" role="group">
              <span className="sp-seg-pill" ref={pillRef} />
              {THEME_OPTIONS.map((opt, i) => (
                <button
                  key={opt.value}
                  ref={(el) => {
                    btnRefs.current[i] = el;
                  }}
                  className={`sp-seg-btn${theme === opt.value ? " sp-seg-btn--active" : ""}`}
                  onClick={() => onThemeChange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="sp-divider" />

          {/* Language row */}
          <div className="sp-row">
            <div className="sp-row-left">
              <span className="sp-row-label">{t("language")}</span>
              <span className="sp-row-desc">{t("languageDesc")}</span>
            </div>
            <div className="sp-seg" role="group">
              <span className="sp-seg-pill" ref={langPillRef} />
              {LANG_OPTIONS.map((opt, i) => (
                <button
                  key={opt.value}
                  ref={(el) => {
                    langBtnRefs.current[i] = el;
                  }}
                  className={`sp-seg-btn${i18n.language === opt.value ? " sp-seg-btn--active" : ""}`}
                  onClick={() => void i18n.changeLanguage(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="sp-divider" />

          {/* Version row */}
          <div className="sp-row">
            <div className="sp-row-left">
              <span className="sp-row-label">{t("version")}</span>
              <span className="sp-row-desc">API Runner</span>
            </div>
            <span className="sp-version-badge">{version || "…"}</span>
          </div>
        </div>

        {/* Footer — update button */}
        <div className="sp-footer">
          {!isInstalling && updateStatus !== "available" && (
            <button
              className="sp-update-btn"
              onClick={() => void handleCheckForUpdates()}
              disabled={updateStatus === "checking"}
            >
              <RefreshCw
                size={13}
                className={updateStatus === "checking" ? "sp-spin" : ""}
              />
              {updateStatus === "checking"
                ? t("checking")
                : t("checkForUpdates")}
            </button>
          )}
          {updateStatus === "available" && !isInstalling && (
            <button
              className="sp-update-btn sp-update-btn--available"
              onClick={() => void handleInstall()}
            >
              <Download size={13} />
              {t("installNow")}
            </button>
          )}

          {isInstalling && (
            <div className="sp-progress-wrap">
              <div className="sp-progress-bar">
                <div
                  className="sp-progress-fill"
                  style={{ width: `${downloadProgress ?? 0}%` }}
                />
              </div>
              <span className="sp-progress-label">
                {downloadProgress ?? 0}%
              </span>
            </div>
          )}

          {statusMsg && !isInstalling && (
            <div className={`sp-status sp-status--${updateStatus}`}>
              {updateStatus === "up-to-date" && <CheckCircle size={13} />}
              {updateStatus === "error" && <XCircle size={13} />}
              {updateStatus === "available" && <Download size={13} />}
              <span>{statusMsg}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
