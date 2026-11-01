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
              description="تُكتب هنا أحداث warning وcritical. فعّل السجلات ثم نفّذ إجراءً."
            />
          ) : (
            <>
            <div className="hidden overflow-x-auto sm:block">
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

            {/* Phones get one card per event rather than a six-column table:
                at 390px the last columns sat behind a horizontal scroll, which
                reads as missing data instead of as a wide table. */}
            <ul className="space-y-2 sm:hidden">
              {entries.map(entry => (
                <li key={entry.id} className="rounded-xl border border-border/80 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 break-all font-mono text-xs" dir="ltr">
                      {entry.eventId}
                    </span>
                    <Badge variant={severityVariant[entry.severity] ?? "outline"} className="shrink-0">
                      {entry.severity}
                    </Badge>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <div className="flex min-w-0 items-center gap-1">
                      <dt className="shrink-0">الطبقة:</dt>
                      <dd className="truncate">{entry.sourceLayer}</dd>
                    </div>
                    <div className="flex min-w-0 items-center gap-1">
                      <dt className="shrink-0">الجهة:</dt>
                      <dd className="truncate font-mono" dir="ltr" title={entry.actorHash}>
                        {shortId(entry.actorHash, 6)}
                      </dd>
                    </div>
                    <div className="col-span-2 flex items-center gap-1">
                      <dt className="shrink-0">الوقت:</dt>
                      <dd className="tabular">{formatDateTime(entry.createdAt)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
