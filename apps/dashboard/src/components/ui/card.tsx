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
    className={cn("border border-border bg-card shadow-sm", className)}
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
    className={cn("flex flex-col space-y-1.5 px-5 pb-3 pt-4", className)}
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
    className={cn("font-semibold leading-none tracking-tight", className)}
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
  <div ref={ref} className={cn("px-5 pb-5", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("flex items-center px-5 pb-5", className)} {...props} />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
