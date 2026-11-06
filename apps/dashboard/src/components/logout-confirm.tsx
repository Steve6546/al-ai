import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";

/**
 * The one confirmation before a session ends.
 *
 * Logging out is not a destructive action to the account, but it *is* the end
 * of every unsaved draft on the screen: the forms keep their state in the
 * browser, and the server does not save on behalf of a leaving session. Saying
 * that plainly before the request is what stops a half-edited welcome message
 * from disappearing without a word.
 *
 * Used by both the account menu and the sign-out button on the guild selector,
 * so the two exits cannot drift.
 */
export function LogoutConfirm({
  open,
  onOpenChange,
  onConfirm
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("account.logoutTitle")}</DialogTitle>
          <DialogDescription>{t("account.logoutBody")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t("common.signOut")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
