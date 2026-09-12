import { useEffect, useState } from "react";
import { FileClock, Loader2, Lock } from "lucide-react";
import { api } from "@/api";
import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, shortId } from "@/lib/format";
import type { AuditEntry, Guild } from "@/types";

/**
 * Read-only view of the internal audit trail.
 *
 * Discord keeps its own audit log for 45 days only, so this trail is the durable
 * record. It is append-only in the database: the screen cannot edit or delete.
 */

const severityVariant: Record<string, "secondary" | "outline" | "destructive"> = {
  info: "outline",
  warning: "secondary",
  critical: "destructive"
};

export function AuditView({ guild }: { guild: Guild }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [counts, setCounts] = useState({ total: 0, critical: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    api
      .audit(guild.id)
      .then(result => {
        if (cancelled) return;
        setEntries(result.entries);
        setCounts(result.counts);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">إجمالي السجلات</p>
            <p className="text-lg font-semibold tabular">{counts.total.toLocaleString("ar")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">حرجة</p>
            <p className="text-lg font-semibold tabular text-destructive">{counts.critical.toLocaleString("ar")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-2 p-4">
            <Lock className="size-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">append-only — للقراءة فقط</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">آخر الأحداث</CardTitle>
        </CardHeader>
        <CardContent>
          {!entries ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              جارٍ التحميل
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={FileClock}
              title="لا توجد سجلات بعد"
              description="يُكتب هنا كل حدث بخطورة warning أو critical. فعّل السجلات من قسم «السجلات» ثم نفّذ إجراءً ليظهر أول سجل."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الحدث</TableHead>
                    <TableHead>الخطورة</TableHead>
                    <TableHead>الطبقة</TableHead>
                    <TableHead>الجهة</TableHead>
                    <TableHead>الوقت</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map(entry => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-mono text-xs" dir="ltr">
                        {entry.eventId}
                      </TableCell>
                      <TableCell>
                        <Badge variant={severityVariant[entry.severity] ?? "outline"}>{entry.severity}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{entry.sourceLayer}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr" title={entry.actorHash}>
                        {shortId(entry.actorHash, 6)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                        {formatDateTime(entry.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
