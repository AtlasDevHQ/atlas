"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { RegionPickerItem } from "@/ui/lib/types";
import { Check, MapPin } from "lucide-react";

// ── Compliance Badge (placeholder) ────────────────────────────
// Same security controls apply to all regions. When specific
// compliance certifications are obtained (SOC 2, GDPR, etc.),
// add region-specific badges here.

export function ComplianceBadge({
  regionId: _regionId,
  className: _className,
}: {
  regionId: string;
  className?: string;
}) {
  return null;
}

// ── Region Card Grid ───────────────────────────────────────────

export function RegionCardGrid({
  regions,
  selected,
  onSelect,
  disabled,
}: {
  regions: RegionPickerItem[];
  selected: string;
  onSelect: (regionId: string) => void;
  disabled?: boolean;
}) {
  if (regions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No regions are available. Contact support for assistance.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {regions.map((region) => (
        <Card
          key={region.id}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-pressed={selected === region.id}
          className={cn(
            "relative cursor-pointer transition-all hover:shadow-md",
            selected === region.id
              ? "ring-2 ring-primary border-primary"
              : "hover:border-muted-foreground/30",
            disabled && "pointer-events-none opacity-50",
          )}
          onClick={() => {
            if (!disabled) onSelect(region.id);
          }}
          onKeyDown={(e) => {
            if (!disabled && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              onSelect(region.id);
            }
          }}
        >
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <MapPin className="h-8 w-8 text-muted-foreground" />
            <div className="space-y-1">
              <p className="font-medium">{region.label}</p>
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {region.isDefault && (
                  <Badge variant="outline" className="text-xs">
                    Default
                  </Badge>
                )}
                <ComplianceBadge regionId={region.id} />
              </div>
            </div>
            {selected === region.id && (
              <Badge variant="default" className="absolute right-3 top-3">
                <Check className="h-3 w-3" />
              </Badge>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
