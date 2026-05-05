"use client";

/**
 * Read-only status tile for backup codes.
 *
 * Backup codes are issued and regenerated inside the TOTP enrollment flow
 * (see `two-factor-setup.tsx`); this tile never exposes its own "enroll"
 * affordance. Three states surface what the user should think about next,
 * not what action is available here:
 *
 *   - `passkey-only`  — only a passkey is enrolled. Backup codes don't
 *                       apply because there's no shared secret to recover.
 *   - `totp-required` — neither TOTP nor a passkey is enrolled. Set up
 *                       TOTP first to receive codes.
 *   - `enrolled`      — TOTP is on, so a fresh code set was issued during
 *                       enrollment. The "Regenerate backup codes" button
 *                       on the TOTP tile owns rotation.
 */

import { CheckCircle2, FileKey, ShieldQuestion } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface BackupCodesStatusProps {
  totpEnabled: boolean;
  hasPasskey: boolean;
}

interface StatusCopy {
  title: string;
  body: string;
  Icon: typeof CheckCircle2;
  tone: "muted" | "amber" | "emerald";
}

function pickCopy({ totpEnabled, hasPasskey }: BackupCodesStatusProps): StatusCopy {
  if (totpEnabled) {
    return {
      title: "Backup codes ready",
      body: "Codes were issued when you enrolled the authenticator app. Regenerate from the Authenticator tile if you've lost them.",
      Icon: CheckCircle2,
      tone: "emerald",
    };
  }
  if (hasPasskey) {
    return {
      title: "Not applicable",
      body: "Backup codes pair with an authenticator app. Passkey-only accounts recover by enrolling a second passkey.",
      Icon: FileKey,
      tone: "muted",
    };
  }
  return {
    title: "Required — set up the authenticator app first",
    body: "Backup codes are issued the moment you enable an authenticator. They aren't a standalone factor.",
    Icon: ShieldQuestion,
    tone: "amber",
  };
}

const TONE_CLASSES = {
  muted: "border bg-muted/30 text-muted-foreground",
  amber: "border bg-amber-500/5 text-amber-600 dark:text-amber-400",
  emerald: "border bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
} as const;

export function BackupCodesStatus(props: BackupCodesStatusProps) {
  const { title, body, Icon, tone } = pickCopy(props);

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <span
          className={`grid size-9 shrink-0 place-items-center rounded-lg ${TONE_CLASSES[tone]}`}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle className="text-sm font-semibold">Backup codes</CardTitle>
          <p className="text-xs text-muted-foreground">{title}</p>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}
