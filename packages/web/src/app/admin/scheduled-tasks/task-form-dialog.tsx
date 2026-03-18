"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, X, Clock } from "lucide-react";
import {
  CRON_PRESETS,
  presetFromCron,
  describeCron,
  nextRunTimes,
  isValidCron,
} from "./cron-helpers";

import type {
  ScheduledTask,
  DeliveryChannel,
  ActionApprovalMode,
} from "@/ui/lib/types";

// ── Types ─────────────────────────────────────────────────────────────

interface ConnectionInfo {
  id: string;
  type: string;
}

// Form state (flat, before mapping to API shape)
interface FormState {
  name: string;
  question: string;
  cronPreset: string;
  cronExpression: string;
  deliveryChannel: DeliveryChannel;
  approvalMode: ActionApprovalMode;
  connectionId: string;
  enabled: boolean;
  // Email recipients
  emailAddresses: string[];
  emailInput: string;
  // Slack
  slackChannel: string;
  slackTeamId: string;
  // Webhook
  webhookUrl: string;
  webhookHeaders: Array<{ key: string; value: string }>;
}

function defaultFormState(): FormState {
  return {
    name: "",
    question: "",
    cronPreset: "daily-9am",
    cronExpression: "0 9 * * *",
    deliveryChannel: "email",
    approvalMode: "auto",
    connectionId: "default",
    enabled: true,
    emailAddresses: [],
    emailInput: "",
    slackChannel: "",
    slackTeamId: "",
    webhookUrl: "",
    webhookHeaders: [],
  };
}

function parseRecipients(task: ScheduledTask) {
  const emailAddresses: string[] = [];
  let slackChannel = "";
  let slackTeamId = "";
  let webhookUrl = "";
  let webhookHeaders: Array<{ key: string; value: string }> = [];
  let recognized = 0;

  for (const r of task.recipients) {
    switch (r.type) {
      case "email":
        emailAddresses.push(r.address);
        recognized++;
        break;
      case "slack":
        slackChannel = r.channel;
        if (r.teamId) slackTeamId = r.teamId;
        recognized++;
        break;
      case "webhook":
        webhookUrl = r.url;
        if (r.headers && typeof r.headers === "object") {
          webhookHeaders = Object.entries(r.headers as Record<string, string>).map(
            ([key, value]) => ({ key, value }),
          );
        }
        recognized++;
        break;
    }
  }

  if (recognized < task.recipients.length) {
    console.warn(
      `[TaskFormDialog] ${task.recipients.length - recognized} recipient(s) could not be mapped for task ${task.id}`,
    );
  }

  return { emailAddresses, slackChannel, slackTeamId, webhookUrl, webhookHeaders };
}

function formStateFromTask(task: ScheduledTask): FormState {
  const recipients = parseRecipients(task);
  return {
    ...defaultFormState(),
    name: task.name,
    question: task.question,
    cronExpression: task.cronExpression,
    cronPreset: presetFromCron(task.cronExpression),
    deliveryChannel: task.deliveryChannel,
    approvalMode: task.approvalMode,
    connectionId: task.connectionId ?? "default",
    enabled: task.enabled,
    ...recipients,
  };
}

// ── Component ─────────────────────────────────────────────────────────

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: ScheduledTask | null; // null = create mode
  apiUrl: string;
  credentials: RequestCredentials;
  onSuccess: () => void;
}

export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  apiUrl,
  credentials,
  onSuccess,
}: TaskFormDialogProps) {
  const isEdit = task !== null;
  const [form, setForm] = useState<FormState>(defaultFormState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setForm(task ? formStateFromTask(task) : defaultFormState());
      setError(null);
    }
  }, [open, task]);

  // Fetch connections
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function fetchConnections() {
      setConnectionError(null);
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/connections`, { credentials });
        if (!res.ok) {
          if (!cancelled) setConnectionError(`Could not load connections (HTTP ${res.status})`);
          return;
        }
        const data = await res.json();
        if (!cancelled && Array.isArray(data.connections)) {
          setConnections(data.connections);
        }
      } catch (err) {
        console.warn("[TaskFormDialog] Failed to fetch connections:", err);
        if (!cancelled) setConnectionError("Could not load connections");
      }
    }
    fetchConnections();
    return () => { cancelled = true; };
  }, [open, apiUrl, credentials]);

  // ── Field updaters ──────────────────────────────────────────────────

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handlePresetChange(preset: string) {
    const match = CRON_PRESETS.find((p) => p.value === preset);
    setForm((prev) => ({
      ...prev,
      cronPreset: preset,
      ...(match?.cron ? { cronExpression: match.cron } : {}),
    }));
  }

  // ── Email helpers ───────────────────────────────────────────────────

  function addEmail() {
    const email = form.emailInput.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    if (form.emailAddresses.includes(email)) return;
    setForm((prev) => ({
      ...prev,
      emailAddresses: [...prev.emailAddresses, email],
      emailInput: "",
    }));
  }

  function removeEmail(email: string) {
    setForm((prev) => ({
      ...prev,
      emailAddresses: prev.emailAddresses.filter((e) => e !== email),
    }));
  }

  // ── Webhook header helpers ──────────────────────────────────────────

  function addHeader() {
    setForm((prev) => ({
      ...prev,
      webhookHeaders: [...prev.webhookHeaders, { key: "", value: "" }],
    }));
  }

  function updateHeader(index: number, field: "key" | "value", val: string) {
    setForm((prev) => ({
      ...prev,
      webhookHeaders: prev.webhookHeaders.map((h, i) =>
        i === index ? { ...h, [field]: val } : h,
      ),
    }));
  }

  function removeHeader(index: number) {
    setForm((prev) => ({
      ...prev,
      webhookHeaders: prev.webhookHeaders.filter((_, i) => i !== index),
    }));
  }

  // ── Submit ──────────────────────────────────────────────────────────

  function buildRecipients() {
    switch (form.deliveryChannel) {
      case "email":
        return form.emailAddresses.map((address) => ({ type: "email" as const, address }));
      case "slack": {
        if (!form.slackChannel) return [];
        return [{
          type: "slack" as const,
          channel: form.slackChannel,
          ...(form.slackTeamId ? { teamId: form.slackTeamId } : {}),
        }];
      }
      case "webhook": {
        if (!form.webhookUrl) return [];
        const headers: Record<string, string> = {};
        for (const h of form.webhookHeaders) {
          if (h.key.trim()) headers[h.key.trim()] = h.value;
        }
        return [{ type: "webhook" as const, url: form.webhookUrl, ...(Object.keys(headers).length > 0 ? { headers } : {}) }];
      }
    }
  }

  async function handleSubmit() {
    setError(null);

    // Validate
    if (!form.name.trim()) { setError("Name is required"); return; }
    if (!form.question.trim()) { setError("Question is required"); return; }
    if (!form.cronExpression.trim()) { setError("Cron expression is required"); return; }
    if (!isValidCron(form.cronExpression)) { setError("Invalid cron expression format"); return; }

    const recipients = buildRecipients();
    if (recipients.length === 0) {
      switch (form.deliveryChannel) {
        case "email": setError("At least one email recipient is required"); break;
        case "slack": setError("Slack channel is required"); break;
        case "webhook": setError("Webhook URL is required"); break;
      }
      return;
    }

    const body = {
      name: form.name.trim(),
      question: form.question.trim(),
      cronExpression: form.cronExpression.trim(),
      deliveryChannel: form.deliveryChannel,
      recipients,
      connectionId: form.connectionId === "default" ? null : form.connectionId,
      approvalMode: form.approvalMode,
      ...(isEdit ? { enabled: form.enabled } : {}),
    };

    setSubmitting(true);
    try {
      const url = task
        ? `${apiUrl}/api/v1/scheduled-tasks/${encodeURIComponent(task.id)}`
        : `${apiUrl}/api/v1/scheduled-tasks`;
      const res = await fetch(url, {
        credentials,
        method: task ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const msg = data?.message ?? `HTTP ${res.status}`;
        setError(msg);
        return;
      }
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Cron preview ────────────────────────────────────────────────────

  const cronDescription = form.cronExpression ? describeCron(form.cronExpression) : "";
  const cronValid = form.cronExpression ? isValidCron(form.cronExpression) : false;
  const nextRuns = cronValid ? nextRunTimes(form.cronExpression, 3) : [];

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Task" : "Create Task"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the scheduled task configuration."
              : "Create a new recurring query with automated delivery."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Name */}
          <div className="grid gap-2">
            <Label htmlFor="task-name">Name</Label>
            <Input
              id="task-name"
              placeholder="Daily revenue report"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
            />
          </div>

          {/* Question */}
          <div className="grid gap-2">
            <Label htmlFor="task-question">Question</Label>
            <Textarea
              id="task-question"
              placeholder="What was our total revenue yesterday, broken down by product?"
              rows={3}
              value={form.question}
              onChange={(e) => updateField("question", e.target.value)}
            />
          </div>

          {/* Cron */}
          <div className="grid gap-2">
            <Label>Schedule</Label>
            <Select value={form.cronPreset} onValueChange={handlePresetChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRON_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="0 9 * * *"
              className="font-mono text-sm"
              value={form.cronExpression}
              onChange={(e) => {
                setForm((prev) => ({ ...prev, cronExpression: e.target.value, cronPreset: "custom" }));
              }}
            />
            {form.cronExpression && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{cronDescription}</p>
                {nextRuns.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <Clock className="size-3 text-muted-foreground" />
                    {nextRuns.map((d, i) => (
                      <Badge key={i} variant="outline" className="text-xs font-normal">
                        {d.toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                          timeZoneName: "short",
                        })}
                      </Badge>
                    ))}
                  </div>
                ) : cronValid ? (
                  <p className="text-xs text-destructive">
                    This expression does not match any dates in the next year.
                  </p>
                ) : null}
              </div>
            )}
          </div>

          {/* Delivery Channel */}
          <div className="grid gap-2">
            <Label>Delivery channel</Label>
            <Select
              value={form.deliveryChannel}
              onValueChange={(v) => updateField("deliveryChannel", v as DeliveryChannel)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="slack">Slack</SelectItem>
                <SelectItem value="webhook">Webhook</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Recipients — Email */}
          {form.deliveryChannel === "email" && (
            <div className="grid gap-2">
              <Label>Email recipients</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="user@example.com"
                  value={form.emailInput}
                  onChange={(e) => updateField("emailInput", e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addEmail();
                    }
                  }}
                />
                <Button type="button" variant="outline" size="icon" onClick={addEmail}>
                  <Plus className="size-4" />
                </Button>
              </div>
              {form.emailAddresses.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {form.emailAddresses.map((email) => (
                    <Badge key={email} variant="secondary" className="gap-1">
                      {email}
                      <button
                        type="button"
                        onClick={() => removeEmail(email)}
                        className="ml-0.5 rounded-full hover:bg-muted"
                      >
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Recipients — Slack */}
          {form.deliveryChannel === "slack" && (
            <div className="grid gap-2">
              <Label htmlFor="slack-channel">Slack channel</Label>
              <Input
                id="slack-channel"
                placeholder="#general"
                value={form.slackChannel}
                onChange={(e) => updateField("slackChannel", e.target.value)}
              />
              <Label htmlFor="slack-team">Team ID (optional)</Label>
              <Input
                id="slack-team"
                placeholder="T01234567"
                value={form.slackTeamId}
                onChange={(e) => updateField("slackTeamId", e.target.value)}
              />
            </div>
          )}

          {/* Recipients — Webhook */}
          {form.deliveryChannel === "webhook" && (
            <div className="grid gap-2">
              <Label htmlFor="webhook-url">Webhook URL</Label>
              <Input
                id="webhook-url"
                placeholder="https://api.example.com/webhook"
                value={form.webhookUrl}
                onChange={(e) => updateField("webhookUrl", e.target.value)}
              />
              <div className="flex items-center justify-between">
                <Label>Headers (optional)</Label>
                <Button type="button" variant="ghost" size="sm" onClick={addHeader}>
                  <Plus className="mr-1 size-3" />
                  Add header
                </Button>
              </div>
              {form.webhookHeaders.map((h, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    placeholder="Header name"
                    value={h.key}
                    onChange={(e) => updateHeader(i, "key", e.target.value)}
                    className="flex-1"
                  />
                  <Input
                    placeholder="Value"
                    value={h.value}
                    onChange={(e) => updateHeader(i, "value", e.target.value)}
                    className="flex-1"
                  />
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeHeader(i)}>
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Connection */}
          <div className="grid gap-2">
            <Label>Connection</Label>
            <Select value={form.connectionId} onValueChange={(v) => updateField("connectionId", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default</SelectItem>
                {connections
                  .filter((c) => c.id !== "default")
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.id} ({c.type})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {connectionError && (
              <p className="text-xs text-muted-foreground">{connectionError}</p>
            )}
          </div>

          {/* Approval mode */}
          <div className="grid gap-2">
            <Label>Approval mode</Label>
            <Select
              value={form.approvalMode}
              onValueChange={(v) => updateField("approvalMode", v as ActionApprovalMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="admin-only">Admin only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Enabled (edit only) */}
          {isEdit && (
            <div className="flex items-center gap-3">
              <Switch
                id="task-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => updateField("enabled", checked)}
              />
              <Label htmlFor="task-enabled">Enabled</Label>
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            {isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
