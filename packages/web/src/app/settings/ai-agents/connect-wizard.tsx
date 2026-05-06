"use client";

/**
 * Connect-new-agent wizard (#2065).
 *
 * 3-step modal that walks a workspace user through registering an MCP
 * client. The actual OAuth dance happens inside the agent process — the
 * agent fetches the protected-resource metadata, runs DCR, and bounces
 * the user through `/oauth2/authorize` → `/oauth2/consent`. The wizard
 * doesn't *replace* that flow; it gives users the config block they need
 * so the agent knows where to point.
 *
 * Steps:
 *   1. Pick client — five preset cards with per-client guidance.
 *   2. What's next — brief explainer + scopes the agent will request.
 *   3. Deliver config — pre-filled JSON, copy-to-clipboard, link to
 *      paste-instructions in the docs.
 *
 * Deploy gating: the `/settings/ai-agents` page only renders this wizard
 * when `deployMode === "saas"`. Self-hosted operators continue using the
 * CLI installer or the admin surface. No second SaaS check inside the
 * wizard — the gate already happened.
 */

import { useEffect, useMemo, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { getApiUrl } from "@/lib/api-url";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  ExternalLink,
  Sparkles,
} from "lucide-react";

import { brandedMcpBase } from "./branded-mcp-base";

type WizardStep = 1 | 2 | 3;

interface ClientPreset {
  id: "claude-desktop" | "cursor" | "continue" | "chatgpt" | "other";
  label: string;
  description: string;
  /**
   * Documentation link for "where do I paste this?". External URLs are
   * stable doc anchors so the wizard doesn't break when an agent vendor
   * reorganizes their site — anchors are owned by Atlas's docs team.
   */
  pasteHelpHref: string;
}

const CLIENT_PRESETS: readonly ClientPreset[] = [
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    description: "Anthropic's desktop app — paste the block into your Claude Desktop config.",
    pasteHelpHref: "https://docs.useatlas.dev/guides/mcp-hosted#claude-desktop",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "Cursor IDE's MCP integration — drops into your Cursor settings.",
    pasteHelpHref: "https://docs.useatlas.dev/guides/mcp-hosted#cursor",
  },
  {
    id: "continue",
    label: "Continue",
    description: "Continue.dev IDE extension — paste into the Continue config.",
    pasteHelpHref: "https://docs.useatlas.dev/guides/mcp-hosted#continue",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    description: "OpenAI's ChatGPT app — set the connector URL in ChatGPT's MCP settings.",
    pasteHelpHref: "https://docs.useatlas.dev/guides/mcp-hosted#chatgpt",
  },
  {
    id: "other",
    label: "Other / Generic MCP",
    description: "Any spec-compliant MCP client — point it at the URL below.",
    pasteHelpHref: "https://docs.useatlas.dev/guides/mcp-hosted",
  },
];

// Mirror the four most user-relevant scopes the consent screen will
// surface (see `ATLAS_OAUTH_SCOPES` in lib/auth/server.ts). `profile`
// is included because spec-compliant agents commonly request it; the
// consent screen remains the authoritative list.
const SCOPE_DESCRIPTIONS: Array<{ scope: string; meaning: string }> = [
  { scope: "openid", meaning: "Your Atlas user identity" },
  { scope: "profile", meaning: "Your name and avatar" },
  { scope: "email", meaning: "Your email address" },
  { scope: "offline_access", meaning: "A refresh token so the agent doesn't have to send you back through the browser" },
  { scope: "mcp:read", meaning: "Query workspace data through the MCP endpoint" },
];

interface ConnectWizardProps {
  open: boolean;
  onClose: () => void;
}

export function ConnectWizard({ open, onClose }: ConnectWizardProps) {
  const [step, setStep] = useState<WizardStep>(1);
  const [chosen, setChosen] = useState<ClientPreset["id"] | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const session = authClient.useSession();
  // Better Auth's public session type doesn't expose `activeOrganizationId`
  // — the organization plugin contributes it at runtime. Same cast as the
  // org-switcher.
  const orgId = (session.data?.session as Record<string, unknown> | undefined)
    ?.activeOrganizationId as string | undefined;

  // Reset step + selection when the wizard reopens so a previous session
  // doesn't leave the user on step 3 the next time they click Connect.
  useEffect(() => {
    if (open) {
      setStep(1);
      setChosen(null);
      setCopied(false);
      setCopyFailed(false);
    }
  }, [open]);

  const apiBase = useMemo(() => {
    // `getApiUrl()` returns "" in same-origin Next.js rewrite mode (no
    // `NEXT_PUBLIC_ATLAS_API_URL` set). Pasting `/mcp/<id>/sse` (a relative
    // path) into Claude Desktop / Cursor / ChatGPT silently fails — the
    // agents require an absolute URL. `window.location.origin` is the
    // browser-side absolute base for same-origin deployments. SSR has no
    // window, so fall back to "" there; the wizard re-renders client-side
    // before the user clicks Copy.
    const configured = getApiUrl();
    if (configured) return configured;
    if (typeof window !== "undefined") return window.location.origin;
    return "";
  }, []);

  const mcpUrl = useMemo(() => {
    // #2068 — when the configured API base is one of the canonical SaaS
    // regional `api*.useatlas.dev` hosts, surface the brand-mirror
    // `mcp*.useatlas.dev` host to the user instead of the underlying
    // infra. The hosted MCP route accepts both audiences (issuer-side
    // backward compat) but the wizard's snippet should always write the
    // brand URL — that's what every doc, registry entry, and CLI default
    // already advertises. Self-hosted bases pass through unchanged.
    const mcpBase = brandedMcpBase(apiBase) ?? apiBase;
    // Workspace id is part of the URL — without it the agent can't bind to
    // a workspace. Fall back to a placeholder so the JSON parses; the user
    // sees the placeholder and knows something's missing.
    if (!orgId) return `${mcpBase}/mcp/<your_workspace_id>/sse`;
    return `${mcpBase}/mcp/${orgId}/sse`;
  }, [apiBase, orgId]);

  const configJson = useMemo(() => {
    return JSON.stringify(
      {
        mcpServers: {
          atlas: {
            url: mcpUrl,
          },
        },
      },
      null,
      2,
    );
  }, [mcpUrl]);

  const chosenPreset = chosen
    ? CLIENT_PRESETS.find((c) => c.id === chosen)
    : null;

  function handleNext() {
    if (step === 1 && !chosen) return;
    if (step < 3) setStep((s) => (s + 1) as WizardStep);
  }

  function handleBack() {
    if (step > 1) setStep((s) => (s - 1) as WizardStep);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(configJson);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Clipboard API can fail on insecure contexts or denied permissions.
      // Log for debugging and flip a state flag so the UI tells the user
      // to select-and-copy manually — the `<pre>` block below is text-
      // selectable, so the manual path always works.
      console.error("Clipboard copy failed:", err instanceof Error ? err.message : err);
      setCopyFailed(true);
    }
  }

  const canProceed = step === 1 ? chosen !== null : true;
  const primaryLabel = step === 3 ? "Done" : "Next";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Connect new agent
          </DialogTitle>
          <DialogDescription>
            <StepIndicator step={step} />
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <Step1Picker chosen={chosen} onChoose={setChosen} />
        )}
        {step === 2 && chosenPreset && (
          <Step2Consent preset={chosenPreset} mcpUrl={mcpUrl} />
        )}
        {step === 3 && chosenPreset && (
          <Step3Deliver
            preset={chosenPreset}
            configJson={configJson}
            onCopy={handleCopy}
            copied={copied}
            copyFailed={copyFailed}
          />
        )}

        <DialogFooter className="flex flex-row justify-between sm:justify-between">
          <Button
            variant="ghost"
            onClick={handleBack}
            disabled={step === 1}
            aria-label="Previous step"
          >
            <ChevronLeft className="mr-1 size-3.5" />
            Back
          </Button>
          <Button
            variant="default"
            onClick={step === 3 ? onClose : handleNext}
            disabled={!canProceed}
          >
            {primaryLabel}
            {step !== 3 && <ChevronRight className="ml-1 size-3.5" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepIndicator({ step }: { step: WizardStep }) {
  const labels = ["Pick your agent", "Review", "Get config"];
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {labels.map((label, idx) => {
        const n = (idx + 1) as WizardStep;
        const active = n === step;
        const done = n < step;
        return (
          <span key={label} className="flex items-center gap-1">
            <span
              className={cn(
                "inline-flex size-4 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
                done && "bg-primary text-primary-foreground",
                active && "bg-primary/15 text-primary outline outline-1 outline-primary/40",
                !done && !active && "bg-muted text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              {done ? <Check className="size-2.5" /> : n}
            </span>
            <span className={cn(active ? "text-foreground" : "text-muted-foreground")}>
              {label}
            </span>
            {idx < labels.length - 1 && (
              <span aria-hidden className="mx-1 text-muted-foreground/40">·</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

function Step1Picker({
  chosen,
  onChoose,
}: {
  chosen: ClientPreset["id"] | null;
  onChoose: (id: ClientPreset["id"]) => void;
}) {
  return (
    <div className="space-y-2 py-2">
      {CLIENT_PRESETS.map((preset) => {
        const active = preset.id === chosen;
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => onChoose(preset.id)}
            className={cn(
              "flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
              active
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/40",
            )}
            aria-pressed={active}
          >
            <span
              className={cn(
                "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md",
                active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
              )}
              aria-hidden
            >
              <Bot className="size-3.5" />
            </span>
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium leading-none">{preset.label}</span>
              <span className="text-xs text-muted-foreground">{preset.description}</span>
            </span>
            {active && (
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            )}
          </button>
        );
      })}
    </div>
  );
}

function Step2Consent({
  preset,
  mcpUrl,
}: {
  preset: ClientPreset;
  mcpUrl: string;
}) {
  return (
    <div className="space-y-4 py-2 text-sm">
      <p className="text-muted-foreground">
        When you paste the config and restart <strong>{preset.label}</strong>, the agent
        will register itself with Atlas, then open your browser to authorize. You'll
        review and approve the request on Atlas's consent screen — exactly the same
        page you see when authorizing any OAuth app.
      </p>
      <div className="rounded-md border border-border bg-muted/40 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          The agent will request these scopes
        </p>
        <ul className="space-y-1.5">
          {SCOPE_DESCRIPTIONS.map((s) => (
            <li key={s.scope} className="flex items-baseline gap-2 text-xs">
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px]">
                {s.scope}
              </code>
              <span className="text-muted-foreground">{s.meaning}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        Atlas issues a JWT bound to your active workspace. Tokens expire and refresh
        automatically — you don't need to come back here unless you want to revoke
        the agent. Endpoint:{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{mcpUrl}</code>
      </p>
    </div>
  );
}

function Step3Deliver({
  preset,
  configJson,
  onCopy,
  copied,
  copyFailed,
}: {
  preset: ClientPreset;
  configJson: string;
  onCopy: () => void;
  copied: boolean;
  copyFailed: boolean;
}) {
  return (
    <div className="space-y-4 py-2 text-sm">
      <p className="text-muted-foreground">
        Paste this block into your <strong>{preset.label}</strong> MCP config, then
        restart the agent.
      </p>
      <div className="relative rounded-md border border-border bg-muted/40">
        <pre className="overflow-auto p-3 pr-12 font-mono text-[11px] leading-snug">
          <code>{configJson}</code>
        </pre>
        <Button
          variant="outline"
          size="xs"
          onClick={onCopy}
          className="absolute right-2 top-2"
          aria-label={copied ? "Config copied to clipboard" : "Copy config to clipboard"}
        >
          {copied ? (
            <>
              <Check className="mr-1 size-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="mr-1 size-3" />
              Copy
            </>
          )}
        </Button>
      </div>
      {copyFailed && (
        <p className="text-xs text-destructive">
          Couldn't access your clipboard — select the block above and copy manually.
        </p>
      )}
      <div className="flex items-center justify-between rounded-md border border-dashed border-border p-3">
        <span className="flex items-start gap-2 text-xs text-muted-foreground">
          <Code className="mt-0.5 size-3.5" aria-hidden />
          Need help finding the config file?
        </span>
        <a
          href={preset.pasteHelpHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          How to paste this in {preset.label}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
    </div>
  );
}
