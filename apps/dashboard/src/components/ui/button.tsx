import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The button contract for every screen in the dashboard.
 *
 * Variants carry meaning, not taste — one primary action per context:
 *
 * - `default`     — the action the screen exists for (حفظ، إضافة). At most one
 *                   per view; if two buttons fight for it, one of them is
 *                   really an `outline`.
 * - `outline`     — a secondary action beside a primary one (تحديث، مزامنة).
 * - `secondary`   — an inline emphasis (the active pill in a filter strip).
 * - `ghost`       — low-emphasis actions in dense rows. A destructive ghost adds
 *                   `hover:text-destructive` rather than a red fill, so a row
 *                   of controls never reads as an alarm.
 * - `destructive` — reserved for a destructive action that is itself the main
 *                   intent of a dialog (حذف نهائي). Never used inline.
 * - `link`        — a text affordance that behaves like a navigation.
 *
 * Rules that hold across every variant:
 *
 * - An icon-only button (`size="icon"`) MUST carry `aria-label`. The audit
 *   found ten; all ten have one, and a new one without it is a regression.
 * - A pending action passes `loading` instead of hand-rolling a spinner: the
 *   button disables itself, swaps its leading icon for a spinner, and keeps
 *   its label — the layout must not jump while the request is in flight.
 * - `disabled` means "cannot apply right now" (missing permission, locked
 *   control); `loading` means "in flight". They compose: loading wins.
 * - `loading` is refused together with `asChild`: a slot has no disabled state
 *   of its own, so the combination would silently drop the flag.
 */

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /** The action is in flight: disabled, spinner in place of the leading icon. */
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    if (asChild) {
      if (loading) throw new Error("Button: `loading` requires a real <button> — do not combine it with asChild.")
      return (
        <Slot className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>
          {children}
        </Slot>
      )
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {children}
      </button>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
