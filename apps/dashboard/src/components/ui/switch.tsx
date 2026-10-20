"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The dashboard's switch, wearing HeroUI v3's official switch stylesheet
 * (`@heroui/styles`: .switch / .switch__control / .switch__thumb).
 *
 * The on-state is ALWAYS emerald, applied as an inline style on the control —
 * project-wide product rule: green means "on" on every screen, regardless of
 * which theme variables the surrounding scope carries (inline beats any
 * stylesheet specificity fight, so no per-screen bridging is needed).
 *
 * Two attributes travel together on the root:
 * - `data-state` — the checked/unchecked DOM contract the interaction suite
 *   asserts on;
 * - `data-selected` — HeroUI's own selected marker, kept in sync so its
 *   stylesheet agrees with the inline colour.
 *
 * This wrapper replaced both the Radix switch and HeroUI's component: the
 * latter's press handling does not respond in jsdom and its SSR output drops
 * the accessible label, while this button gives real `role="switch"` +
 * `aria-checked` + keyboard behaviour.
 */
const Switch = React.forwardRef<
  HTMLButtonElement,
  {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
    className?: string;
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "checked">
>(({ checked = false, onCheckedChange, disabled, className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    role="switch"
    aria-checked={checked}
    data-state={checked ? "checked" : "unchecked"}
    data-selected={checked ? "true" : "false"}
    disabled={disabled}
    onClick={event => {
      onCheckedChange?.(!checked);
      props.onClick?.(event);
    }}
    {...props}
    className={cn("switch switch--md", className)}
  >
    <span
      className="switch__control"
      data-slot="switch-control"
      style={checked ? { backgroundColor: "#10b981", borderColor: "#34d399" } : undefined}
    >
      <span className="switch__thumb" data-slot="switch-thumb" />
    </span>
  </button>
))
Switch.displayName = "Switch"

export { Switch }
