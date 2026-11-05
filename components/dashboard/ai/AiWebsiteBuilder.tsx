"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, focusRing as focus } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Notice, Pill, Skeleton } from "@/components/ui/Surface";
import type { ConversationView } from "@/lib/ai-website/conversation";
import { CLAIMS_CONFIRMED_PREFIX } from "@/lib/ai-website/blueprint";
import AiProposalReview, { type AiPreviewData, type AiProposalDetail } from "./AiProposalReview";
import { AiNotes } from "./AiShared";

interface StateResponse {
  conversation: ConversationView | null;
  expired?: boolean;
  unitsLeft?: number | null;
}

/** One website takes a known number of steps. This only stops a loop that has gone wrong. */
const MAX_STEPS = 40;

/**
 * The whole-website part of the AI Builder: the owner talks about their business, generates one complete
 * website, reviews it in the real renderer, and asks for changes. It never saves on its own: every result
 * is a proposal, and the server decides what each step does and what it costs. The conversation lives on
 * the server, so leaving this page loses nothing and generating carries on from the last finished step.
 */
export default function AiWebsiteBuilder({
  businessId,
  ready,
  blockedReason,
  previewData,
  onUsageChanged,
}: {
  businessId: string;
  /** AI can be used for this store right now (server-decided). */
  ready: boolean;
  /** Why not, in plain words. */
  blockedReason: string | null;
  previewData: AiPreviewData | null;
  onUsageChanged: () => void;
}) {
  const router = useRouter();
  const inputId = useId();
  const [state, setState] = useState<StateResponse | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"send" | "generate" | "fresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiProposalDetail | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const stopRequested = useRef(false);
  const base = `/api/businesses/${businessId}/ai/website`;
  const conversation = state?.conversation ?? null;
  const phase = conversation?.phase ?? "discovery";

  const openProposal = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/businesses/${businessId}/proposals/${id}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDetail(data.proposal as AiProposalDetail);
    },
    [businessId],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Your conversation could not be loaded.");
      setState(data as StateResponse);
      const proposalId = (data as StateResponse).conversation?.proposalId;
      if (proposalId) await openProposal(proposalId);
      else setDetail(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your conversation could not be loaded.");
      setState((current) => current ?? { conversation: null });
    }
  }, [base, openProposal]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(message: string, target?: "revise") {
    const words = message.trim();
    if (!words || busy) return;
    setBusy("send");
    setError(null);
    setLastMessage(words);
    const revising = target === "revise" || phase === "proposal" || phase === "applied";
    try {
      const res = await fetch(revising ? `${base}/revise` : base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: words }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The assistant could not answer. Your message is saved, so you can try again.");
      setState((current) => ({ ...current, conversation: data.conversation, unitsLeft: data.unitsLeft ?? current?.unitsLeft ?? null }));
      setText("");
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      if (data.proposal) setDetail(data.proposal as AiProposalDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Your message may not have been sent.");
      await load();
    } finally {
      setBusy(null);
      onUsageChanged();
    }
  }

  /** One request per step. Everything finished is stored, so stopping or failing loses nothing. */
  async function generate() {
    setBusy("generate");
    setError(null);
    stopRequested.current = false;
    try {
      for (let step = 0; step < MAX_STEPS && !stopRequested.current; step += 1) {
        const res = await fetch(`${base}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Generating stopped. What is finished is saved, so you can carry on.");
        setState((current) => ({ ...current, conversation: data.conversation, unitsLeft: data.unitsLeft }));
        onUsageChanged();
        if (data.done) {
          setDetail(data.proposal as AiProposalDetail);
          break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generating stopped. What is finished is saved, so you can carry on.");
      // Picks up what the server recorded about the refusal, so the owner can act on it.
      await load();
    } finally {
      setBusy(null);
      onUsageChanged();
    }
  }

  /** What the owner last asked for, leaving out their confirmations. */
  const lastRequest = () =>
    [...(conversation?.messages ?? [])].reverse().find((message) => message.role === "owner" && !message.text.startsWith(CLAIMS_CONFIRMED_PREFIX))?.text.slice(0, 1000) ?? "";

  /** The owner says refused wording is true for their business. Their own words are what counts as fact. */
  async function confirmClaims() {
    setBusy("send");
    setError(null);
    try {
      const res = await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmClaims: true }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "That could not be saved.");
      setState((current) => ({ ...current, conversation: data.conversation, unitsLeft: data.unitsLeft }));
      // Ready to ask again in one click: sending is still the owner's choice.
      if (phase === "proposal" || phase === "applied") setText(lastRequest());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Nothing was saved.");
    } finally {
      setBusy(null);
    }
  }

  /** Tries the step that was refused again. It is told to avoid the wording, and a refusal costs nothing. */
  function retryWithoutClaims() {
    if (phase === "proposal" || phase === "applied") {
      const request = lastRequest();
      if (request) void send(request, "revise");
    } else void generate();
  }

  async function startFresh() {
    if (!(await confirmDialog({ title: "Start a new conversation?", message: "The assistant forgets this conversation. Your website and any waiting proposals stay as they are.", confirmLabel: "Start again" }))) return;
    setBusy("fresh");
    setError(null);
    try {
      const res = await fetch(base, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "A new conversation could not be started.");
      setState({ conversation: data.conversation, unitsLeft: data.unitsLeft });
      setDetail(null);
      setNotes([]);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "A new conversation could not be started.");
    } finally {
      setBusy(null);
    }
  }

  if (state === null) {
    return (
      <div className="space-y-3" role="status" aria-label="Loading your conversation">
        <Skeleton className="h-16" />
        <Skeleton className="h-28" />
      </div>
    );
  }

  const generation = conversation?.generation;
  const generating = busy === "generate";
  const canGenerate = ready && !busy && phase !== "proposal" && phase !== "applied" && (conversation?.messages.length ?? 0) > 0;
  const placeholder =
    phase === "proposal" || phase === "applied"
      ? "For example: make the homepage hero shorter, or add a new arrivals page"
      : "For example: we are a family bakery in Pune, and want people to order cakes and find us";

  return (
    <div className="space-y-4">
      {state.expired && <Notice tone="info" role="status">Your last conversation ran out, so this is a new one. Nothing on your website changed.</Notice>}

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1 basis-64">
            <h3 className="text-sm font-semibold text-slate-900">Your whole website</h3>
            <p className="mt-0.5 text-sm leading-6 text-slate-600">Tell the assistant about your business, in your own words and in as many messages as you like. It can then write a complete website for you to review.</p>
          </div>
          <Button variant="ghost" disabled={busy !== null || (conversation?.messages.length ?? 0) === 0} onClick={() => void startFresh()}>Start again</Button>
        </div>

        {(conversation?.messages.length ?? 0) > 0 && (
          <ol aria-label="Your conversation with the assistant" aria-live="polite" className="mt-4 max-h-96 space-y-2 overflow-y-auto">
            {conversation?.messages.map((message, index) => (
              <li key={index} className={message.role === "owner" ? "ml-6 rounded-xl bg-slate-100 px-3 py-2 sm:ml-12" : "mr-6 rounded-xl border border-slate-200 bg-white px-3 py-2 sm:mr-12"}>
                <p className="text-xs font-medium text-slate-500">{message.role === "owner" ? "You" : "Assistant"}</p>
                <p className="mt-0.5 whitespace-pre-line break-words text-sm leading-6 text-slate-800">{message.text}</p>
              </li>
            ))}
          </ol>
        )}
        {busy === "send" && <p role="status" className="mt-3 text-sm font-medium text-slate-700">The assistant is thinking…</p>}
        {conversation && conversation.questions.length > 0 && phase === "discovery" && !busy && <div className="mt-3"><AiNotes notes={conversation.questions} /></div>}

        {(phase !== "generating" || conversation?.needsCorrection) && (
          <form
            className="mt-4 space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send(text);
            }}
          >
            <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
              {phase === "proposal" || phase === "applied" ? "What would you like to change?" : "Tell the assistant about your business"}
            </label>
            <textarea id={inputId} rows={3} maxLength={1000} value={text} disabled={!ready || busy !== null} placeholder={placeholder} onChange={(event) => setText(event.target.value)} className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm ${focus}`} />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="secondary" disabled={!ready || busy !== null || text.trim().length < 3}>{busy === "send" ? "Sending…" : "Send"}</Button>
              {phase === "discovery" && (
                <Button variant="ghost" disabled={!ready || busy !== null || text.trim().length < 3} onClick={() => void send(text, "revise")}>Change my current website instead</Button>
              )}
              {!ready && blockedReason && <span className="text-xs text-slate-500">{blockedReason}</span>}
            </div>
            <p className="text-xs leading-5 text-slate-500">Each answer uses one AI request. A contact detail typed here is removed before it is stored or sent: the store fills those in from Business settings. Only you can see this conversation. Your store&apos;s owners and managers can see the proposals it makes: what would change, never your messages.</p>
          </form>
        )}

        {(phase === "discovery" || phase === "generating") && (
          <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3">
            {generation?.started && (
              <div>
                <p className="text-sm font-medium text-slate-800" role="status">{generating ? "Writing your website…" : "Your website is partly written."} {generation.done} of {generation.total} steps done.</p>
                <div role="progressbar" aria-label="Website generation" aria-valuemin={0} aria-valuemax={generation.total} aria-valuenow={generation.done} className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-slate-800 transition-[width]" style={{ width: `${generation.total > 0 ? Math.round((generation.done / generation.total) * 100) : 0}%` }} />
                </div>
              </div>
            )}
            {generating && !generation?.started && <p role="status" className="text-sm font-medium text-slate-800">Planning your website…</p>}
            {conversation?.needsCorrection && !generating && (
              <Notice tone="warning" role="status">The assistant chose something your store does not have, so that step was not saved. Your finished steps are kept, and this cost nothing. Carry on to try just that step again, or tell the assistant what to use instead.</Notice>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {generating ? (
                <Button variant="secondary" onClick={() => { stopRequested.current = true; }}>Pause after this step</Button>
              ) : (
                <Button disabled={!canGenerate} onClick={() => void generate()}>{generation?.started ? "Carry on generating" : "Generate website"}</Button>
              )}
              {!generating && typeof state.unitsLeft === "number" && state.unitsLeft > 0 && (
                <span className="text-xs text-slate-600">
                  {generation?.started ? `About ${state.unitsLeft} more AI ${state.unitsLeft === 1 ? "request" : "requests"}.` : `Uses about ${state.unitsLeft} AI requests: one for the plan and homepage, and one for each page.`} A step that fails costs nothing.
                </span>
              )}
              {conversation?.readyToGenerate && !generation?.started && <Pill tone="success">The assistant has enough to start</Pill>}
            </div>
          </div>
        )}
      </div>

      {conversation && conversation.flagged.length > 0 && !busy && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-semibold">The assistant wrote things your store has not told it</p>
          <ul className="mt-2 space-y-1.5">
            {conversation.flagged.map((item) => (
              <li key={item.phrase} className="break-words">
                <span className="font-medium">“{item.phrase}”.</span> <span className="text-amber-900">{item.advice}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 leading-6">
            Nothing with this wording was saved, and a refused answer costs nothing. If you try again, the assistant is told to leave it out.
            {conversation.flagged.some((item) => item.canConfirm) && ` You can also confirm ${conversation.flagged.filter((item) => item.canConfirm).map((item) => `“${item.phrase}”`).join(", ")} if it is true for your business. Only do this for what you can stand behind: it may then appear on your store.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {conversation.flagged.some((item) => item.canConfirm) && <Button variant="secondary" onClick={() => void confirmClaims()}>Confirm as true for my business</Button>}
            <Button variant="ghost" disabled={!ready} onClick={retryWithoutClaims}>Try again without them</Button>
          </div>
        </div>
      )}

      {error && !(conversation && conversation.flagged.length > 0) && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p>{error}</p>
          {lastMessage && !generating && phase !== "generating" && (
            <div className="mt-2">
              <Button variant="secondary" disabled={!ready || busy !== null} onClick={() => void send(lastMessage)}>Try again</Button>
            </div>
          )}
        </div>
      )}

      {conversation?.proposalStatus === "rejected" && <Notice tone="info" role="status">You refused the last suggestion, so none of it was used. Tell the assistant what you would prefer, then generate again.</Notice>}
      {conversation?.proposalStatus === "failed" && <Notice tone="warning" role="status">The last suggestion ran out or could not be applied, so none of it was used. You can generate again.</Notice>}

      {detail && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <AiProposalReview
            key={detail.id}
            businessId={businessId}
            detail={detail}
            notes={notes}
            dirty={false}
            previewData={previewData}
            onChanged={async () => {
              await load();
              onUsageChanged();
            }}
            onApplied={() => router.refresh()}
            onEditRequest={() => document.getElementById(inputId)?.focus()}
            onRegenerate={() => {
              // From this person's own conversation: a proposal does not hold their messages.
              setText(lastRequest());
              document.getElementById(inputId)?.focus();
            }}
          />
        </div>
      )}
    </div>
  );
}
