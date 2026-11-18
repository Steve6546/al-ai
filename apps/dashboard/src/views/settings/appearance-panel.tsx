/**
 * The appearance panel: the whole theme system, in one screen.
 *
 * Three bands, in the order a theme is actually designed:
 *
 * 1. **The palette** — up to five stops with a live gradient, the picker for the
 *    stop that is selected, and the two sliders that decide the gradient's
 *    direction and how far its colour reaches into the surfaces.
 * 2. **The shelf** — ready-made themes as tiles that show the gradient *and* the
 *    panel colour they produce, so a tile is a promise the page can keep. Plus
 *    «فاجئني» and «إعادة ضبط».
 * 3. **The details** — mode, how far the tint reaches (page only or panels too),
 *    and an optional accent override.
 *
 * The panel is deliberately not a modal: every change is painted on the real
 * interface behind it, so what is being judged is the product, not a swatch.
 */
import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { ArrowDownRight, Check, Loader2, Monitor, Moon, Palette, RotateCcw, Sparkles, Sun, TriangleAlert, Wand2 } from "lucide-react";
import {
  APPEARANCE_PRESETS,
  MAX_THEME_COLORS,
  QUICK_SWATCHES,
  buildThemeTokens,
  contrastRatio,
  normaliseHex,
  readableOn,
  surpriseAppearance,
  type Appearance
} from "@al-ai/core/browser";
import { ColorField } from "@/components/appearance/color-field";
import { ColorStops, GradientBar } from "@/components/appearance/color-stops";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { useThemePrefs, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

const MODES: { value: ThemeMode; key: TranslationKey; icon: typeof Sun }[] = [
  { value: "light", key: "appearance.light", icon: Sun },
  { value: "dark", key: "appearance.dark", icon: Moon },
  { value: "system", key: "appearance.system", icon: Monitor }
];

/** A slider row: label, value, and the control. Range styling lives in the stylesheet. */
function Slider({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  unit,
  track,
  onChange
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  /** A CSS background for the rail, so the control shows what it controls. */
  track?: string;
  onChange: (value: number, options: { live: boolean }) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="font-mono text-xs tabular text-muted-foreground" dir="ltr">
          {Math.round(value)}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value), { live: true })}
        onPointerUp={event => onChange(Number((event.target as HTMLInputElement).value), { live: false })}
        onKeyUp={event => onChange(Number((event.target as HTMLInputElement).value), { live: false })}
        aria-label={label}
        className="appearance-range w-full"
        style={track ? ({ "--appearance-track": track } as CSSProperties) : undefined}
      />
      <p className="text-micro leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}

export type AppearanceSaveState = "idle" | "saving" | "saved" | "error";

export function AppearancePanel({ saveState = "idle" }: { saveState?: AppearanceSaveState }) {
  const { t } = useI18n();
  const { prefs, setMode, setColors, updateColors, setAngle, setIntensity, setScope, setAccent, applyPreset, resetTheme, isDefault } =
    useThemePrefs();
  const [selected, setSelected] = useState(0);
  const [showAccentPicker, setShowAccentPicker] = useState(false);

  const colors = prefs.colors.length > 0 ? prefs.colors : ["#4f6bed"];
  const activeIndex = Math.min(selected, colors.length - 1);
  const activeColor = colors[activeIndex] ?? colors[0]!;

  const tokens = useMemo(() => buildThemeTokens(prefs), [prefs]);

  // The stop edit, add and delete all rewrite one entry of the current list, so
  // they go through `updateColors`: building the new list from the render-time
  // `colors` would drop a change made in the same task (a preset press followed
  // immediately by an edit), which is the same stale-composition bug as above.
  const setActiveColor = useCallback(
    (hex: string, options: { live?: boolean } = {}) => {
      updateColors(current => {
        const next = [...current];
        next[Math.min(activeIndex, next.length - 1)] = hex;
        return next;
      }, options);
    },
    [activeIndex, updateColors]
  );

  const addColor = useCallback(() => {
    // A new stop is derived from the last one, so pressing «+» twice does not
    // produce two identical stops that look like the button failed.
    const next = updateColors(current => {
      if (current.length >= MAX_THEME_COLORS) return current;
      const last = current[current.length - 1] ?? "#4f6bed";
      return [...current, shiftLightness(last, current.length)];
    });
    setSelected(next.colors.length - 1);
  }, [updateColors]);

  const removeColor = useCallback(
    (index: number) => {
      const next = updateColors(current =>
        current.length <= 1 ? current : current.filter((_, position) => position !== index)
      );
      setSelected(current => Math.max(0, Math.min(current, next.colors.length - 1)));
    },
    [updateColors]
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
          <Palette className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle className="text-base">{t("settings.section.appearance")}</CardTitle>
          <CardDescription>{t("settings.section.appearanceBody")}</CardDescription>
        </div>
        {/*
          The save state belongs on this card, not in a toast that disappears:
          the palette is applied locally first, so "not saved" is the one thing
          the screen cannot show by accident — the theme looks right either way.
        */}
        <p
          aria-live="polite"
          className={cn(
            "ms-auto flex shrink-0 items-center gap-1.5 text-micro",
            saveState === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {saveState === "saving" ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          {saveState === "saved" ? <Check className="size-3 text-success" aria-hidden /> : null}
          {saveState === "error" ? <TriangleAlert className="size-3" aria-hidden /> : null}
          {saveState === "saving"
            ? t("appearance.saving")
            : saveState === "saved"
              ? t("appearance.saved")
              : saveState === "error"
                ? t("appearance.saveFailed")
                : null}
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ---------------------------------------------------------------- *
         * The palette
         * ---------------------------------------------------------------- */}
        <section className="space-y-3" aria-labelledby="appearance-palette">
          <h3 id="appearance-palette" className="text-xs font-semibold tracking-wide text-muted-foreground">
            {t("appearance.palette")}
          </h3>
          <ColorStops
            colors={colors}
            angle={prefs.angle}
            selected={activeIndex}
            onSelect={setSelected}
            onChange={(next, options) => setColors(next, options)}
            onAdd={addColor}
            onRemove={removeColor}
            labels={{
              add: t("appearance.addColor"),
              remove: t("appearance.removeColor"),
              moveStart: t("appearance.moveStart"),
              moveEnd: t("appearance.moveEnd"),
              current: t("appearance.selected")
            }}
          />

          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <ColorField
              label={t("appearance.colorN", { n: activeIndex + 1 })}
              value={activeColor}
              onChange={hex => setActiveColor(hex, { live: true })}
              onCommit={hex => setActiveColor(hex)}
              swatches={QUICK_SWATCHES}
            />
            <div className="space-y-4">
              <Slider
                label={t("appearance.angle")}
                hint={t("appearance.angleHint")}
                value={prefs.angle}
                min={0}
                max={360}
                unit="°"
                // The rail of the angle slider *is* the gradient it turns: a
                // generic grey track would make the operator scrub a number and
                // look somewhere else to see the result.
                track={
                  colors.length > 1 ? `linear-gradient(${prefs.angle}deg, ${colors.join(", ")})` : undefined
                }
                onChange={(value, options) => setAngle(value, options)}
              />
              <Slider
                label={t("appearance.intensity")}
                hint={t("appearance.intensityHint")}
                value={prefs.intensity}
                min={0}
                max={100}
                unit="%"
                onChange={(value, options) => setIntensity(value, options)}
              />
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t("appearance.scope")}</span>
                <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("appearance.scope")}>
                  {(["tinted", "canvas"] as const).map(scope => {
                    const active = prefs.scope === scope;
                    return (
                      <button
                        key={scope}
                        type="button"
                        onClick={() => setScope(scope)}
                        aria-pressed={active}
                        className={cn(
                          "rounded-xl border px-3 py-2 text-start text-xs transition-ui",
                          active ? "border-primary bg-primary/10 font-medium" : "border-border hover:bg-muted/60"
                        )}
                      >
                        {t(scope === "tinted" ? "appearance.scopeTinted" : "appearance.scopeCanvas")}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- *
         * The shelf
         * ---------------------------------------------------------------- */}
        <section className="space-y-3" aria-labelledby="appearance-presets">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="appearance-presets" className="text-xs font-semibold tracking-wide text-muted-foreground">
              {t("appearance.presets")}
            </h3>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                className="gap-1.5"
                onClick={() => {
                  const next = surpriseAppearance(prefs);
                  applyPreset(next);
                  setSelected(0);
                }}
              >
                <Wand2 className="size-4" aria-hidden />
                {t("appearance.surprise")}
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={resetTheme} disabled={isDefault}>
                <RotateCcw className="size-4" aria-hidden />
                {t("appearance.reset")}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" role="list">
            {APPEARANCE_PRESETS.map(entry => (
              <PresetTile
                key={entry.id}
                entry={entry}
                active={sameTheme(prefs, entry.appearance)}
                onPick={() => {
                  applyPreset(entry.appearance);
                  setSelected(0);
                }}
              />
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------------- *
         * The details
         * ---------------------------------------------------------------- */}
        <section className="space-y-3" aria-labelledby="appearance-details">
          <h3 id="appearance-details" className="text-xs font-semibold tracking-wide text-muted-foreground">
            {t("appearance.details")}
          </h3>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t("appearance.mode")}</p>
            <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label={t("appearance.modeLabel")}>
              {MODES.map(mode => {
                const Icon = mode.icon;
                const active = prefs.mode === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setMode(mode.value)}
                    aria-pressed={active}
                    className={cn(
                      "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm transition-ui",
                      active
                        ? "border-primary bg-primary/10 font-medium"
                        : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    <Icon className={cn("size-4", active && "text-primary")} aria-hidden />
                    <span className="min-w-0 flex-1 text-start">{t(mode.key)}</span>
                    {active ? <Check className="size-4 text-primary" aria-hidden /> : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">{t("appearance.accent")}</p>
              <button
                type="button"
                onClick={() => setShowAccentPicker(current => !current)}
                className="text-micro text-primary underline-offset-2 hover:underline"
              >
                {t("appearance.customAccent")}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* «Derived» is the default and the recommended state: the accent is
                  then the most saturated stop, so a palette is complete once the
                  colours are chosen. */}
              <button
                type="button"
                onClick={() => {
                  setAccent(null);
                  setShowAccentPicker(false);
                }}
                aria-pressed={prefs.accent === null}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs transition-ui",
                  prefs.accent === null ? "border-primary bg-primary/10 font-medium" : "border-border hover:bg-muted/60"
                )}
              >
                <Sparkles className="size-3.5" aria-hidden />
                {t("appearance.accentAuto")}
              </button>
              {QUICK_SWATCHES.map(swatch => {
                const active = normaliseHex(prefs.accent) === swatch;
                return (
                  <button
                    key={swatch}
                    type="button"
                    onClick={() => setAccent(swatch)}
                    aria-pressed={active}
                    aria-label={swatch}
                    title={swatch}
                    className={cn(
                      "size-8 rounded-full border-2 transition-ui",
                      active ? "border-foreground" : "border-transparent hover:border-muted-foreground/50"
                    )}
                    style={{ backgroundColor: swatch }}
                  >
                    {active ? (
                      <Check className="mx-auto size-3.5" style={{ color: readableOn(swatch) }} aria-hidden />
                    ) : null}
                  </button>
                );
              })}
            </div>
            {showAccentPicker ? (
              <div className="rounded-xl border border-border bg-muted/25 p-3">
                <ColorField
                  label={t("appearance.customAccent")}
                  value={prefs.accent ?? tokens["--primary"] ?? "#4f6bed"}
                  onChange={hex => setAccent(hex)}
                  onCommit={hex => setAccent(hex)}
                  showContrast
                />
              </div>
            ) : null}
          </div>
        </section>

        {/* A one-line statement of what the engine produced, so the numbers are
            visible rather than implied: the panel colours and the text ratio. */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/25 px-3 py-2.5 text-micro text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-4 rounded border border-black/20" style={{ backgroundColor: tokens["--background"] }} aria-hidden />
            <span className="size-4 rounded border border-black/20" style={{ backgroundColor: tokens["--card"] }} aria-hidden />
            <span className="size-4 rounded border border-black/20" style={{ backgroundColor: tokens["--sidebar"] }} aria-hidden />
            <span className="size-4 rounded border border-black/20" style={{ backgroundColor: tokens["--primary"] }} aria-hidden />
          </span>
          <span dir="ltr" className="font-mono">
            {contrastRatio(tokens["--foreground"] ?? "#000", tokens["--background"] ?? "#fff").toFixed(1)}:1
          </span>
          <span>{t("appearance.contrastNote")}</span>
          <span className="ms-auto inline-flex items-center gap-1">
            <ArrowDownRight className="size-3" aria-hidden />
            {t("appearance.stops", { n: colors.length })}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/** A preset tile: the gradient it paints, and the panel colour it produces. */
function PresetTile({ entry, active, onPick }: { entry: (typeof APPEARANCE_PRESETS)[number]; active: boolean; onPick: () => void }) {
  const { t } = useI18n();
  // The tile runs the engine, so the swatch inside it is the card colour the page
  // will actually paint — not a guessed tint of the gradient.
  const tokens = useMemo(() => buildThemeTokens({ ...entry.appearance, mode: "dark" }), [entry.appearance]);
  const lightTokens = useMemo(() => buildThemeTokens({ ...entry.appearance, mode: "light" }), [entry.appearance]);
  return (
    <button
      type="button"
      role="listitem"
      onClick={onPick}
      aria-pressed={active}
      className={cn(
        "group overflow-hidden rounded-xl border text-start transition-ui",
        active ? "border-primary ring-1 ring-primary/40" : "border-border hover:border-muted-foreground/50"
      )}
    >
      <span className="block p-1.5">
        <GradientBar colors={entry.appearance.colors} angle={entry.appearance.angle} className="h-8 rounded-lg border-0" />
      </span>
      <span className="flex items-center justify-between gap-2 px-2.5 pb-2">
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium">
            {t(`appearance.preset.${entry.id}` as TranslationKey)}
          </span>
          {/* Two 16px mock panels — the dark one and the light one — each a page
              with a card inside it. They used to be two 12px squares, which read
              as a stray bullet next to the label rather than as a preview of the
              surfaces the theme produces. */}
          <span className="mt-1 flex items-center gap-1">
            {[
              { page: tokens["--background"], card: tokens["--card"] },
              { page: lightTokens["--background"], card: lightTokens["--card"] }
            ].map((pair, index) => (
              <span
                key={index}
                className="grid size-4 place-items-center rounded-[3px] border border-black/15"
                style={{ backgroundColor: pair.page }}
                aria-hidden
              >
                <span className="size-2.5 rounded-[2px] border border-black/10" style={{ backgroundColor: pair.card }} />
              </span>
            ))}
          </span>
        </span>
        {active ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
      </span>
    </button>
  );
}

/** Whether the current choice is this preset (colours, angle, intensity, mode). */
function sameTheme(current: Appearance, preset: Appearance): boolean {
  return (
    current.mode === preset.mode &&
    current.angle === preset.angle &&
    current.intensity === preset.intensity &&
    current.scope === preset.scope &&
    (current.accent ?? "") === (preset.accent ?? "") &&
    current.colors.length === preset.colors.length &&
    current.colors.every((color, index) => color === preset.colors[index])
  );
}

/** A new stop that is visibly a different colour from its neighbour. */
function shiftLightness(hex: string, index: number): string {
  const value = normaliseHex(hex) ?? "#4f6bed";
  const channel = (offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
  const step = index % 2 === 0 ? 40 : -50;
  const shift = (part: number) => Math.min(255, Math.max(0, part + step + Math.round(index * 6))).toString(16).padStart(2, "0");
  return `#${shift(channel(1))}${shift(channel(3))}${shift(channel(5))}`;
}
