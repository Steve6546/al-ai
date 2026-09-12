import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot, LogIn, ShieldCheck } from "lucide-react";

export function LoginScreen({ notice }: { notice: string | null }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2 grid size-14 place-items-center rounded-2xl bg-primary text-primary-foreground">
            <Bot className="size-7" />
          </div>
          <CardTitle className="text-2xl">AL AI</CardTitle>
          <CardDescription>إدارة سيرفرات Discord</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button asChild className="w-full" size="lg">
            <a href="/auth/discord/login">
              <LogIn />
              تسجيل الدخول عبر Discord
            </a>
          </Button>
          <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            الدخول مقصور على من يملك رتبة إدارية
          </p>
          {notice && <p className="text-center text-xs text-destructive">{notice}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
