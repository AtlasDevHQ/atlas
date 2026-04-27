"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Loader2 } from "lucide-react";
import { SignupShell } from "@/ui/components/signup/signup-shell";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

const WorkspaceSchema = z.object({
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

type WorkspaceForm = z.infer<typeof WorkspaceSchema>;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48);
}

export default function WorkspacePage() {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [slugManual, setSlugManual] = useState(false);

  const form = useForm<WorkspaceForm>({
    resolver: zodResolver(WorkspaceSchema),
    defaultValues: { name: "", slug: "" },
    mode: "onBlur",
  });

  function handleNameChange(value: string) {
    form.setValue("name", value, { shouldValidate: false });
    if (!slugManual) {
      form.setValue("slug", slugify(value), { shouldValidate: false });
    }
  }

  async function onSubmit(values: WorkspaceForm) {
    setSubmitError(null);

    try {
      const result = await authClient.organization.create({
        name: values.name.trim(),
        slug: values.slug,
      });

      if (result.error) {
        setSubmitError(result.error.message ?? "Failed to create workspace");
        return;
      }

      if (result.data?.id) {
        try {
          await authClient.organization.setActive({
            organizationId: result.data.id,
          });
        } catch (err) {
          console.error("Failed to activate workspace:", err);
          setSubmitError(
            "Workspace created, but we couldn't activate it. Please reload and try again.",
          );
          return;
        }
      }

      router.push("/signup/region");
    } catch (err) {
      setSubmitError(
        err instanceof TypeError
          ? "Unable to reach the server. Check your connection and try again."
          : err instanceof Error
            ? err.message
            : "Failed to create workspace",
      );
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <SignupShell step="workspace">
      <Card>
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl tracking-tight">Name your workspace</CardTitle>
          <CardDescription>
            A workspace is where your team queries data together. You can rename it later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                          handleNameChange(e.target.value);
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
                    <FormLabel>URL slug</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="acme-corp"
                        className="font-mono text-sm"
                        disabled={submitting}
                        {...field}
                        onChange={(e) => {
                          field.onChange(e);
                          setSlugManual(true);
                        }}
                      />
                    </FormControl>
                    <FormDescription>
                      Lowercase letters, numbers, and hyphens. Used in URLs and API tokens.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {submitError && (
                <p role="alert" className="text-sm text-destructive">
                  {submitError}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={submitting || !form.watch("name").trim()}
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Creating workspace...
                  </>
                ) : (
                  "Continue"
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </SignupShell>
  );
}
