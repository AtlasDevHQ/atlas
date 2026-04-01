"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckCircle2, MessageSquare, Settings, Users } from "lucide-react";

export default function SuccessPage() {
  const router = useRouter();

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-green-100 dark:bg-green-950">
          <CheckCircle2 className="size-6 text-green-600 dark:text-green-400" />
        </div>
        <CardTitle className="text-2xl">You&apos;re all set!</CardTitle>
        <CardDescription>
          Your workspace is ready. Start asking your data questions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <NextStep
            icon={<MessageSquare className="size-4" />}
            title="Ask your first question"
            description={'Try something like "What are our top 10 customers by revenue?"'}
          />
          <NextStep
            icon={<Settings className="size-4" />}
            title="Configure your semantic layer"
            description="Add descriptions, joins, and measures to improve query accuracy."
          />
          <NextStep
            icon={<Users className="size-4" />}
            title="Invite your team"
            description="Go to Admin > Organizations to add team members."
          />
        </div>

        <Button className="w-full" onClick={() => router.push("/")}>
          Start chatting
        </Button>

        <div className="flex justify-center">
          <StepIndicator current={5} total={5} />
        </div>
      </CardContent>
    </Card>
  );
}

function NextStep({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-3 rounded-md border bg-muted/40 p-3">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i < current ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/30"
          }`}
        />
      ))}
    </div>
  );
}
