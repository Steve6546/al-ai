import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "@/components/error-boundary";
import { UpdateBanner } from "@/components/update-banner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyLanguage, readStoredLanguage, I18nProvider } from "./lib/i18n";
import { applyThemePrefs, readThemePrefs } from "./lib/theme";

// The palette and the text direction are applied before React renders, so the
// first paint is already the right one. The same reads happen again in
// `theme-boot.js` to cover the milliseconds before this module is even loaded.
applyThemePrefs(readThemePrefs());
applyLanguage(readStoredLanguage());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      {/* The root boundary catches a shell failure; the App's own boundary
          catches one screen. Without it, a boot-time render error leaves the
          page blank with no sentence and no way back. */}
      <ErrorBoundary fullPage>
        <TooltipProvider delayDuration={200}>
          {/*
            Outside `<App/>` on purpose.

            It used to be mounted by the shell and by the guild selector, so a
            tab sitting on the sign-in screen, the second-factor step or the
            sign-in error page — the three screens `App` returns *before* the
            shell exists — was never told a deploy had happened. One mount at
            the root covers every screen, including the ones that never reach
            the shell.
          */}
          <UpdateBanner />
          <App />
        </TooltipProvider>
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>
);
