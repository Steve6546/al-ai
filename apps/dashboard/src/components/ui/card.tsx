import * as React from "react"
import { Card as HeroCard } from "@heroui/react"

import { cn } from "@/lib/utils"

/**
 * HeroUI v3 Card behind the dashboard's original compound layout names
 * (CardHeader / CardContent / …). The surface, border, rounding and theming
 * come from HeroUI's `Card`; the header/content blocks stay plain layout
 * primitives so every screen keeps its structure while the design language
 * is HeroUI's.
 *
 * The surface is **solid**, not frosted: a translucent card over a white page
 * reads as a smudge rather than as a card, and the blur cost a repaint on
 * every scroll. One border and one quiet shadow is what separates a card from
 * the page in both palettes.
 */
const Card = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof HeroCard>
>(({ className, ...props }, ref) => (
  <HeroCard
    ref={ref}
    // `p-0` is deliberate: HeroUI's card ships with its own 16px padding, and
    // this app's CardHeader/CardContent already own that space. Keeping both
    // cost 32px of every card's width - enough to squeeze a phone card into a
    // column a few characters wide. The gap HeroUI adds between blocks stays.
    className={cn("border border-border bg-card p-0 shadow-sm", className)}
    {...props}
  />
))
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 px-4 pb-3 pt-4 sm:px-5", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    // `leading-snug` and no negative tracking: Arabic titles have descenders
    // and joined letters, and `leading-none` / `tracking-tight` clip and cram
    // them. This is the one title style every card shares.
    className={cn("font-semibold leading-snug tracking-normal", className)}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm leading-relaxed text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("px-4 pb-4 sm:px-5 sm:pb-5", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("flex items-center px-4 pb-4 sm:px-5 sm:pb-5", className)} {...props} />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
