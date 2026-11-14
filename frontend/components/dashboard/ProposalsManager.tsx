"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button, buttonClass, focusRing as focus } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { EmptyState, Notice, Pill, Skeleton, type Tone } from "@/components/ui/Surface";
import { AiNotes, ChangeDiff } from "./ai/AiShared";
import ManagementPageHeader from "./ManagementPageHeader";

type Status = "pending" | "approved" | "rejected" | "applied" | "failed";

interface ListItem {
  id: string;
  source: "manual" | "planner" | "ai";
  /** "pages" (draft pages), "storefront" (the draft store homepage) or "website" (a whole website, all drafts). */
  target?: "pages" | "storefront" | "website";
  summary: string;
  status: Status;
  failureCode: string | null;
  actionsCount: number;
  pagesTouched: number;
  createdAt: string;
}

interface Change {
  actionId: string;
  kind: string;
  pageId: string;
  sectionId?: string;
  slug?: string;
  title?: string;
  fromIndex?: number;
  toIndex?: number;
}

interface StorefrontChangeRow {
  label: string;
  before: string;
  after: string;
  live: boolean;
}

interface Detail extends ListItem {
  stale: boolean;
  /** Whole-website proposals: what changed since, in the owner's words. */
  staleItems?: string[];
  notes?: string[];
  /** Page proposals: actions; homepage proposals: before/after rows (+ whether any are store-wide). */
  diff: { changes: Change[]; summary: Record<string, number> } | { changes: StorefrontChangeRow[]; live: boolean };
  preview: { pages: Array<{ id: string; title: string; slug: string; sections: Array<{ id: string; type: string }> }>; classicHomepage?: unknown };
  appliedPages: Array<{ id: string; title: string; slug: string; created: boolean }>;
  expiresAt: string;
  history: Array<{ at: string; action: string; note: string | null }>;
}

const STATUS: Record<Status, { label: string; tone: Tone }> = {
  pending: { label: "Awaiting review", tone: "warning" },
  approved: { label: "Approved · ready to apply", tone: "info" },
  rejected: { label: "Rejected", tone: "neutral" },
  applied: { label: "Applied to drafts", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const FAILURE: Record<string, string> = {
  version_conflict: "A page changed after this proposal was prepared. Create a new proposal from the current pages.",
  page_slug_conflict: "A proposed page address is already used by another page.",
  expired: "The proposal expired before it was applied (proposals are valid for 14 days).",
  page_not_found: "A page in this proposal no longer exists.",
  page_not_replaceable: "A page in this proposal was published; proposals only change drafts.",
  section_not_found: "A section in this proposal no longer exists.",
  validation_error: "The proposal no longer passes validation.",
  invalid_media_reference: "An image in this proposal is not available to this business.",
  conflict: "Another change happened at the same time. Create a new proposal.",
  invalid_featured_product: "A product this proposal relies on is no longer available.",
};

const CHANGE_LABEL: Record<string, string> = {
  "create-page": "Create draft page",
  "update-section": "Update section",
  "add-section": "Add section",
  "remove-section": "Remove section",
  "reorder-sections": "Move section",
};

const SOURCE: Record<string, string> = { manual: "Manual", planner: "Website planner", ai: "AI suggestion" };

function Badge({ status }: { status: Status }) {
  return <Pill tone={STATUS[status].tone} dot>{STATUS[status].label}</Pill>;
}

/**
 * Review screen for website change proposals (AI builder M1, no external AI).
 * The server enforces every rule (roles, validation, staleness, one apply);
 * this component only shows state and asks for explicit confirmations.
 */
export default function ProposalsManager({
  businessId,
  initialProposalId = null,
  aiAvailable = false,
}: {
  businessId: string;
  initialProposalId?: string | null;
  /** Whether an AI provider is enabled and configured (server-decided). */
  aiAvailable?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialProposalId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(`/api/businesses/${businessId}/proposals`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Unable to load proposals.");
      setItems(data.proposals);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Unable to load proposals.");
    }
  }, [businessId]);

  const loadDetail = useCallback(async (id: string) => {
    setDetail(null);
    setDetailError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/proposals/${id}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Unable to load the proposal.");
      setDetail(data.proposal);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Unable to load the proposal.");
    }
  }, [businessId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  function select(id: string) {
    setMessage(null);
    setSelectedId(id);
    router.replace(`${pathname}?proposal=${id}`);
  }

  async function act(path: "review" | "apply", body: unknown, success: string) {
    if (!detail || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/proposals/${detail.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: FAILURE[data.code] ?? data.error ?? "The proposal was not changed." });
      } else {
        setMessage({ ok: true, text: success });
      }
    } catch {
      setMessage({ ok: false, text: "Network error. Reload to see the current state before retrying." });
    } finally {
      setBusy(false);
      await Promise.all([loadList(), loadDetail(detail.id)]);
    }
  }

  /** Brings a stale whole-website proposal up to date. Free, and newer edits always stay. */
  async function refresh() {
    if (!detail || busy) return;
    setBusy(true);
    setMessage(null);
    let next = detail.id;
    try {
      const res = await fetch(`/api/businesses/${businessId}/proposals/${detail.id}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMessage({ ok: false, text: data.error ?? "This proposal could not be refreshed." });
      else if (data.proposal) {
        next = data.proposal.id;
        setMessage({ ok: true, text: "Refreshed. Your newer edits are kept: review it again before applying." });
      } else if (data.unchanged) setMessage({ ok: true, text: "Your drafts already hold everything in this proposal." });
      else setMessage({ ok: false, text: `Both this proposal and your newer edits changed ${(data.conflicts ?? []).join(", ")}. Your edits are kept and nothing was changed. Ask the AI Builder again to build on them.` });
    } catch {
      setMessage({ ok: false, text: "Network error. Nothing was changed." });
    } finally {
      setBusy(false);
      await loadList();
      if (next !== detail.id) select(next);
      else await loadDetail(detail.id);
    }
  }

  const pagesBase = `/dashboard/businesses/${businessId}`;
  const isWebsite = detail?.target === "website";
  const isStorefront = detail?.target === "storefront";
  const storefrontDiff = isStorefront || isWebsite ? (detail!.diff as { changes: StorefrontChangeRow[]; live: boolean }) : null;
  const waiting = (items ?? []).filter((item) => item.status === "pending" || item.status === "approved");
  const reviewed = (items ?? []).filter((item) => item.status !== "pending" && item.status !== "approved");

  /** Explicit confirmation, then apply: it reaches drafts only and never publishes. */
  async function confirmAndApply() {
    if (!detail) return;
    const count = detail.diff.changes.length;
    const changes = `${count} change${count === 1 ? "" : "s"}`;
    const ok = await confirmDialog({
      title: isWebsite ? "Apply this whole website to your drafts?" : isStorefront ? "Apply this proposal to your draft homepage?" : "Apply this proposal to draft pages?",
      message: isWebsite
        ? `${changes} will be saved to your drafts, all together. Your live store does not change until you publish.`
        : isStorefront
        ? `${changes} will be saved to your draft homepage. Your live store does not change until you publish from the website editor.${storefrontDiff?.live ? " Colour and font changes go to your design draft and reach your whole store when you publish them." : ""}`
        : `${changes} will be saved to draft pages. Your live website does not change until you publish from Pages.`,
      confirmLabel: "Apply to drafts",
    });
    if (ok) await act("apply", {}, isWebsite ? "Applied to your drafts. Nothing was published." : isStorefront ? "Applied to your draft homepage. Nothing was published." : "Applied to draft pages. Nothing was published.");
  }

  const row = (item: ListItem) => (
    <li key={item.id}>
      <button
        type="button"
        onClick={() => select(item.id)}
        aria-current={selectedId === item.id ? "true" : undefined}
        className={`relative block w-full px-4 py-3 text-left transition-colors hover:bg-slate-50 sm:px-5 ${focus} focus-visible:ring-inset focus-visible:ring-offset-0 ${selectedId === item.id ? "bg-slate-50" : ""}`}
      >
        {selectedId === item.id && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-ember" />}
        <span className="block min-w-0 text-sm font-medium leading-5 text-slate-900">{item.summary}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
          <Badge status={item.status} />
          <span>{SOURCE[item.source] ?? item.source}</span>
          <span>{item.target === "website" ? "Whole website" : item.target === "storefront" ? "Store homepage" : `${item.actionsCount} change${item.actionsCount === 1 ? "" : "s"}`}</span>
          <span>{new Date(item.createdAt).toLocaleString()}</span>
        </span>
      </button>
    </li>
  );

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Change proposals"
        description={`Review website changes before they touch your store. Approved proposals are applied to DRAFTS only (pages or the store homepage); publishing stays a separate step. ${aiAvailable ? "AI suggestions are enabled: every AI suggestion appears here for review." : "No AI provider is enabled on this platform."}`}
      />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] [&>*]:min-w-0">
        <section aria-labelledby="proposal-list" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <h2 id="proposal-list" className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900 sm:px-5">Proposals</h2>
          {listError ? (
            <p role="alert" className="px-5 py-6 text-sm text-red-700">{listError}</p>
          ) : items === null ? (
            <div className="space-y-2 p-4" aria-label="Loading proposals">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon={<Icon name="proposals" />} title="No proposals yet" className="m-4">
              Create one from the <Link className={`rounded font-medium text-slate-900 underline underline-offset-2 ${focus}`} href={`${pagesBase}/ai-builder/planner`}>website planner</Link> with
              {" "}“Save as proposal for review”.
            </EmptyState>
          ) : (
            <>
              {waiting.length > 0 && (
                <div>
                  <p className="bg-slate-50 px-4 py-1.5 text-xs font-medium text-slate-500 sm:px-5">Needs your review ({waiting.length})</p>
                  <ul className="divide-y divide-slate-100">{waiting.map(row)}</ul>
                </div>
              )}
              {reviewed.length > 0 && (
                <div>
                  <p className="bg-slate-50 px-4 py-1.5 text-xs font-medium text-slate-500 sm:px-5">Reviewed ({reviewed.length})</p>
                  <ul className="divide-y divide-slate-100">{reviewed.map(row)}</ul>
                </div>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="proposal-detail" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 id="proposal-detail" className="sr-only">Proposal details</h2>
          {!selectedId ? (
            <div className="ui-dots-ink rounded-xl border border-dashed border-slate-300 px-5 py-12 text-center">
              <p className="text-sm text-slate-600">Select a proposal to review it.</p>
            </div>
          ) : detailError ? (
            <Notice tone="danger" role="alert">{detailError}</Notice>
          ) : !detail ? (
            <div className="space-y-3" aria-label="Loading proposal">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="text-lg font-semibold leading-6 text-slate-900">{detail.summary}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {SOURCE[detail.source] ?? detail.source} · valid until {new Date(detail.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <Badge status={detail.status} />
              </div>

              {detail.status === "failed" && detail.failureCode && (
                <Notice tone="danger" role="alert">{FAILURE[detail.failureCode] ?? "This proposal could not be applied."}</Notice>
              )}
              {detail.stale && (
                <Notice tone="warning" role="alert" action={isWebsite ? <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>Refresh this proposal</Button> : undefined}>
                  {isWebsite
                    ? `${(detail.staleItems?.length ?? 0) > 0 ? `Changed since it was prepared: ${detail.staleItems?.join(", ")}. ` : ""}Your newer edits are safe, and this proposal cannot overwrite them. Refreshing keeps your edits and adds what does not overlap, for free.`
                    : isStorefront
                    ? "Your homepage changed after this suggestion was prepared, so it can no longer be approved or applied. Ask for a new suggestion in the website editor."
                    : "A page changed after this proposal was prepared, so it can no longer be approved or applied. Create a new proposal."}
                </Notice>
              )}
              {isWebsite && Boolean(detail.preview.classicHomepage) && (
                <div role="note">
                  <Notice tone="info" title="Your custom homepage stays live">
                    Approving keeps your older custom homepage as it is and saves the new one to your draft. Visitors see the new one only when you publish it from the website editor.
                  </Notice>
                </div>
              )}
              {isStorefront && storefrontDiff?.live && (
                <div role="note">
                  <Notice tone="warning">
                    Includes colour or font changes: these go to your design draft, and reach your whole store when you publish them.
                  </Notice>
                </div>
              )}
              <div aria-live="polite">
                {message && <Notice tone={message.ok ? "success" : "danger"}>{message.text}</Notice>}
              </div>

              {(isStorefront || isWebsite) && storefrontDiff ? (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">{isWebsite ? "Changes to your website" : "Changes to your homepage"}</h3>
                  <ChangeDiff rows={storefrontDiff.changes} caption="Before and after" afterLabel="Proposed" />
                  {(detail.notes?.length ?? 0) > 0 && (
                    <div className="mt-2">
                      <AiNotes notes={detail.notes!} title="Worth checking:" />
                    </div>
                  )}
                </div>
              ) : (
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Changes</h3>
                <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
                  {(detail.diff.changes as Change[]).map((change) => {
                    const page = detail.preview.pages.find((p) => p.id === change.pageId);
                    return (
                      <li key={change.actionId} className="flex flex-wrap justify-between gap-2 px-3 py-2.5">
                        <span className="min-w-0 break-words">
                          <span className="font-medium text-slate-900">{CHANGE_LABEL[change.kind] ?? change.kind}</span>{" "}
                          <span className="text-slate-600">
                            {change.kind === "create-page" ? `“${change.title}” at /${change.slug}` : `${change.sectionId ?? ""} on ${page ? `“${page.title}”` : "a page"}`}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              )}

              <div>
                <h3 className="text-sm font-semibold text-slate-900">Preview</h3>
                <p className="mt-1 text-xs text-slate-500">Opens {isStorefront || isWebsite ? "your homepage" : "the page"} as it would look with this proposal. Nothing is saved.</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {(isStorefront || isWebsite) && (
                    <li>
                      <a
                        href={`${pagesBase}/preview?proposal=${detail.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonClass({ variant: "secondary" })}
                      >
                        Preview homepage <Icon name="external" size={14} />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </li>
                  )}
                  {!isStorefront && (detail.preview.pages ?? []).filter((page) => !isWebsite || (page as { proposed?: boolean }).proposed).map((page) => (
                    <li key={page.id}>
                      <a
                        href={`${pagesBase}/preview?proposal=${detail.id}&page=${encodeURIComponent(page.id)}`}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonClass({ variant: "secondary" })}
                      >
                        Preview “{page.title}” <Icon name="external" size={14} />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>

              {(detail.status === "pending" || detail.status === "approved") && (
                <div className="space-y-2 rounded-xl bg-slate-50 p-3">
                  <div className="flex flex-wrap gap-2">
                    {detail.status === "pending" && (
                      <>
                        <Button
                          disabled={busy || detail.stale}
                          onClick={() => void act("review", { decision: "approve" }, "Approved. Apply it when you are ready.")}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="secondary"
                          className="!border-red-200 !text-red-700 hover:!border-red-300 hover:!bg-red-50"
                          disabled={busy}
                          onClick={() => void act("review", { decision: "reject" }, "Rejected. Nothing was changed.")}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    {detail.status === "approved" && (
                      <Button disabled={busy || detail.stale} onClick={() => void confirmAndApply()}>
                        {busy ? "Applying…" : isWebsite ? "Apply to drafts" : isStorefront ? "Apply to draft homepage" : "Apply to draft pages"}
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    {detail.status === "pending" ? "Approving changes nothing yet: you apply it as a separate step." : "Applying saves to drafts only. Publishing stays a separate step."}
                  </p>
                </div>
              )}

              {detail.status === "applied" && isStorefront && (
                <Notice tone="success" role="status" title="Applied to your draft homepage. Nothing has been published.">
                  Review it in the <Link className={`rounded font-medium underline underline-offset-2 ${focus}`} href={`${pagesBase}/editor`}>website editor</Link> and publish it there when you are ready.
                </Notice>
              )}
              {detail.status === "applied" && !isStorefront && (
                <Notice tone="success" role="status" title={isWebsite ? "Applied to your drafts. Nothing has been published." : "Applied to draft pages. Nothing has been published."}>
                  <ul className="mt-1 list-disc pl-5">
                    {detail.appliedPages.map((page) => (
                      <li key={page.id}>{page.created ? "Created" : "Updated"} draft “{page.title}” (/{page.slug})</li>
                    ))}
                  </ul>
                  <p className="mt-2">
                    Publishing is a separate step: review the drafts on{" "}
                    <Link className={`rounded font-medium underline underline-offset-2 ${focus}`} href={`${pagesBase}/pages`}>Pages</Link> and publish them there when you are ready.
                  </p>
                </Notice>
              )}

              <div>
                <h3 className="text-sm font-semibold text-slate-900">History</h3>
                <ol className="mt-2 space-y-1 border-l border-slate-200 pl-3 text-xs text-slate-600">
                  {detail.history.map((h, index) => (
                    <li key={index}>
                      {new Date(h.at).toLocaleString()} · {h.action.replace("_", " ")}
                      {h.note && h.action !== "created" ? ` (${FAILURE[h.note] ? h.note.replace("_", " ") : h.note})` : ""}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
