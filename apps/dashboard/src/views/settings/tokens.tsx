import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "@/api";
import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Guild, TokenRecord } from "@/types";

/**
 * حكم 12 — التوكنات تُخزَّن مشفّرة بمفتاح منفصل عن قاعدة البيانات،
 * ولا تُعاد بالعرض بعد الحفظ الأول: الواجهة تعرض البصمة المقنّعة فقط.
 */
export function TokensView({ guilds }: { guilds: Guild[] }) {
  const [tokens, setTokens] = useState<TokenRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.tokens();
      setTokens(result.tokens);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذّر تحميل التوكنات.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(tokenId: string) {
    setBusyId(tokenId);
    try {
      await api.deleteToken(tokenId);
      setTokens(current => (current ?? []).filter(item => item.id !== tokenId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذّر الحذف.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" />
            التوكنات
          </CardTitle>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus />
                توكن جديد
              </Button>
            </DialogTrigger>
            <CreateTokenDialog
              guilds={guilds}
              onDone={async () => {
                setOpen(false);
                await load();
              }}
            />
          </Dialog>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <ShieldCheck />
            <AlertDescription>لا يُعرض التوكن بعد الحفظ — يظهر مقنّعاً فقط.</AlertDescription>
          </Alert>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!tokens && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              جارٍ التحميل
            </div>
          )}

          {tokens && tokens.length === 0 && (
            <EmptyState
              icon={KeyRound}
              title="لا توجد توكنات محفوظة"
              description="أضف توكن بوت لتشغيله إلى جانب AL AI مع صلاحيات محدودة. يُخزَّن مشفّراً ولا يُعرض بعد الحفظ."
              action={
                <Button size="sm" onClick={() => setOpen(true)}>
                  <Plus />
                  توكن جديد
                </Button>
              }
            />
          )}

          {tokens && tokens.length > 0 && (
            <div className="rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الاسم</TableHead>
                    <TableHead>التوكن</TableHead>
                    <TableHead>السيرفرات</TableHead>
                    <TableHead>التاريخ</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tokens.map(token => (
                    <TableRow key={token.id}>
                      <TableCell className="font-medium">{token.label}</TableCell>
                      <TableCell>
                        <code className="font-mono text-xs" dir="ltr">
                          {token.masked}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="tabular">
                          {token.guildIds.length}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(token.createdAt).toLocaleDateString("ar")}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="حذف"
                          disabled={busyId === token.id}
                          onClick={() => void remove(token.id)}
                        >
                          {busyId === token.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        </Button>
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

function CreateTokenDialog({ guilds, onDone }: { guilds: Guild[]; onDone: () => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = label.trim().length > 0 && token.trim().length > 0;

  async function submit() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await api.createToken(label.trim(), token.trim(), selected);
      setLabel("");
      setToken("");
      setSelected([]);
      await onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذّر الحفظ.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>توكن جديد</DialogTitle>
        <DialogDescription>يُشفَّر قبل التخزين ولا يُعاد عرضه.</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="token-label">الاسم</Label>
          <Input id="token-label" value={label} onChange={event => setLabel(event.target.value)} placeholder="بوت الإشراف" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="token-value">التوكن</Label>
          <Input
            id="token-value"
            type="password"
            dir="ltr"
            autoComplete="off"
            value={token}
            onChange={event => setToken(event.target.value)}
          />
        </div>

        <Separator />

        <div className="space-y-2">
          <Label>السيرفرات</Label>
          {guilds.length === 0 ? (
            <p className="text-xs text-muted-foreground">لا توجد سيرفرات متاحة.</p>
          ) : (
            <div className="max-h-48 space-y-2 overflow-y-auto pe-1">
              {guilds.map(guild => (
                <label key={guild.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <Checkbox
                    checked={selected.includes(guild.id)}
                    onCheckedChange={checked =>
                      setSelected(current =>
                        checked ? [...current, guild.id] : current.filter(id => id !== guild.id)
                      )
                    }
                  />
                  <span className="truncate">{guild.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <Button onClick={() => void submit()} disabled={!valid || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Plus />}
          حفظ
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
