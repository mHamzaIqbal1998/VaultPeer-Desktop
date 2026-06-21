import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initThemeSystemListener } from "@/stores/themeStore";
import "./styles/globals.css";

// Apply the persisted/system theme to the DOM before first paint and react
// to OS color-scheme changes while "system" is selected.
initThemeSystemListener();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
