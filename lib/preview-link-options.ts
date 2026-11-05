/** How long a draft preview link can last (pure; shared with the dashboard). */
export const PREVIEW_LINK_DURATIONS = {
  "1h": { label: "1 hour", ms: 60 * 60 * 1000 },
  "24h": { label: "1 day", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
} as const;

export type PreviewLinkDuration = keyof typeof PREVIEW_LINK_DURATIONS;
export const PREVIEW_LINK_DURATION_KEYS = Object.keys(PREVIEW_LINK_DURATIONS) as [PreviewLinkDuration, ...PreviewLinkDuration[]];

/** Where a preview link lives on the platform address. Store addresses never serve it. */
/** The token follows `#`, which browsers never send to a server, so no log or proxy sees it. */
export const previewLinkPath = (token: string) => `/preview#${token}`;

/** Holds the token while someone looks at a preview; only `/preview` pages receive it. */
export const PREVIEW_COOKIE = "sf_preview";
export const PREVIEW_COOKIE_MAX_AGE = 60 * 60;

/** The token in an address from before it moved after `#` (`/preview/<token>`). */
export function legacyPreviewTokenOf(pathname: string): string | null {
  return /^\/preview\/([A-Za-z0-9_-]{43})$/.exec(pathname)?.[1] ?? null;
}

export interface PreviewLinkSummary {
  id: string;
  scope: "site" | "page";
  pageId: string | null;
  pageTitle: string | null;
  createdAt: string;
  expiresAt: string;
}
