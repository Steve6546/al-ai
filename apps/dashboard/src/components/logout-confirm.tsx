import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>تسجيل الخروج؟</DialogTitle>
          <DialogDescription>
            ستنتهي الجلسة الحالية، ولن تُحفظ أي تغييرات غير محفوظة.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            إلغاء
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            تسجيل الخروج
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
