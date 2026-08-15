import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { applyStoredTheme } from "./hooks/useTheme";

applyStoredTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
