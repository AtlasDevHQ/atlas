"use client";

import { useEffect, useState } from "react";
import { useAtlasConfig } from "../../context";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Search, Loader2, BookOpen, MessageSquare } from "lucide-react";
import type { PromptCollection, PromptItem } from "../../lib/types";

interface CollectionWithItems extends PromptCollection {
  items: PromptItem[];
}

export function PromptLibrary({
  open,
  onOpenChange,
  onSendPrompt,
  getHeaders,
  getCredentials,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSendPrompt: (text: string) => void;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
}) {
  const { apiUrl } = useAtlasConfig();
  const [collections, setCollections] = useState<CollectionWithItems[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fetched, setFetched] = useState(false);

  // Fetch collections + items when Sheet opens (cached in state)
  useEffect(() => {
    if (!open || fetched) return;
    let cancelled = false;

    async function fetchAll() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiUrl}/api/v1/prompts`, {
          headers: getHeaders(),
          credentials: getCredentials(),
        });
        if (!res.ok) {
          let msg = "Failed to load prompt library";
          try { msg = ((await res.json()) as Record<string, unknown>).message as string ?? msg; } catch { /* intentionally ignored: response may not be JSON */ }
          if (!cancelled) setError(msg);
          return;
        }
        const data = await res.json();
        const cols: PromptCollection[] = data.collections ?? [];

        // Fetch items for each collection in parallel
        const withItems = await Promise.all(
          cols.map(async (col) => {
            try {
              const itemRes = await fetch(`${apiUrl}/api/v1/prompts/${col.id}`, {
                headers: getHeaders(),
                credentials: getCredentials(),
              });
              if (!itemRes.ok) {
                console.debug(`Failed to fetch items for collection ${col.id}: HTTP ${itemRes.status}`);
                return { ...col, items: [] as PromptItem[] };
              }
              const itemData = await itemRes.json();
              return { ...col, items: (itemData.items ?? []) as PromptItem[] };
            } catch (err) {
              console.debug(`Failed to fetch items for collection ${col.id}:`, err instanceof Error ? err.message : String(err));
              return { ...col, items: [] as PromptItem[] };
            }
          }),
        );

        if (!cancelled) {
          setCollections(withItems);
          setFetched(true);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load prompt library");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [open, fetched, apiUrl, getHeaders, getCredentials]);

  function handleSelectPrompt(question: string) {
    onOpenChange(false);
    onSendPrompt(question);
  }

  // Filter collections and items by search
  const filtered = search.trim()
    ? collections
        .map((col) => ({
          ...col,
          items: col.items.filter(
            (item) =>
              item.question.toLowerCase().includes(search.toLowerCase()) ||
              (item.description?.toLowerCase().includes(search.toLowerCase()) ?? false),
          ),
        }))
        .filter((col) => col.items.length > 0 || col.name.toLowerCase().includes(search.toLowerCase()))
    : collections;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <BookOpen className="size-5" />
            Prompt Library
          </SheetTitle>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search prompts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="p-4">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="text-center py-12">
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button variant="link" size="sm" onClick={() => setFetched(false)} className="mt-2">
                  Retry
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-12">
                <BookOpen className="mx-auto size-8 text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {search ? "No prompts match your search" : "No prompt collections available"}
                </p>
              </div>
            ) : (
              <Accordion type="multiple" defaultValue={filtered.map((c) => c.id)}>
                {filtered.map((col) => (
                  <AccordionItem key={col.id} value={col.id}>
                    <AccordionTrigger className="hover:no-underline py-3">
                      <div className="flex items-center gap-2 text-left">
                        <span className="text-sm font-medium">{col.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {col.items.length}
                        </Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-1 pb-2">
                        {col.items.map((item) => (
                          <button
                            key={item.id}
                            onClick={() => handleSelectPrompt(item.question)}
                            className="w-full text-left rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-accent group"
                          >
                            <div className="flex items-start gap-2">
                              <MessageSquare className="size-3.5 mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                              <div className="min-w-0">
                                <p className="text-sm leading-snug">{item.question}</p>
                                {item.description && (
                                  <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                                )}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
