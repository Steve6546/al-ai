import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Hash, Mic, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A searchable multi-select dropdown for the ignore lists (channels, roles).
 *
 * The option list is a floating popup — it opens on focus/click and closes on
 * blur or pick, flipping upward when there is no room below — so it never
 * stretches the layout the way the always-visible checkbox lists it replaced
 * did. Selection stays a plain string array; chips carry instant removal, and
 * `kind` picks the per-item icon: # for text channels, a mic for voice rooms,
 * and a neutral disc for roles.
 */
export function SearchableMultiSelect({
  id,
  label,
  hint,
  kind,
  options,
  selected,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  /** Drives the per-item icon. Defaults to a plain disc (roles). */
  kind?: "text" | "voice" | "role";
  options: { id: string; name: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(option => option.name.toLowerCase().includes(needle));
  }, [options, query]);

  const selectedNames = selected.map(optionId => ({
    id: optionId,
    name: options.find(option => option.id === optionId)?.name ?? optionId
  }));

  const toggle = (optionId: string, on: boolean) =>
    onChange(on ? [...selected, optionId] : selected.filter(entry => entry !== optionId));

  const openDropdown = () => {
    const rect = fieldRef.current?.getBoundingClientRect();
    setOpenUp(Boolean(rect && rect.bottom + 280 > window.innerHeight && rect.top > 300));
    setOpen(true);
  };

  const closeOnBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    // Related target stays inside while focus moves between the input and a
    // popup item — only a genuinely external focus loss closes the popup.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
      setQuery("");
    }
  };

  const ItemIcon = ({ name }: { name?: string }) => {
    if (kind === "text") return <Hash className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
    if (kind === "voice") return <Mic className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
    return <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-border" title={name} />;
  };

  return (
    <div className="space-y-2" ref={fieldRef} onBlur={closeOnBlur}>
      <Label htmlFor={id}>{label}</Label>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedNames.map(({ id: optionId, name }) => (
            <Badge key={optionId} variant="secondary" className="gap-1 pe-1">
              <ItemIcon name={name} />
              <span className="max-w-32 truncate">{name}</span>
              <button
                type="button"
                aria-label={`إزالة ${name}`}
                className="rounded p-0.5 hover:bg-muted"
                onClick={() => toggle(optionId, false)}
              >
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
          {selected.length > 12 && <Badge variant="outline">+{selected.length - 12}</Badge>}
        </div>
      )}
      <div className="relative">
        <Search
          className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id={id}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          placeholder="ابحث وانقر للاختيار..."
          value={query}
          onFocus={openDropdown}
          onClick={openDropdown}
          onChange={event => {
            setQuery(event.target.value);
            openDropdown();
          }}
          onBlur={closeOnBlur}
          className="pe-16"
        />
        <ChevronDown
          className={`pointer-events-none absolute end-9 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-transform ${open ? "rotate-180" : undefined}`}
          aria-hidden
        />
        {open && (
          <div
            id={`${id}-listbox`}
            role="listbox"
            aria-label={label}
            className={`absolute z-50 w-full overflow-hidden rounded-xl border border-border/80 bg-popover shadow-xl backdrop-blur-md ${
              openUp ? "bottom-full mb-1" : "top-full mt-1"
            }`}
          >
            <div className="max-h-56 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">
                  {options.length === 0 ? "لا توجد خيارات." : "لا نتائج مطابقة للبحث."}
                </p>
              ) : (
                <div className="space-y-0.5">
                  {filtered.map(option => {
                    const on = selected.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="option"
                        aria-selected={on}
                        // preventDefault keeps input focus while picking, so the
                        // popup stays open for multiple selections in one go.
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => toggle(option.id, !on)}
                        className={
                          on
                            ? "flex w-full items-center gap-2 rounded-lg bg-primary/10 px-2 py-1.5 text-start text-sm"
                            : "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm hover:bg-muted"
                        }
                      >
                        <span
                          className={
                            on
                              ? "flex size-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-primary-foreground"
                              : "flex size-4 shrink-0 items-center justify-center rounded border border-border"
                          }
                          aria-hidden
                        >
                          {on && <Check className="size-3" />}
                        </span>
                        <ItemIcon name={option.name} />
                        <span className="truncate">{option.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {hint}
        {selected.length > 0 && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 ps-1 text-xs"
            onClick={() => onChange([])}
          >
            مسح الكل
          </Button>
        )}
      </p>
    </div>
  );
}
