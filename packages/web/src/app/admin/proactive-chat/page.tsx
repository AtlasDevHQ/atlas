"use client";

/**
 * Admin → Proactive Chat (#2294, PRD #2291).
 *
 * Workspace-level opt-in surface for the proactive-chat feature shipped
 * by #2292. Replaces the env-var allowlist with persisted config:
 *
 *   1. Master toggle — disabled by default; nothing happens until an
 *      admin flips it on.
 *   2. Sensitivity — how often the agent should chime in (cautious /
 *      balanced / eager).
 *   3. Classifier mode — `regex-prefilter` runs the regex layer first
 *      and only falls back to the LLM classifier when the regex layer
 *      is uncertain (cheap); `classify-all` always runs the LLM
 *      (expensive — only sensible with the announcement-channel scope
 *      or a small workspace).
 *   4. Announcement channel — optional. Future: a channel picker
 *      sourced from the chat-platform API. Free-form for this slice.
 *   5. Monthly classifier cap — optional spend safety net.
 *   6. Channel overrides — per-channel allow/deny, with optional
 *      per-channel sensitivity override.
 *
 * The whole page is enterprise-gated. Self-hosted free users see
 * `<EnterpriseUpsell feature="Proactive Chat" />` instead of the form;
 * the gate fires when the API returns 403 `enterprise_required`,
 * routed by `<AdminContentWrapper feature="Proactive Chat">`.
 */

import { useEffect, useState } from "react";
import {
  Bot,
  Hash,
  Loader2,
  Megaphone,
  Plus,
  Trash2,
} from "lucide-react";
import { z } from "zod";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  CompactRow,
  InlineError,
  SectionHeading,
  type StatusKind,
} from "@/ui/components/admin/compact";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ---------------------------------------------------------------------------
// Wire schemas (must agree with packages/api/src/api/routes/admin-proactive.ts)
// ---------------------------------------------------------------------------

const SENSITIVITIES = ["cautious", "balanced", "eager"] as const;
const CLASSIFIER_MODES = ["regex-prefilter", "classify-all"] as const;

type Sensitivity = (typeof SENSITIVITIES)[number];
type ClassifierMode = (typeof CLASSIFIER_MODES)[number];

const WorkspaceConfigSchema = z.object({
  workspaceId: z.string(),
  enabled: z.boolean(),
  sensitivity: z.enum(SENSITIVITIES),
  classifierMode: z.enum(CLASSIFIER_MODES),
  announcementChannelId: z.string().nullable(),
  monthlyClassifierCap: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

const ChannelOverrideSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  channelId: z.string(),
  allow: z.boolean(),
  sensitivity: z.enum(SENSITIVITIES).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type ChannelOverride = z.infer<typeof ChannelOverrideSchema>;

const ChannelsResponseSchema = z
  .object({ channels: z.array(ChannelOverrideSchema) })
  .transform((r) => r.channels);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProactiveChatPage() {
  return (
    <ErrorBoundary>
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Hero />
        <PageBody />
      </div>
    </ErrorBoundary>
  );
}

function Hero() {
  return (
    <header className="mb-10 flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Atlas · Admin
      </p>
      <div className="flex items-baseline justify-between gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">Proactive Chat</h1>
      </div>
      <p className="max-w-xl text-sm text-muted-foreground">
        Decide where Atlas chimes in unprompted. Off by default — every flip
        emits an audit row.
      </p>
    </header>
  );
}

function PageBody() {
  const { data, loading, error, refetch } = useAdminFetch<WorkspaceConfig>(
    "/api/v1/admin/proactive/workspace",
    { schema: WorkspaceConfigSchema },
  );

  return (
    <AdminContentWrapper
      loading={loading}
      error={error}
      feature="Proactive Chat"
      onRetry={refetch}
      loadingMessage="Loading proactive-chat settings..."
    >
      {data ? <ConfigForm initial={data} refetchWorkspace={refetch} /> : null}
    </AdminContentWrapper>
  );
}

// ---------------------------------------------------------------------------
// Workspace config form
// ---------------------------------------------------------------------------

interface ConfigFormProps {
  initial: WorkspaceConfig;
  refetchWorkspace: () => void;
}

function ConfigForm({ initial, refetchWorkspace }: ConfigFormProps) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [sensitivity, setSensitivity] = useState<Sensitivity>(initial.sensitivity);
  const [classifierMode, setClassifierMode] = useState<ClassifierMode>(
    initial.classifierMode,
  );
  const [announcementChannelId, setAnnouncementChannelId] = useState(
    initial.announcementChannelId ?? "",
  );
  const [monthlyCap, setMonthlyCap] = useState<string>(
    initial.monthlyClassifierCap === null ? "" : String(initial.monthlyClassifierCap),
  );

  // Reset form state when the fetched row changes — happens after a refetch
  // following save or after the master toggle drops into a different shape.
  useEffect(() => {
    setEnabled(initial.enabled);
    setSensitivity(initial.sensitivity);
    setClassifierMode(initial.classifierMode);
    setAnnouncementChannelId(initial.announcementChannelId ?? "");
    setMonthlyCap(
      initial.monthlyClassifierCap === null
        ? ""
        : String(initial.monthlyClassifierCap),
    );
  }, [initial]);

  const save = useAdminMutation({
    path: "/api/v1/admin/proactive/workspace",
    method: "PUT",
    invalidates: refetchWorkspace,
  });

  const monthlyCapNumeric =
    monthlyCap.trim() === "" ? null : Number(monthlyCap);
  const monthlyCapInvalid =
    monthlyCapNumeric !== null &&
    (!Number.isInteger(monthlyCapNumeric) || monthlyCapNumeric < 0);

  const dirty =
    enabled !== initial.enabled ||
    sensitivity !== initial.sensitivity ||
    classifierMode !== initial.classifierMode ||
    announcementChannelId !== (initial.announcementChannelId ?? "") ||
    monthlyCapNumeric !== initial.monthlyClassifierCap;

  async function handleSave() {
    if (monthlyCapInvalid) return;
    await save.mutate({
      body: {
        enabled,
        sensitivity,
        classifierMode,
        announcementChannelId:
          announcementChannelId.trim() === "" ? null : announcementChannelId.trim(),
        monthlyClassifierCap: monthlyCapNumeric,
      },
    });
  }

  return (
    <div className="space-y-10">
      <section>
        <SectionHeading
          title="Activation"
          description="Master switch — controls whether Atlas ever speaks up on its own."
        />
        <MasterToggleRow enabled={enabled} onToggle={setEnabled} />
      </section>

      <section>
        <SectionHeading
          title="Behavior"
          description="Workspace defaults applied unless a channel override says otherwise."
        />
        <div className="space-y-6">
          <SensitivityRadio value={sensitivity} onChange={setSensitivity} />
          <ClassifierModeRadio
            value={classifierMode}
            onChange={setClassifierMode}
          />
          <AnnouncementChannelField
            value={announcementChannelId}
            onChange={setAnnouncementChannelId}
          />
          <MonthlyCapField
            value={monthlyCap}
            onChange={setMonthlyCap}
            invalid={monthlyCapInvalid}
          />
        </div>
      </section>

      <MutationErrorSurface
        error={save.error}
        feature="Proactive Chat"
        variant="inline"
        inlinePrefix="Save failed."
      />
      {monthlyCapInvalid && (
        <InlineError>
          Monthly classifier cap must be a non-negative whole number.
        </InlineError>
      )}

      <footer className="flex items-center gap-2 border-t border-border/50 pt-5">
        <Button
          type="button"
          onClick={handleSave}
          disabled={save.saving || monthlyCapInvalid || !dirty}
          size="sm"
        >
          {save.saving && <Loader2 className="mr-1.5 size-3 animate-spin" />}
          {dirty ? "Save changes" : "Saved"}
        </Button>
      </footer>

      <section>
        <SectionHeading
          title="Channel overrides"
          description="Per-channel allow / deny and optional sensitivity override."
        />
        <ChannelOverridesTable />
      </section>

      <section>
        <SectionHeading
          title="Public dataset"
          description="Curated allowlist of semantic entities Atlas can answer about for non-linked askers in public channels. Empty by default — Atlas refuses every public-channel question until you opt in entity-by-entity."
        />
        <PublicDatasetSection />
      </section>

      <section>
        <SectionHeading
          title="Refused topics"
          description="What unlinked askers tried to ask about in the last 30 days. Inline 'Make public' adds the entity to the allowlist in one click."
        />
        <RefusedTopicsPanel />
      </section>

      <section>
        <SectionHeading
          title="Decision drill-down"
          description="Every classifier call from the last 30 days. Label individual decisions to track misfire rate against the PRD's <5% bar."
        />
        <DecisionDrillDownPanel />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Master toggle row
// ---------------------------------------------------------------------------

function MasterToggleRow({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (value: boolean) => void;
}) {
  const status: StatusKind = enabled ? "connected" : "disconnected";
  return (
    <CompactRow
      icon={Bot}
      title="Enable proactive chat"
      description={
        enabled
          ? "Atlas may volunteer answers in channels it's invited to"
          : "Atlas only responds when explicitly mentioned (default)"
      }
      status={status}
      statusLabel={enabled ? "Enabled" : "Disabled"}
      action={
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          aria-label="Enable proactive chat"
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Sensitivity / classifier-mode radio groups
// ---------------------------------------------------------------------------

const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  cautious: "Cautious — only obvious data questions",
  balanced: "Balanced — most reasonable data questions (default)",
  eager: "Eager — even loose mentions of metrics",
};

function SensitivityRadio({
  value,
  onChange,
}: {
  value: Sensitivity;
  onChange: (value: Sensitivity) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Sensitivity</legend>
      <p className="text-[12px] text-muted-foreground">
        How readily Atlas decides a message is a data question.
      </p>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as Sensitivity)}
        className="space-y-1"
      >
        {SENSITIVITIES.map((s) => (
          <div key={s} className="flex items-center gap-3">
            <RadioGroupItem value={s} id={`proactive-sensitivity-${s}`} />
            <Label htmlFor={`proactive-sensitivity-${s}`} className="text-sm">
              {SENSITIVITY_LABELS[s]}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

const CLASSIFIER_LABELS: Record<ClassifierMode, string> = {
  "regex-prefilter":
    "Regex prefilter — cheap; falls back to the LLM classifier only when uncertain (default)",
  "classify-all":
    "Classify all — always runs the LLM classifier (more accurate, higher cost)",
};

function ClassifierModeRadio({
  value,
  onChange,
}: {
  value: ClassifierMode;
  onChange: (value: ClassifierMode) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Classifier mode</legend>
      <p className="text-[12px] text-muted-foreground">
        Whether to gate the LLM classifier behind a regex prefilter.
      </p>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as ClassifierMode)}
        className="space-y-1"
      >
        {CLASSIFIER_MODES.map((m) => (
          <div key={m} className="flex items-center gap-3">
            <RadioGroupItem value={m} id={`proactive-classifier-${m}`} />
            <Label htmlFor={`proactive-classifier-${m}`} className="text-sm">
              {CLASSIFIER_LABELS[m]}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Announcement channel + monthly cap fields
// ---------------------------------------------------------------------------

function AnnouncementChannelField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="proactive-announcement-channel" className="text-sm font-medium">
        Announcement channel
      </Label>
      <p className="text-[12px] text-muted-foreground">
        Optional. When the agent has something proactive to share with the
        whole workspace, it posts here instead of any individual channel.
        Leave blank to disable workspace-wide announcements.
      </p>
      <div className="flex items-center gap-2">
        <Megaphone className="size-4 shrink-0 text-muted-foreground" />
        <Input
          id="proactive-announcement-channel"
          placeholder="C0123456789"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-sm"
        />
      </div>
    </div>
  );
}

function MonthlyCapField({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="proactive-monthly-cap" className="text-sm font-medium">
        Monthly classifier cap
      </Label>
      <p className="text-[12px] text-muted-foreground">
        Optional. Hard cap on classifier invocations per calendar month. When
        the cap is reached, proactive chat short-circuits before the
        classifier runs until the next reset (calendar month, UTC). Leave
        blank for no cap.
      </p>
      <Input
        id="proactive-monthly-cap"
        type="number"
        min={0}
        step={1}
        placeholder="e.g. 10000"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        className="max-w-[180px] font-mono text-sm"
      />
      <QuotaUsageIndicator />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quota usage indicator (#2301)
//
// Reads `GET /api/v1/admin/proactive/analytics` and renders a tiny usage
// bar with traffic-light colors:
//   - <80%  grey   (under cap, no concern)
//   - 80%+  yellow (warn — admin may want to raise the cap)
//   - 100%  red    (exhausted — proactive is silently short-circuiting)
//
// Rendered inline under the cap input so the admin can see the impact of
// the value they just typed. Hides itself when the workspace has never
// set a cap (`monthlyClassifierCap === null`) — there's nothing to
// usage-bar against.
// ---------------------------------------------------------------------------

// Both `QuotaUsageIndicator` and `DecisionDrillDownPanel` read this same
// endpoint. TanStack Query dedupes by path and Zod's `z.object` strips
// unrecognized keys, so two parallel `useAdminFetch` calls with partial
// schemas would have one consumer's slice silently dropped from the cached
// parsed value (#2637 regression — the drill-down's `summary.classifyCount`
// access crashed when the quota indicator's schema parsed first). Validate
// both slices in a single schema so the cached value is shaped for either
// reader.
const AnalyticsResponseSchema = z.object({
  summary: z.object({
    classifyCount: z.number().int().nonnegative(),
    reactCount: z.number().int().nonnegative(),
  }),
  quota: z.object({
    classifyCountThisMonth: z.number().int().nonnegative(),
    monthlyClassifierCap: z.number().int().nonnegative().nullable(),
    capReached: z.boolean(),
  }),
});

type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;

function QuotaUsageIndicator() {
  const { data, loading, error } = useAdminFetch<AnalyticsResponse>(
    "/api/v1/admin/proactive/analytics",
    { schema: AnalyticsResponseSchema },
  );

  if (loading || error || !data) return null;
  const { classifyCountThisMonth, monthlyClassifierCap, capReached } = data.quota;
  if (monthlyClassifierCap === null) return null;

  const pct =
    monthlyClassifierCap === 0
      ? 100
      : Math.min(
          100,
          Math.round((classifyCountThisMonth / monthlyClassifierCap) * 100),
        );
  const yellow = pct >= 80 && !capReached;
  const red = capReached;

  const barColor = red
    ? "bg-destructive"
    : yellow
      ? "bg-yellow-500"
      : "bg-muted-foreground/40";
  const labelColor = red
    ? "text-destructive"
    : yellow
      ? "text-yellow-700 dark:text-yellow-500"
      : "text-muted-foreground";

  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="h-1.5 w-full max-w-[260px] overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className={`text-[11px] ${labelColor}`}>
        {classifyCountThisMonth.toLocaleString()} /{" "}
        {monthlyClassifierCap.toLocaleString()} classifies this month ({pct}%)
        {red && " — cap reached; proactive will resume next month"}
        {yellow && " — approaching cap"}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel overrides table
// ---------------------------------------------------------------------------

function ChannelOverridesTable() {
  const { data, loading, error, refetch } = useAdminFetch<ChannelOverride[]>(
    "/api/v1/admin/proactive/channels",
    { schema: ChannelsResponseSchema },
  );

  const upsert = useAdminMutation({
    path: "/api/v1/admin/proactive/channels",
    method: "POST",
    invalidates: refetch,
  });

  // Row-shape inputs for a single staged channel — saved on "Add override".
  const [draftChannelId, setDraftChannelId] = useState("");
  const [draftAllow, setDraftAllow] = useState(true);
  const [draftSensitivity, setDraftSensitivity] = useState<"" | Sensitivity>("");

  async function handleAdd() {
    const trimmed = draftChannelId.trim();
    if (!trimmed) return;
    const result = await upsert.mutate({
      body: {
        channelId: trimmed,
        allow: draftAllow,
        sensitivity: draftSensitivity === "" ? null : draftSensitivity,
      },
    });
    if (result.ok) {
      setDraftChannelId("");
      setDraftAllow(true);
      setDraftSensitivity("");
    }
  }

  return (
    <AdminContentWrapper
      loading={loading}
      error={error}
      feature="Proactive Chat"
      onRetry={refetch}
      loadingMessage="Loading channel overrides..."
    >
      <div className="space-y-4">
        <div className="rounded-lg border bg-muted/30 p-4">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            Add override
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="proactive-add-channel" className="text-[11px]">
                Channel ID
              </Label>
              <div className="flex items-center gap-2">
                <Hash className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  id="proactive-add-channel"
                  placeholder="C0123456789"
                  value={draftChannelId}
                  onChange={(e) => setDraftChannelId(e.target.value)}
                  className="w-[180px] font-mono text-xs"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px]">Allow proactive</Label>
              <div className="flex items-center gap-2 pt-1.5">
                <Switch
                  checked={draftAllow}
                  onCheckedChange={setDraftAllow}
                  aria-label="Allow proactive in this channel"
                />
                <span className="text-[12px] text-muted-foreground">
                  {draftAllow ? "Allow" : "Deny"}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px]">Sensitivity (optional)</Label>
              <Select
                value={draftSensitivity}
                onValueChange={(v) =>
                  setDraftSensitivity(v === "default" ? "" : (v as Sensitivity))
                }
              >
                <SelectTrigger className="w-[180px] text-xs">
                  <SelectValue placeholder="Workspace default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Workspace default</SelectItem>
                  {SENSITIVITIES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleAdd}
              disabled={upsert.saving || !draftChannelId.trim()}
            >
              {upsert.saving ? (
                <Loader2 className="mr-1.5 size-3 animate-spin" />
              ) : (
                <Plus className="mr-1.5 size-3.5" />
              )}
              Save override
            </Button>
          </div>
          <MutationErrorSurface
            error={upsert.error}
            feature="Proactive Chat"
            variant="inline"
            inlinePrefix="Save failed."
          />
        </div>

        {data && data.length > 0 ? (
          <ul className="space-y-1.5">
            {data.map((row) => (
              <ChannelRow key={row.id} row={row} refetch={refetch} />
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-[12px] text-muted-foreground">
            No channel overrides yet. Workspace defaults apply everywhere.
          </p>
        )}
      </div>
    </AdminContentWrapper>
  );
}

function ChannelRow({
  row,
  refetch,
}: {
  row: ChannelOverride;
  refetch: () => void;
}) {
  const remove = useAdminMutation({
    path: `/api/v1/admin/proactive/channels/${encodeURIComponent(row.channelId)}`,
    method: "DELETE",
    invalidates: refetch,
  });

  const status: StatusKind = row.allow ? "connected" : "disconnected";
  const description = row.sensitivity
    ? `${row.allow ? "Allow" : "Deny"} · sensitivity: ${row.sensitivity}`
    : row.allow
      ? "Allow · workspace default sensitivity"
      : "Deny";

  return (
    <li>
      <CompactRow
        icon={Hash}
        title={row.channelId}
        description={description}
        status={status}
        statusLabel={row.allow ? "Allow" : "Deny"}
        action={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => remove.mutate({})}
            disabled={remove.saving}
            aria-label={`Remove override for ${row.channelId}`}
          >
            {remove.saving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </Button>
        }
      />
      <MutationErrorSurface
        error={remove.error}
        feature="Proactive Chat"
        variant="inline"
        inlinePrefix="Remove failed."
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Public dataset section (#2297)
// ---------------------------------------------------------------------------

const PublicDatasetEntrySchema = z.object({
  entityName: z.string().min(1),
  denyMetrics: z.array(z.string()),
});

type PublicDatasetEntryT = z.infer<typeof PublicDatasetEntrySchema>;

const PublicDatasetListSchema = z
  .object({ entries: z.array(PublicDatasetEntrySchema) })
  .transform((r) => r.entries);

const RefusedRollupRowSchema = z.object({
  entityName: z.string(),
  count: z.number().int().nonnegative(),
});

type RefusedRollupRowT = z.infer<typeof RefusedRollupRowSchema>;

const RefusedRollupResponseSchema = z.object({
  sinceMs: z.number().int().positive(),
  rollup: z.array(RefusedRollupRowSchema),
});

function PublicDatasetSection() {
  const { data, loading, error, refetch } = useAdminFetch<PublicDatasetEntryT[]>(
    "/api/v1/admin/proactive/public-dataset",
    { schema: PublicDatasetListSchema },
  );

  const upsert = useAdminMutation({
    path: "/api/v1/admin/proactive/public-dataset",
    method: "POST",
    invalidates: refetch,
  });

  const [draftEntity, setDraftEntity] = useState("");
  const [draftDeny, setDraftDeny] = useState("");

  async function handleAdd() {
    const entityName = draftEntity.trim();
    if (!entityName) return;
    const denyMetrics = draftDeny
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const result = await upsert.mutate({
      body: { entityName, denyMetrics },
    });
    if (result.ok) {
      setDraftEntity("");
      setDraftDeny("");
    }
  }

  return (
    <AdminContentWrapper
      loading={loading}
      error={error}
      feature="Proactive Chat"
      onRetry={refetch}
      loadingMessage="Loading public dataset..."
    >
      <div className="space-y-4">
        <div className="rounded-lg border bg-muted/30 p-4">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            Add entity
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="public-dataset-entity" className="text-[11px]">
                Entity name
              </Label>
              <Input
                id="public-dataset-entity"
                placeholder="marketing.users"
                value={draftEntity}
                onChange={(e) => setDraftEntity(e.target.value)}
                className="w-[220px] font-mono text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="public-dataset-deny" className="text-[11px]">
                Deny metrics (comma-separated)
              </Label>
              <Input
                id="public-dataset-deny"
                placeholder="email, phone_number"
                value={draftDeny}
                onChange={(e) => setDraftDeny(e.target.value)}
                className="w-[260px] font-mono text-xs"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleAdd}
              disabled={upsert.saving || !draftEntity.trim()}
            >
              {upsert.saving ? (
                <Loader2 className="mr-1.5 size-3 animate-spin" />
              ) : (
                <Plus className="mr-1.5 size-3.5" />
              )}
              Save entity
            </Button>
          </div>
          <MutationErrorSurface
            error={upsert.error}
            feature="Proactive Chat"
            variant="inline"
            inlinePrefix="Save failed."
          />
        </div>

        {data && data.length > 0 ? (
          <ul className="space-y-1.5">
            {data.map((row) => (
              <PublicDatasetRow key={row.entityName} row={row} refetch={refetch} />
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-[12px] text-muted-foreground">
            No entities are public yet. Atlas will refuse every public-channel
            question from non-linked askers until you opt in.
          </p>
        )}
      </div>
    </AdminContentWrapper>
  );
}

function PublicDatasetRow({
  row,
  refetch,
}: {
  row: PublicDatasetEntryT;
  refetch: () => void;
}) {
  const remove = useAdminMutation({
    path: `/api/v1/admin/proactive/public-dataset/${encodeURIComponent(row.entityName)}`,
    method: "DELETE",
    invalidates: refetch,
  });

  const description =
    row.denyMetrics.length > 0
      ? `Public - deny metrics: ${row.denyMetrics.join(", ")}`
      : "Public - all metrics allowed";

  return (
    <li>
      <CompactRow
        icon={Bot}
        title={row.entityName}
        description={description}
        status="connected"
        statusLabel="Public"
        action={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => remove.mutate({})}
            disabled={remove.saving}
            aria-label={`Remove ${row.entityName} from public dataset`}
          >
            {remove.saving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </Button>
        }
      />
      <MutationErrorSurface
        error={remove.error}
        feature="Proactive Chat"
        variant="inline"
        inlinePrefix="Remove failed."
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Refused topics rollup (#2297)
// ---------------------------------------------------------------------------

function RefusedTopicsPanel() {
  const { data, loading, error, refetch } = useAdminFetch<
    z.infer<typeof RefusedRollupResponseSchema>
  >("/api/v1/admin/proactive/public-dataset/refused", {
    schema: RefusedRollupResponseSchema,
  });

  const upsert = useAdminMutation({
    path: "/api/v1/admin/proactive/public-dataset",
    method: "POST",
    invalidates: refetch,
  });

  async function handleMakePublic(entityName: string) {
    await upsert.mutate({ body: { entityName, denyMetrics: [] } });
  }

  return (
    <AdminContentWrapper
      loading={loading}
      error={error}
      feature="Proactive Chat"
      onRetry={refetch}
      loadingMessage="Loading refused topics..."
    >
      {data && data.rollup.length > 0 ? (
        <ul className="space-y-1.5">
          {data.rollup.map((row) => (
            <RefusedRollupRow
              key={row.entityName}
              row={row}
              onMakePublic={() => handleMakePublic(row.entityName)}
              saving={upsert.saving}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-[12px] text-muted-foreground">
          No refused topics in the last 30 days. Either the public dataset
          covers everything askers are trying or nobody's asked yet.
        </p>
      )}
      <MutationErrorSurface
        error={upsert.error}
        feature="Proactive Chat"
        variant="inline"
        inlinePrefix="Save failed."
      />
    </AdminContentWrapper>
  );
}

function RefusedRollupRow({
  row,
  onMakePublic,
  saving,
}: {
  row: RefusedRollupRowT;
  onMakePublic: () => void;
  saving: boolean;
}) {
  return (
    <li>
      <CompactRow
        icon={Hash}
        title={row.entityName}
        description={`${row.count} refused question${row.count === 1 ? "" : "s"} in the last 30 days`}
        status="disconnected"
        statusLabel="Refused"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onMakePublic}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-3 animate-spin" />
            ) : (
              <Plus className="mr-1.5 size-3.5" />
            )}
            Make public
          </Button>
        }
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Decision drill-down (#2622)
// ---------------------------------------------------------------------------

const REVIEW_VERDICTS = ["misfire", "correct", "unsure"] as const;
type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

const EventReviewSchema = z.object({
  verdict: z.enum(REVIEW_VERDICTS),
  note: z.string().nullable(),
  reviewerUserId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const EventRowSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  channelId: z.string(),
  messageId: z.string().nullable(),
  eventType: z.string(),
  outcome: z.string().nullable(),
  tokens: z.number().int().nonnegative(),
  costMicroUsd: z.number().int().nonnegative(),
  confidence: z.number().nullable(),
  actorUserId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  review: EventReviewSchema.nullable(),
});

type EventRowT = z.infer<typeof EventRowSchema>;

const EventsResponseSchema = z.object({
  workspaceId: z.string(),
  sinceMs: z.number().int().positive(),
  eventType: z.string().nullable(),
  events: z.array(EventRowSchema),
  nextCursor: z.string().nullable(),
  reviewSummary: z.object({
    classifyCount: z.number().int().nonnegative(),
    reviewedCount: z.number().int().nonnegative(),
    misfireCount: z.number().int().nonnegative(),
    correctCount: z.number().int().nonnegative(),
    unsureCount: z.number().int().nonnegative(),
  }),
});

function DecisionDrillDownPanel() {
  // Share the same schema as `QuotaUsageIndicator` so TanStack Query's
  // path-keyed dedupe returns a value that's shaped for both consumers.
  const aggregate = useAdminFetch<AnalyticsResponse>(
    "/api/v1/admin/proactive/analytics",
    { schema: AnalyticsResponseSchema },
  );
  const events = useAdminFetch<z.infer<typeof EventsResponseSchema>>(
    "/api/v1/admin/proactive/events?since=30d&eventType=classify&limit=50",
    { schema: EventsResponseSchema },
  );

  return (
    <AdminContentWrapper
      loading={events.loading}
      error={events.error}
      feature="Proactive Chat"
      onRetry={events.refetch}
      loadingMessage="Loading classifier decisions..."
    >
      {events.data ? (
        <div className="space-y-5">
          <DrillDownTiles
            aggregateClassify={aggregate.data?.summary.classifyCount ?? null}
            aggregateReact={aggregate.data?.summary.reactCount ?? null}
            reviewSummary={events.data.reviewSummary}
          />
          <EventsTable
            initial={events.data}
            refetchAll={() => {
              events.refetch();
              aggregate.refetch();
            }}
          />
        </div>
      ) : null}
    </AdminContentWrapper>
  );
}

function DrillDownTiles({
  aggregateClassify,
  aggregateReact,
  reviewSummary,
}: {
  aggregateClassify: number | null;
  aggregateReact: number | null;
  reviewSummary: z.infer<typeof EventsResponseSchema>["reviewSummary"];
}) {
  // Implicit misfire metric — react / classify, no labels required.
  // Showing both numbers (and the ratio) so the admin can sanity-check
  // a noisy-looking percent at a glance ("4/12 is small, 400/1200 is
  // big — they read identically as 33%").
  const reactPct =
    aggregateClassify === null || aggregateClassify === 0
      ? null
      : Math.round(((aggregateReact ?? 0) / aggregateClassify) * 100);

  // Labelled misfire rate — hidden until at least one review exists,
  // per AC.
  const misfirePct =
    reviewSummary.reviewedCount === 0
      ? null
      : Math.round(
          (reviewSummary.misfireCount / reviewSummary.reviewedCount) * 100,
        );

  let classifySecondary: string;
  if (aggregateClassify === null) {
    classifySecondary = "loading";
  } else if (aggregateClassify === 0) {
    classifySecondary = "no calls in window";
  } else {
    classifySecondary = "30-day rolling";
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <DrillDownTile
        label="Classifier calls (30d)"
        primary={aggregateClassify ?? "—"}
        secondary={classifySecondary}
      />
      <DrillDownTile
        label="React rate"
        primary={reactPct === null ? "—" : `${reactPct}%`}
        secondary={
          aggregateClassify === null
            ? "loading"
            : `${aggregateReact ?? 0} / ${aggregateClassify} reacted`
        }
      />
      {misfirePct === null ? (
        <DrillDownTile
          label="Misfire rate (labelled)"
          primary="—"
          secondary="Label decisions below to populate"
        />
      ) : (
        <DrillDownTile
          label="Misfire rate (labelled)"
          primary={`${misfirePct}%`}
          secondary={`${reviewSummary.misfireCount} / ${reviewSummary.reviewedCount} reviewed`}
          tone={misfirePct >= 5 ? "warn" : "ok"}
        />
      )}
    </div>
  );
}

function DrillDownTile({
  label,
  primary,
  secondary,
  tone = "neutral",
}: {
  label: string;
  primary: string | number;
  secondary: string;
  tone?: "neutral" | "ok" | "warn";
}) {
  let toneClass: string;
  switch (tone) {
    case "warn":
      toneClass = "text-amber-700 dark:text-amber-500";
      break;
    case "ok":
      toneClass = "text-emerald-700 dark:text-emerald-500";
      break;
    default:
      toneClass = "text-foreground";
  }
  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>
        {primary}
      </p>
      <p className="text-[11px] text-muted-foreground">{secondary}</p>
    </div>
  );
}

function EventsTable({
  initial,
  refetchAll,
}: {
  initial: z.infer<typeof EventsResponseSchema>;
  refetchAll: () => void;
}) {
  if (initial.events.length === 0) {
    return (
      <p className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-[12px] text-muted-foreground">
        No classifier decisions in the last 30 days. Once dogfood traffic
        starts flowing, every classify lands here.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-[12px]">
        <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">When</th>
            <th className="px-3 py-2 text-left font-medium">Channel</th>
            <th className="px-3 py-2 text-left font-medium">Confidence</th>
            <th className="px-3 py-2 text-left font-medium">Action</th>
            <th className="px-3 py-2 text-left font-medium">Reason</th>
            <th className="px-3 py-2 text-right font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {initial.events.map((row) => (
            <EventTableRow key={row.id} row={row} refetchAll={refetchAll} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Slack message-ts heuristic — channel id starts with C/D/G (channel /
// DM / group) and the message id is `<unix>.<seq>`. Falling back to
// `slack.com/archives/...` (no workspace subdomain) lets the user
// click through; Slack 302-redirects to the right workspace. Avoids a
// per-row workspace metadata lookup just to render a link.
function slackPermalink(channelId: string, messageId: string | null): string | null {
  if (!messageId) return null;
  if (!/^[CDG][A-Z0-9]{8,}$/.test(channelId)) return null;
  if (!/^\d+\.\d+$/.test(messageId)) return null;
  const tsCompact = messageId.replace(".", "");
  return `https://slack.com/archives/${channelId}/p${tsCompact}`;
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  if (Number.isNaN(diffMs)) return iso;
  if (diffMs < 60_000) return "just now";
  if (diffMs < 60 * 60_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 24 * 60 * 60_000) return `${Math.floor(diffMs / (60 * 60_000))}h ago`;
  return `${Math.floor(diffMs / (24 * 60 * 60_000))}d ago`;
}

function EventTableRow({
  row,
  refetchAll,
}: {
  row: EventRowT;
  refetchAll: () => void;
}) {
  const review = useAdminMutation({
    path: `/api/v1/admin/proactive/events/${encodeURIComponent(row.messageId ?? "")}/review`,
    method: "POST",
    invalidates: refetchAll,
  });
  const permalink = slackPermalink(row.channelId, row.messageId);
  const action = typeof row.metadata.action === "string" ? row.metadata.action : "—";
  const reason = typeof row.metadata.reason === "string" ? row.metadata.reason : "";
  const currentVerdict: ReviewVerdict | null = row.review?.verdict ?? null;

  async function setVerdict(verdict: ReviewVerdict) {
    if (!row.messageId) return;
    await review.mutate({ body: { verdict } });
  }

  return (
    <tr className="bg-background">
      <td className="px-3 py-2 align-top text-[11px] text-muted-foreground tabular-nums">
        {formatRelative(row.createdAt)}
      </td>
      <td className="px-3 py-2 align-top">
        {permalink ? (
          <a
            href={permalink}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] underline-offset-2 hover:underline"
          >
            {row.channelId}
          </a>
        ) : (
          <span className="font-mono text-[11px]">{row.channelId}</span>
        )}
      </td>
      <td className="px-3 py-2 align-top text-[11px] tabular-nums">
        {row.confidence === null ? "—" : row.confidence.toFixed(2)}
      </td>
      <td className="px-3 py-2 align-top text-[11px]">{action}</td>
      <td className="px-3 py-2 align-top text-[11px] text-muted-foreground">
        {reason ? <span title={reason}>{reason}</span> : "—"}
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap justify-end gap-1">
          {REVIEW_VERDICTS.map((verdict) => {
            const active = currentVerdict === verdict;
            return (
              <Button
                key={verdict}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => setVerdict(verdict)}
                disabled={!row.messageId || review.saving}
                className="h-6 px-2 text-[10px] capitalize"
                title={
                  !row.messageId
                    ? "No message id — verdict cannot be recorded"
                    : `Mark this decision ${verdict}`
                }
                aria-pressed={active}
              >
                {review.saving && active ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  verdict
                )}
              </Button>
            );
          })}
        </div>
        {review.error ? (
          <p className="mt-1 text-right text-[10px] text-destructive">
            Review failed.
          </p>
        ) : null}
      </td>
    </tr>
  );
}

