/** Share visibility mode. */
export const SHARE_MODES = ["public", "org"] as const;
export type ShareMode = (typeof SHARE_MODES)[number];

/** Predefined expiry durations for share links (in seconds). */
export const SHARE_EXPIRY_OPTIONS = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
  never: null,
} as const;
export type ShareExpiryKey = keyof typeof SHARE_EXPIRY_OPTIONS;

/** Response shape when generating a shareable link for a conversation. */
export interface ShareLink {
  token: string;
  url: string;
  expiresAt: string | null;
  shareMode: ShareMode;
}
