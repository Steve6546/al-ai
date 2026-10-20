"use client"

import * as React from "react"
import { Modal as HeroModal } from "@heroui/react"

import { cn } from "@/lib/utils"

/**
 * HeroUI v3 Modal behind the dashboard's original dialog names. `Dialog`
 * owns the open state and shares it through context; `DialogContent` renders
 * HeroUI's Backdrop → Container → Dialog stack, so focus trapping, dismissal
 * and animations are HeroUI's while every call site stays untouched.
 */
const DialogContext = React.createContext<{
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}>({ open: false });

const Dialog = ({
  open,
  onOpenChange,
  children
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) => (
  <DialogContext.Provider value={{ open: open ?? false, onOpenChange }}>
    {children}
  </DialogContext.Provider>
)
Dialog.displayName = "Dialog"

/** Legacy shadcn trigger/close exports. No screen uses them with HeroUI's
    trigger pattern, so they render their children unchanged. */
const DialogTrigger = ({ children }: { children?: React.ReactNode }) => <>{children}</>
DialogTrigger.displayName = "DialogTrigger"

const DialogClose = ({ children }: { children?: React.ReactNode }) => <>{children}</>
DialogClose.displayName = "DialogClose"

const DialogPortal = ({ children }: { children?: React.ReactNode }) => <>{children}</>
DialogPortal.displayName = "DialogPortal"

const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]", className)} {...props} />
))
DialogOverlay.displayName = "DialogOverlay"

const DialogContent = ({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  const { open, onOpenChange } = React.useContext(DialogContext);
  return (
    <HeroModal.Backdrop isOpen={open} onOpenChange={onOpenChange}>
      <HeroModal.Container>
        <HeroModal.Dialog className={cn("w-full max-w-lg gap-4 border border-border/80 bg-card/95 p-6 shadow-xl backdrop-blur-md", className)}>
          {/* Project rule: no corner X. Modals close through their footer
              buttons (إلغاء / حفظ), Escape, or an outside click — all of
              which HeroUI's dismissal already handles. */}
          {children}
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  )
}
DialogContent.displayName = "DialogContent"

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h2
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = "DialogTitle"

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = "DialogDescription"

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
