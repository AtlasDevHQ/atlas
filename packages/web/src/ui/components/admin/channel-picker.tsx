"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Hash, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface ChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

interface ChannelPickerProps {
  /** Channels from `GET /admin/proactive/channels/available`. */
  channels: ChannelOption[];
  /**
   * Whether the platform listing succeeded. When false the picker
   * degrades to the raw channel-id input (the pre-picker behavior) so
   * a workspace without a chat-platform install can still configure
   * overrides.
   */
  available: boolean;
  loading?: boolean;
  value: string;
  onChange: (channelId: string) => void;
  inputId?: string;
  placeholder?: string;
  /** Render a "clear" item that resets the value to "". */
  allowClear?: boolean;
  clearLabel?: string;
  className?: string;
}

/**
 * Searchable chat-channel picker for proactive-chat admin surfaces.
 * Platform-agnostic — channel ids are opaque strings (Slack `C…`,
 * Teams `19:…`, etc); the directory endpoint decides what's listed.
 *
 * - Channels Atlas has joined surface first; the rest are grouped under
 *   a "Not in channel" heading (an override there can never fire until
 *   the bot is invited).
 * - Search matches name and id.
 * - Typing an id that isn't in the listing offers a "Use as channel ID"
 *   escape hatch, so the picker is never less capable than the old
 *   free-form input (archived channels, >1000-channel workspaces).
 */
export function ChannelPicker({
  channels,
  available,
  loading,
  value,
  onChange,
  inputId,
  placeholder = "Channel ID",
  allowClear,
  clearLabel = "No channel",
  className,
}: ChannelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  if (!available && !loading) {
    return (
      <Input
        id={inputId}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn("font-mono text-sm", className)}
      />
    );
  }

  const selected = channels.find((ch) => ch.id === value) ?? null;
  const memberChannels = channels.filter((ch) => ch.isMember);
  const otherChannels = channels.filter((ch) => !ch.isMember);

  const trimmedSearch = search.trim();
  // Manual-id escape hatch: offered whenever the typed text isn't an
  // exact id/name match, so an admin can paste an id the listing
  // doesn't cover.
  const exactMatch = channels.some(
    (ch) => ch.id === trimmedSearch || ch.name === trimmedSearch,
  );
  const showManualItem = trimmedSearch.length > 0 && !exactMatch;

  const buttonLabel = selected ? (
    <span className="flex items-center gap-1 truncate">
      {selected.isPrivate ? (
        <Lock className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <Hash className="size-3 shrink-0 text-muted-foreground" />
      )}
      {selected.name}
    </span>
  ) : value ? (
    <span className="truncate font-mono">{value}</span>
  ) : (
    <span className="truncate text-muted-foreground">
      {loading ? "Loading channels…" : "Pick a channel"}
    </span>
  );

  const pick = (channelId: string) => {
    onChange(channelId);
    setSearch("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={inputId}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={loading}
          className={cn("w-full justify-between text-sm font-normal", className)}
        >
          {buttonLabel}
          {loading ? (
            <Loader2 className="ml-2 size-3.5 shrink-0 animate-spin opacity-60" />
          ) : (
            <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[280px] p-0" align="start">
        <Command
          filter={(itemValue, searchTerm) =>
            itemValue.toLowerCase().includes(searchTerm.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput
            placeholder="Search channels…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No channels match.</CommandEmpty>
            {allowClear && value && (
              <CommandGroup>
                <CommandItem value="__clear__" onSelect={() => pick("")}>
                  <span className="text-sm text-muted-foreground">{clearLabel}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {memberChannels.length > 0 && (
              <CommandGroup heading="Channels Atlas is in">
                {memberChannels.map((ch) => (
                  <ChannelItem
                    key={ch.id}
                    channel={ch}
                    selected={ch.id === value}
                    onSelect={() => pick(ch.id)}
                  />
                ))}
              </CommandGroup>
            )}
            {otherChannels.length > 0 && (
              <CommandGroup heading="Not in channel — invite Atlas first">
                {otherChannels.map((ch) => (
                  <ChannelItem
                    key={ch.id}
                    channel={ch}
                    selected={ch.id === value}
                    onSelect={() => pick(ch.id)}
                  />
                ))}
              </CommandGroup>
            )}
            {showManualItem && (
              <CommandGroup heading="Manual">
                {/* cmdk filters on `value`; embed the search text so the
                    item always survives its own filter. */}
                <CommandItem value={`__manual__ ${trimmedSearch}`} onSelect={() => pick(trimmedSearch)}>
                  <span className="text-sm">
                    Use{" "}
                    <span className="font-mono text-[12px]">{trimmedSearch}</span>{" "}
                    as channel ID
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ChannelItem({
  channel,
  selected,
  onSelect,
}: {
  channel: ChannelOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={`${channel.name} ${channel.id}`} onSelect={onSelect}>
      <div className="flex w-full items-center gap-2">
        <Check className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
        {channel.isPrivate ? (
          <Lock className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Hash className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{channel.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {channel.id}
        </span>
      </div>
    </CommandItem>
  );
}
