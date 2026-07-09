import React from "react";
import { Sun, Moon, Laptop } from "lucide-react";
import type { ThemeMode } from "../hooks/useTheme";

const CYCLE: { value: ThemeMode; icon: React.ReactNode; label: string }[] = [
  { value: "light", icon: <Sun size={14} />, label: "Light" },
  { value: "dark", icon: <Moon size={14} />, label: "Dark" },
  { value: "system", icon: <Laptop size={14} />, label: "System" },
];

interface Props {
  mode: ThemeMode;
  onChange: (m: ThemeMode) => void;
}

export function ThemeToggle({ mode, onChange }: Props) {
  const idx = CYCLE.findIndex((o) => o.value === mode);
  const current = CYCLE[idx];
  const next = CYCLE[(idx + 1) % CYCLE.length];

  function cycle() {
    onChange(next.value);
  }

  return (
    <button
      className="theme-cycle-btn"
      onClick={cycle}
      title={`Switch to ${next.label}`}
    >
      <span className="theme-cycle-btn__icon">{current.icon}</span>
      <span className="theme-cycle-btn__label">{current.label}</span>
    </button>
  );
}
