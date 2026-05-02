"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Building2,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import {
  parseCreateOrgError,
  type CreateOrgErrorState,
} from "./parse-create-org-error";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

const CreateOrgSchema = z.object({
  name: z
    .string()
    .min(1, "Give your workspace a name")
    .max(64, "Name is too long"),
  slug: z
    .string()
    .min(2, "Slugs must be at least 2 characters")
    .max(48, "Slugs must be 48 characters or fewer")
    .regex(SLUG_PATTERN, "Lowercase letters, numbers, and hyphens only"),
});

type CreateOrgForm = z.infer<typeof CreateOrgSchema>;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48);
}

export default function CreateOrgPage() {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<CreateOrgErrorState | null>(null);
  const [slugManual, setSlugManual] = useState(false);
  // Host comes from `window.location.host` so self-hosted instances render
  // the operator's real hostname instead of "app.useatlas.dev". SSR renders
  // a neutral placeholder; the real host swaps in on hydration.
  const [host, setHost] = useState<string>("yourdomain");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setHost(window.location.host);
    }
  }, []);

  const form = useForm<CreateOrgForm>({
    resolver: zodResolver(CreateOrgSchema),
    defaultValues: { name: "", slug: "" },
    mode: "onBlur",
  });

  const slugValue = form.watch("slug");

  function syncSlugFromName(value: string) {
    if (!slugManual) {
      form.setValue("slug", slugify(value), { shouldValidate: false });
    }
  }

  async function onSubmit(values: CreateOrgForm) {
    setSubmitError(null);

    try {
      const result = await authClient.organization.create({
        name: values.name.trim(),
        slug: values.slug,
      });

      if (result.error) {
        setSubmitError(parseCreateOrgError({ error: result.error }));
        return;
      }

      if (result.data?.id) {
        try {
          await authClient.organization.setActive({
            organizationId: result.data.id,
          });
        } catch (err) {
          console.warn(
            "Workspace activated failed:",
            err instanceof Error ? err.message : String(err),
          );
          setSubmitError(parseCreateOrgError({ partialActivation: true }));
          return;
        }
      }

      router.push("/");
    } catch (err) {
      console.debug(
        "Workspace create failed:",
        err instanceof Error ? err.message : String(err),
      );
      setSubmitError(parseCreateOrgError({ thrown: err }));
    }
  }

  const submitting = form.formState.isSubmitting;
  const nameValue = form.watch("name");
  const canSubmit = !submitting && nameValue.trim().length > 0;

  return (
    <div className="flex flex-col items-center">
      <div className="mb-3 self-start">
        <Link
          href="/"
          className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-3" aria-hidden />
          Cancel and return to chat
        </Link>
      </div>

      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Building2 className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Create a new workspace
        </h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Workspaces keep data, dashboards, and conversations separate. You can
          switch between them anytime.
        </p>
      </div>

      <Card className="w-full">
        <CardContent className="pt-6">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
              noValidate
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Workspace name</FormLabel>
                    <FormControl>
                      <Input
                        autoFocus
                        placeholder="Acme Corp"
                        disabled={submitting}
                        {...field}
                        onChange={(e) => {
                          field.onChange(e);
                          syncSlugFromName(e.target.value);
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Workspace URL</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="acme-corp"
                        autoComplete="off"
                        className="font-mono text-sm"
                        disabled={submitting}
                        {...field}
                        onChange={(e) => {
                          field.onChange(e);
                          setSlugManual(true);
                        }}
                      />
                    </FormControl>
                    <FormDescription className="flex items-center gap-1.5 text-xs">
                      <span className="truncate font-mono text-muted-foreground">
                        {host}/<span className="text-foreground">{slugValue || "your-slug"}</span>
                      </span>
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {submitError && <CreateOrgErrorAlert error={submitError} />}

              <Button
                type="submit"
                className="w-full"
                disabled={!canSubmit}
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                    Creating workspace…
                  </>
                ) : (
                  <>
                    Create workspace
                    <ArrowRight className="ml-1 size-4" aria-hidden />
                  </>
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        You&apos;ll become the owner of this workspace. Invite teammates after
        it&apos;s created.
      </p>
    </div>
  );
}

function CreateOrgErrorAlert({ error }: { error: CreateOrgErrorState }) {
  const isPartial = error.kind === "partial_activation";
  const isBilling = error.kind === "billing_required";
  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        "flex items-start gap-3 rounded-md border p-3 text-sm",
        isPartial
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          : "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
      )}
    >
      {isPartial ? (
        <RefreshCcw className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <div className="flex-1 space-y-1">
        <p className="font-medium leading-tight">{error.title}</p>
        <p
          className={cn(
            "text-xs leading-relaxed",
            isPartial
              ? "text-amber-800/90 dark:text-amber-200/90"
              : "text-red-800/90 dark:text-red-200/90",
          )}
        >
          {error.body}
        </p>
        {isBilling && (
          <Link
            href="/admin/billing"
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Open billing settings
            <ArrowRight className="size-3" aria-hidden />
          </Link>
        )}
      </div>
    </div>
  );
}
