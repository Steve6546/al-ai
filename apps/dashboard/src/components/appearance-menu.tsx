/**
 * The appearance menu: the theme mode and the accent colour.
 *
 * It is a popover rather than a page, because it is a preference about *this*
 * screen - the same kind of thing as the font size on a document - and a page
 * for it would be a page that exists only to be closed again. The choices are
 * the three modes and five accents; anything more would be a customisation
 * system nobody asked for.
 *
 * The state is local (`src/lib/theme.ts`), so the choice belongs to the person
 * looking at the screen and travels nowhere else.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ACCENTS, useThemePrefs, type AccentName, type ThemeMode } from "@/lib/theme";

const MODES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "فاتح", icon: Sun },
  { value: "dark", label: "داكن", icon: Moon },
  { value: "system", label: "النظام", icon: Monitor }
];

export function AppearanceMenu({ className, iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  const { prefs, setMode, setAccent } = useThemePrefs();

  return (
    <Popover>
      <PopoverTrigger asChild>
        {iconOnly ? (
          <button
            type="button"
            aria-label="المظهر"
            title="المظهر"
            className={cn(
              "grid size-9 place-items-center rounded-md text-muted-foreground transition-ui hover:bg-accent hover:text-accent-foreground",
              className
            )}
          >
            <Sun className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="المظهر"
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-ui hover:bg-accent hover:text-accent-foreground",
              className
            )}
          >
            <Sun className="size-4 shrink-0" />
            <span>المظهر</span>
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <p className="px-1 pb-2 text-xs font-medium text-muted-foreground">الوضع</p>
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="وضع المظهر">
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
                  "flex flex-col items-center gap-1.5 rounded-md border px-2 py-2.5 text-xs transition-ui",
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Icon className="size-4" />
                {mode.label}
              </button>
            );
          })}
        </div>

        <p className="px-1 pb-2 pt-4 text-xs font-medium text-muted-foreground">لون التمييز</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="لون التمييز">
          {ACCENTS.map(accent => (
            <button
              key={accent.name}
              type="button"
              onClick={() => setAccent(accent.name as AccentName)}
              aria-label={accent.label}
              aria-pressed={prefs.accent === accent.name}
              title={accent.label}
              className={cn(
                "size-7 rounded-full border-2 transition-ui",
                prefs.accent === accent.name ? "border-foreground" : "border-transparent hover:border-muted-foreground/50"
              )}
              style={{ backgroundColor: accent.swatch }}
            />
          ))}
        </div>
        <p className="px-1 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          يُحفظ التفضيل على هذا الجهاز فقط.
        </p>
      </PopoverContent>
    </Popover>
  );
}
