import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyThemePrefs, readThemePrefs } from "./lib/theme";

// The palette is applied before React renders, so the first paint is already
// the right one. The same read happens again in `index.html` (an inline script)
// to cover the milliseconds before this module is even loaded.
applyThemePrefs(readThemePrefs());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={200}>
      <App />
    </TooltipProvider>
  </StrictMode>
);
