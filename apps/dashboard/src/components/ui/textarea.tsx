import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        /*
         * A textarea the browser lets the operator drag has no ceiling of its
         * own: the grab handle is `resize: both` by default, and a long
         * welcome message turned the field into a column taller than the
         * screen — the card below it pushed out of view and the layout left
         * with a hole in it.
         *
         * Three rules, together:
         * - `resize-y`: vertical only. Horizontal dragging let the field grow
         *   past its card and open a page-level scroll strip.
         * - `max-h-[50vh]`: the ceiling. Half the window is the most a field
         *   inside a card may take before the card stops being a card. A
         *   caller with a taller job can override it (`max-h-…` wins through
         *   `cn`), but the default cannot be "as tall as you can drag".
         * - `overflow-y-auto`: past that ceiling the text scrolls inside the
         *   field instead of the field growing. The scrollbar is the signal
         *   that the content is longer than the box, not that the box is broken.
         */
        "flex max-h-[50vh] min-h-[60px] w-full resize-y overflow-y-auto rounded-md border border-input bg-background px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
