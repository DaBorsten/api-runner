import React from "react";
import { Check } from "lucide-react";
import { Step } from "../types";

const STEPS = ["API Key", "Workspace", "Collection", "Configure", "Run"];

interface Props {
  current: Step;
}

export function StepIndicator({ current }: Props) {
  return (
    <div className="step-indicator">
      {STEPS.map((label, i) => {
        const state =
          i < current ? "done" : i === current ? "active" : "pending";
        return (
          <React.Fragment key={i}>
            <div className={`step-dot step-dot--${state}`}>
              {i < current ? <Check size={12} /> : i + 1}
            </div>
            <span className={`step-label step-label--${state}`}>{label}</span>
            {i < STEPS.length - 1 && <div className={`step-line ${i < current ? "step-line--done" : ""}`} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}
