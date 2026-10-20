import { useEffect, useState } from "react";
import { FileClock, Lock } from "lucide-react";
import { api } from "@/api";
import { EmptyState } from "@/components/empty-state";
import { LoadError, LoadingRow } from "@/components/view-states";
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
    return <LoadError message={error} />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">إجمالي الأحداث</p>
            <p className="text-lg font-semibold tabular">{counts.total.toLocaleString("ar")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">حرجة</p>
            <p className="text-lg font-semibold tabular text-destructive">{counts.critical.toLocaleString("ar")}</p>
          </CardContent>
        </Card>
        {/*
          The third card used to hold a sentence and no number, which made a
          label look like a measurement. It is a property of the trail rather
          than a figure, so it reads as a note beside the two figures - and it
          says the same thing the footer of the table does.
        */}
        <Card>
          <CardContent className="flex items-center gap-2 p-4">
            <Lock className="size-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">سجل يُضاف إليه فقط — لا يُعدَّل ولا يُحذف</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">آخر الأحداث</CardTitle>
        </CardHeader>
        <CardContent>
          {!entries ? (
            <LoadingRow />
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
                    <TableHead className="w-10">
                      <span className="sr-only">التسلسل</span>
                    </TableHead>
                    <TableHead>الحدث</TableHead>
                    <TableHead>الخطورة</TableHead>
                    <TableHead>الطبقة</TableHead>
                    <TableHead>الجهة</TableHead>
                    <TableHead>الوقت</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry, index) => (
                    <TableRow key={entry.id} className="relative">
                      {/* Timeline rail: a colored node per event, joined by a
                          vertical line so the audit reads as a chronology. */}
                      <TableCell className="relative w-10">
                        <span
                          aria-hidden
                          className="absolute top-0 h-full w-px bg-border"
                          style={{ insetInlineStart: "1.15rem", display: index === entries.length - 1 ? "none" : undefined }}
                        />
                        <span
                          className={`relative z-10 grid size-6 place-items-center rounded-full border ${
                            entry.severity === "critical"
                              ? "border-destructive/40 bg-destructive/15 text-destructive"
                              : "border-warning/40 bg-warning/15 text-warning"
                          }`}
                        >
                          <span className="size-1.5 rounded-full bg-current" />
                        </span>
                      </TableCell>
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
