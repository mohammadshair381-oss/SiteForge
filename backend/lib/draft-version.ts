import { HttpError } from "@/lib/api";

/**
 * Stops an old editor tab overwriting newer edits to a draft (pages use `Page.version`). A save
 * may send the version it started from in `x-expected-version`. Without one it is not checked,
 * so the other screens and AI proposals that save these drafts carry on working.
 */
export function expectedDraftVersion(request: Request): number | undefined {
  const raw = request.headers.get("x-expected-version");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Part of a filter: this draft is still at the expected version. A store with none yet counts as 0. */
export function draftVersionFilter(field: string, expected: number | undefined): Record<string, unknown> {
  if (expected === undefined) return {};
  return { [field]: expected === 0 ? { $in: [0, null] } : expected };
}

export const draftConflict = () => new HttpError(409, "This draft was changed in another window or by someone else. Reload to get the latest version.", "draft_conflict");
