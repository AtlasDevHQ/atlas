/** Prompt library types — wire format for prompt_collections and prompt_items tables. */

/** All valid prompt industries for built-in collections. */
export const PROMPT_INDUSTRIES = ["saas", "ecommerce", "cybersecurity"] as const;
export type PromptIndustry = (typeof PROMPT_INDUSTRIES)[number];

/** Wire format for the prompt_collections table. */
export interface PromptCollection {
  id: string;
  orgId: string | null;
  name: string;
  industry: string;
  description: string;
  isBuiltin: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Wire format for the prompt_items table. */
export interface PromptItem {
  id: string;
  collectionId: string;
  question: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
