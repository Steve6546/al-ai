import { Bot, Check, CirclePlus, RefreshCw, ShieldCheck } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { initials } from "@/lib/format";
import type { Guild } from "@/types";

/**
 * Shown while AL AI is not a member of the selected guild.
 *
 * The settings screens are deliberately unreachable from here: every one of them
 * writes state the bot is the only thing able to apply, so offering them before
 * the bot is present would let the operator save settings that never take effect.
 */
export function InviteBotPanel({ guild, refreshing, onRefresh }: { guild: Guild; refreshing: boolean; onRefresh: () => void }) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <Avatar className="size-10 rounded-lg">
            {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
            <AvatarFallback className="rounded-lg">{initials(guild.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-base">{guild.name}</CardTitle>
            <p className="text-xs text-muted-foreground">البوت غير مضاف إلى هذا السيرفر بعد</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            أضف AL AI إلى هذا السيرفر لفتح الإعدادات. الرابط مثبّت على هذا السيرفر وحده، ولن يطلب منك اختيار
            سيرفر آخر.
          </p>

          <div className="space-y-2">
            <Step label="إضافة البوت بصلاحيات Administrator" />
            <Step label="إنشاء رتبة AL AI وإسنادها للبوت" />
            <Step label="فتح أقسام الإعدادات والسجلات" />
          </div>

          <Separator />

          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={`/api/guilds/${guild.id}/invite`}>
                <CirclePlus />
                إضافة AL AI إلى هذا السيرفر
              </a>
            </Button>
            <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
              تحقّق من الإضافة
            </Button>
          </div>

          <p className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            بعد الإضافة اضغط «تحقّق من الإضافة» ليظهر البوت دون إعادة تسجيل الدخول.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4" />
            ما الذي يعمل الآن؟
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            يمكنك مراجعة سجل التدقيق وكشف الاختراق وإدارة التوكنات بدون إضافة البوت، لأنها أقسام قراءة فقط.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Step({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <span className="grid size-5 shrink-0 place-items-center rounded-full border border-border">
        <Check className="size-3" />
      </span>
      <span>{label}</span>
    </div>
  );
}
