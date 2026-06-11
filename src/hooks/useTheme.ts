import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(
    () => (localStorage.getItem("theme") as ThemeMode) ?? "system"
  );

  useEffect(() => {
    const apply = (m: ThemeMode) => {
      const resolved = m === "system" ? getSystemTheme() : m;
      document.documentElement.setAttribute("data-theme", resolved);
      invoke("set_window_theme", { theme: m }).catch(() => {});
    };

    apply(mode);
    localStorage.setItem("theme", mode);

    if (mode === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => apply("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [mode]);

  return { mode, setMode };
}
