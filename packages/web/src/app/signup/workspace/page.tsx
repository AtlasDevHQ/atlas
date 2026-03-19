"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Building2 } from "lucide-react";

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
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugManual) {
      setSlug(slugify(value));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const result = await authClient.organization.create({
        name: name.trim(),
        slug: slug || slugify(name),
      });

      if (result.error) {
        setError(result.error.message ?? "Failed to create workspace");
        return;
      }

      // Set the new org as active — required for the next step
      if (result.data?.id) {
        try {
          await authClient.organization.setActive({
            organizationId: result.data.id,
          });
        } catch (err) {
          console.error("Failed to activate workspace:", err);
          setError(
            "Workspace created, but we couldn't activate it. Please reload and try again.",
          );
          return;
        }
      }

      router.push("/signup/connect");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create workspace",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Building2 className="size-6 text-primary" />
        </div>
        <CardTitle className="text-2xl">Name your workspace</CardTitle>
        <CardDescription>
          A workspace is where your team queries data together.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ws-name">Workspace name</Label>
            <Input
              id="ws-name"
              placeholder="Acme Corp"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-slug">URL slug</Label>
            <Input
              id="ws-slug"
              placeholder="acme-corp"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugManual(true);
              }}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers, and hyphens only.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            className="w-full"
            disabled={loading || !name.trim()}
          >
            {loading ? "Creating..." : "Continue"}
          </Button>
        </form>

        <div className="mt-4 flex justify-center">
          <StepIndicator current={2} total={4} />
        </div>
      </CardContent>
    </Card>
  );
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i < current
              ? "w-6 bg-primary"
              : "w-1.5 bg-muted-foreground/30"
          }`}
        />
      ))}
    </div>
  );
}
