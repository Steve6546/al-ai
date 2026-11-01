import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "@/components/error-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyThemePrefs, readThemePrefs } from "./lib/theme";

// The palette is applied before React renders, so the first paint is already
// the right one. The same read happens again in `theme-boot.js` to cover the
// milliseconds before this module is even loaded.
applyThemePrefs(readThemePrefs());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The root boundary catches a shell failure; the App's own boundary
        catches one screen. Without it, a boot-time render error leaves the
        page blank with no sentence and no way back. */}
    <ErrorBoundary fullPage>
      <TooltipProvider delayDuration={200}>
        <App />
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>
);
