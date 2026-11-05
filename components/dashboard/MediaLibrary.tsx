"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACCEPTED_IMAGE_TYPES,
  MEDIA_ACCEPT_ATTRIBUTE,
  filterMediaItems,
  formatBytes,
  formatMediaDate,
  mediaErrorMessage,
  mediaInUseMessage,
  mediaTypeLabel,
  mergeMediaItems,
  parseMediaItem,
  parseMediaList,
  parseMediaPagination,
  parseMediaStorage,
  parsePendingCleanup,
  planUploadFiles,
  type MediaItem,
  type MediaStorage,
} from "@/lib/media-client";
import ManagementPageHeader from "./ManagementPageHeader";
import { buttonClass, focusRing } from "@/components/ui/Button";
import { inputClass } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { EmptyState, Notice, Skeleton } from "@/components/ui/Surface";

type LoadStatus = "loading" | "ready" | "error";

const primaryButtonClass = buttonClass();

const secondaryButtonClass = buttonClass({ variant: "secondary" });

const ghostButtonClass = buttonClass({ variant: "ghost" });

const dangerButtonClass = buttonClass({ variant: "danger" });

const quietDangerClass = `inline-flex min-h-10 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

const mediaGridClass = "grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

const loadingGrid = (
  <ul aria-hidden="true" className={mediaGridClass}>
    {Array.from({ length: 8 }, (_, index) => (
      <li
        key={index}
        className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      >
        <Skeleton className="aspect-[4/3] !rounded-none" />
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </li>
    ))}
  </ul>
);

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function MediaPreview({
  src,
  altText,
  label,
}: {
  src: string;
  altText: string;
  label: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative aspect-[4/3] overflow-hidden bg-slate-100">
      {failed ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-slate-500">
          <Icon name="media" size={28} />
          <p className="text-xs font-medium">Preview unavailable</p>
        </div>
      ) : (
        // A plain <img> is deliberate: media is served from a per-deployment
        // S3/CDN host, so next/image would need runtime-wide remotePatterns.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={altText}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
      <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-slate-950/70 px-2 py-0.5 text-[11px] font-semibold text-white ring-1 ring-inset ring-white/25">
        {label}
      </span>
    </div>
  );
}

export interface MediaCardProps {
  item: MediaItem;
  editor: { open: boolean; draft: string; saving: boolean; error: string | null };
  deleter: { confirming: boolean; busy: boolean; error: string | null };
  actionsDisabled: boolean;
  onEditAlt: () => void;
  onAltDraftChange: (value: string) => void;
  onSaveAlt: (event: React.FormEvent) => void;
  onCancelAlt: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

export function MediaCard({
  item,
  editor,
  deleter,
  actionsDisabled,
  onEditAlt,
  onAltDraftChange,
  onSaveAlt,
  onCancelAlt,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: MediaCardProps) {
  const typeLabel = mediaTypeLabel(item.mimeType);
  const added = formatMediaDate(item.createdAt);
  const altFieldId = `alt-text-${item.id}`;
  const altHelpId = `alt-help-${item.id}`;
  const altErrorId = `alt-error-${item.id}`;
  const deleteWarningId = `delete-warning-${item.id}`;

  const editButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const wasConfirming = useRef(false);

  // Keep keyboard users anchored when the inline editor or confirmation
  // replaces the card's action row.
  useEffect(() => {
    if (!editor.open && wasEditing.current) {
      editButtonRef.current?.focus();
    }
    wasEditing.current = editor.open;
  }, [editor.open]);

  useEffect(() => {
    if (deleter.confirming && !wasConfirming.current) {
      keepButtonRef.current?.focus();
    } else if (!deleter.confirming && wasConfirming.current) {
      deleteButtonRef.current?.focus();
    }
    wasConfirming.current = deleter.confirming;
  }, [deleter.confirming]);

  return (
    <li
      aria-busy={editor.saving || deleter.busy}
      className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      <MediaPreview
        src={item.url}
        altText={item.altText}
        label={typeLabel}
      />

      <div className="flex flex-1 flex-col p-4">
        <h3
          title={item.originalName}
          className="truncate text-sm font-semibold text-slate-900"
        >
          {item.originalName}
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          {formatBytes(item.size)} {typeLabel} image
          {added ? `, added ${added}` : ""}
        </p>
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`mt-1 inline-block self-start rounded text-xs font-medium text-slate-700 underline underline-offset-2 hover:text-slate-950 ${focusRing}`}
        >
          View full size<span className="sr-only"> of {item.originalName} (opens in a new tab)</span>
        </a>

        <div className="mt-3 flex-1">
          {editor.open ? (
            <form
              onSubmit={onSaveAlt}
              className="rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <label
                htmlFor={altFieldId}
                className="block text-xs font-medium text-slate-600"
              >
                Alt text
              </label>
              <input
                id={altFieldId}
                type="text"
                value={editor.draft}
                maxLength={240}
                autoFocus
                disabled={editor.saving}
                aria-describedby={
                  editor.error ? `${altHelpId} ${altErrorId}` : altHelpId
                }
                onChange={(event) => onAltDraftChange(event.target.value)}
                className={`${inputClass} mt-1`}
                placeholder="Describe what this image shows"
              />
              <p id={altHelpId} className="mt-1 text-xs text-slate-500">
                {editor.draft.length}/240 characters. Describe the image for
                people who use screen readers.
              </p>
              {editor.error ? (
                <p
                  id={altErrorId}
                  className="mt-1 text-xs font-medium text-red-700"
                  role="alert"
                >
                  {editor.error}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={editor.saving}
                  aria-label={`Save alt text for ${item.originalName}`}
                  className={primaryButtonClass}
                >
                  {editor.saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  disabled={editor.saving}
                  onClick={onCancelAlt}
                  aria-label={`Cancel editing alt text for ${item.originalName}`}
                  className={secondaryButtonClass}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : deleter.confirming ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p id={deleteWarningId} className="text-xs font-medium text-red-800">
                Delete “{item.originalName}”? This can&apos;t be undone.
              </p>
              {deleter.error ? (
                <p className="mt-1 text-xs text-red-700" role="alert">
                  {deleter.error}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  ref={keepButtonRef}
                  type="button"
                  disabled={deleter.busy}
                  onClick={onCancelDelete}
                  aria-label={`Keep ${item.originalName}`}
                  aria-describedby={deleteWarningId}
                  className={secondaryButtonClass}
                >
                  Keep image
                </button>
                <button
                  type="button"
                  disabled={deleter.busy}
                  onClick={onConfirmDelete}
                  aria-label={`Confirm deleting ${item.originalName}`}
                  aria-describedby={deleteWarningId}
                  className={dangerButtonClass}
                >
                  {deleter.busy
                    ? "Deleting…"
                    : deleter.error
                      ? "Try delete again"
                      : "Delete image"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-xs leading-5 text-slate-600">
                <span className="font-medium text-slate-500">Alt text: </span>
                {item.altText ? (
                  <span className="line-clamp-2 block" title={item.altText}>
                    {item.altText}
                  </span>
                ) : (
                  <span className="font-medium text-amber-700">
                    Missing. Describe this image for screen readers.
                  </span>
                )}
              </p>
              <div className="mt-3 flex flex-wrap gap-1 border-t border-slate-100 pt-3">
                <button
                  ref={editButtonRef}
                  type="button"
                  onClick={onEditAlt}
                  disabled={actionsDisabled}
                  aria-label={`Edit alt text for ${item.originalName}`}
                  className={ghostButtonClass}
                >
                  Edit alt text
                </button>
                <button
                  ref={deleteButtonRef}
                  type="button"
                  onClick={onRequestDelete}
                  disabled={actionsDisabled}
                  aria-label={`Delete ${item.originalName}`}
                  className={quietDangerClass}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export default function MediaLibrary({ businessId }: { businessId: string }) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [pendingCleanup, setPendingCleanup] = useState<MediaItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadDone, setUploadDone] = useState(0);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const [storage, setStorage] = useState<MediaStorage | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [altDraft, setAltDraft] = useState("");
  const [savingAlt, setSavingAlt] = useState(false);
  const [altError, setAltError] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const [cleanupBusyId, setCleanupBusyId] = useState<string | null>(null);
  const [cleanupError, setCleanupError] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const uploadingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const libraryHeadingRef = useRef<HTMLHeadingElement>(null);

  const loadPage = useCallback(
    async (nextOffset: number, append: boolean, quiet = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (append) setLoadingMore(true);
      else if (!quiet) {
        setStatus("loading");
        setLoadError(null);
      }
      setRefreshError(null);
      setCleanupError(null);

      try {
        const response = await fetch(
          `/api/businesses/${businessId}/media?limit=24&offset=${nextOffset}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const payload = await readJson(response);
        if (controller.signal.aborted) return;

        if (!response.ok) {
          const message = mediaErrorMessage(
            "load",
            payload,
            "We couldn't load your images. Try again in a moment.",
          );
          if (quiet) {
            setRefreshError(message);
          } else {
            setLoadError(message);
            setStatus("error");
          }
          return;
        }

        const media = parseMediaList(payload);
        if (media === null) {
          const message =
            "The media list came back in an unexpected format. Try again.";
          if (quiet) {
            setRefreshError(message);
          } else {
            setLoadError(message);
            setStatus("error");
          }
          return;
        }

        const pagination = parseMediaPagination(payload);
        setItems((current) =>
          append ? mergeMediaItems(current, media) : media,
        );
        setPendingCleanup(parsePendingCleanup(payload));
        setStorage(parseMediaStorage(payload));
        setOffset(nextOffset + media.length);
        setTotal(pagination.total);
        setHasMore(pagination.hasMore);
        setStatus("ready");
        setLoadError(null);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        const message =
          "We couldn't reach the server. Check your connection and try again.";
        if (quiet) {
          setRefreshError(message);
        } else {
          setLoadError(message);
          setStatus("error");
        }
      } finally {
        if (append) setLoadingMore(false);
      }
    },
    [businessId],
  );

  const load = useCallback(
    (quiet = false) => loadPage(0, false, quiet),
    [loadPage],
  );

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  function clearFeedback() {
    setNotice(null);
    setUploadErrors([]);
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0 || uploadingRef.current) return;

    const { accepted: ready, problems } = planUploadFiles(files);

    if (ready.length === 0) {
      setNotice(null);
      setUploadErrors([...problems]);
      return;
    }

    uploadingRef.current = true;
    setUploading(true);
    setUploadTotal(ready.length);
    setUploadDone(0);
    setUploadErrors([...problems]);
    setNotice(null);
    setRefreshError(null);

    const created: MediaItem[] = [];
    let uploaded = 0;

    try {
      for (const file of ready) {
        const body = new FormData();
        body.append("file", file);

        try {
          const response = await fetch(`/api/businesses/${businessId}/media`, {
            method: "POST",
            body,
          });
          const payload = await readJson(response);

          if (!response.ok) {
            problems.push(
              `${file.name}: ${mediaErrorMessage(
                "upload",
                payload,
                "The upload failed. Try again.",
              )}`,
            );
          } else {
            const createdItem = parseMediaItem(payload);
            if (createdItem) created.push(createdItem);
            uploaded += 1;
          }
        } catch {
          problems.push(
            `${file.name}: We couldn't reach the server. Check your connection and try again.`,
          );
        }

        setUploadDone((done) => done + 1);
      }
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }

    if (created.length > 0) {
      setItems((current) => mergeMediaItems(current, created));
    }

    if (uploaded > 0) {
      setStatus("ready");
      setNotice(
        uploaded === 1 ? "Image uploaded." : `${uploaded} images uploaded.`,
      );
      // Re-fetch so newly uploaded rows match the server's ordering.
      await load(true);
    }

    if (problems.length > 0) setUploadErrors([...problems]);
  }

  function startAltEdit(item: MediaItem) {
    setEditingId(item.id);
    setAltDraft(item.altText);
    setAltError(null);
    setConfirmingId(null);
    setDeleteError(null);
    clearFeedback();
  }

  function cancelAltEdit() {
    setEditingId(null);
    setAltDraft("");
    setAltError(null);
  }

  async function saveAltText(event: React.FormEvent, item: MediaItem) {
    event.preventDefault();
    if (savingAlt) return;

    const nextAltText = altDraft.trim();
    setSavingAlt(true);
    setAltError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/businesses/${businessId}/media/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ altText: nextAltText }),
        },
      );
      const payload = await readJson(response);

      if (!response.ok) {
        setAltError({
          id: item.id,
          message: mediaErrorMessage(
            "save",
            payload,
            "Alt text couldn't be saved. Try again.",
          ),
        });
        return;
      }

      const returned = parseMediaItem(payload);
      const savedAltText = returned ? returned.altText : nextAltText;

      setItems((current) =>
        current.map((existing) =>
          existing.id === item.id
            ? { ...existing, altText: savedAltText }
            : existing,
        ),
      );
      setEditingId(null);
      setAltDraft("");
      setNotice("Alt text saved.");
    } catch {
      setAltError({
        id: item.id,
        message:
          "We couldn't reach the server. Check your connection and try again.",
      });
    } finally {
      setSavingAlt(false);
    }
  }

  function requestDelete(item: MediaItem) {
    setConfirmingId(item.id);
    setDeleteError(null);
    setEditingId(null);
    setAltError(null);
    clearFeedback();
  }

  function cancelDelete() {
    setConfirmingId(null);
    setDeleteError(null);
  }

  async function deleteMedia(item: MediaItem) {
    if (deletingId) return;

    setDeletingId(item.id);
    setDeleteError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/businesses/${businessId}/media/${item.id}`,
        { method: "DELETE" },
      );
      const payload = await readJson(response);

      if (response.ok || response.status === 404) {
        setItems((current) =>
          current.filter((existing) => existing.id !== item.id),
        );
        setPendingCleanup((current) =>
          current.filter((existing) => existing.id !== item.id),
        );
        setConfirmingId(null);
        setEditingId(null);
        setNotice(
          response.ok ? "Image deleted." : "That image was already removed.",
        );
        // The card that held focus is gone; return keyboard users to the list
        // heading instead of dropping focus to the document body.
        libraryHeadingRef.current?.focus();
        return;
      }

      if (response.status === 409) {
        setDeleteError({ id: item.id, message: mediaInUseMessage(payload) });
        return;
      }

      setDeleteError({
        id: item.id,
        message: mediaErrorMessage(
          "delete",
          payload,
          "The image couldn't be deleted. Try again.",
        ),
      });
    } catch {
      setDeleteError({
        id: item.id,
        message:
          "We couldn't reach the server. Check your connection and try again.",
      });
    } finally {
      setDeletingId(null);
    }
  }

  async function retryCleanup(item: MediaItem) {
    if (cleanupBusyId) return;

    setCleanupBusyId(item.id);
    setCleanupError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/businesses/${businessId}/media/${item.id}`,
        { method: "DELETE" },
      );
      const payload = await readJson(response);

      if (response.ok || response.status === 404) {
        const remaining = pendingCleanup.length - 1;
        setPendingCleanup((current) =>
          current.filter((existing) => existing.id !== item.id),
        );
        setNotice(
          response.ok
            ? "Image deletion finished."
            : "That image was already removed.",
        );
        if (remaining === 0) libraryHeadingRef.current?.focus();
        return;
      }

      if (response.status === 409) {
        setCleanupError({ id: item.id, message: mediaInUseMessage(payload) });
        return;
      }

      setCleanupError({
        id: item.id,
        message: mediaErrorMessage(
          "delete",
          payload,
          "The image couldn't be deleted. Try again.",
        ),
      });
    } catch {
      setCleanupError({
        id: item.id,
        message:
          "We couldn't reach the server. Check your connection and try again.",
      });
    } finally {
      setCleanupBusyId(null);
    }
  }

  const totalBytes = items.reduce((total, item) => total + item.size, 0);
  const usedBytes = storage?.usedBytes ?? totalBytes;
  const storagePercent = storage?.limitBytes ? Math.min(100, Math.round((usedBytes / storage.limitBytes) * 100)) : 0;
  const storageFull = storage?.limitBytes != null && usedBytes >= storage.limitBytes;
  const filtered = filterMediaItems(items, query).filter((item) => !typeFilter || item.mimeType === typeFilter);
  const progressPercent =
    uploadTotal === 0 ? 0 : Math.round((uploadDone / uploadTotal) * 100);

  return (
    <div data-business-id={businessId} className="space-y-6">
      <ManagementPageHeader
        title="Media"
        description="Images for your storefront. Add alt text so customers using screen readers know what each image shows."
      />

      <section
        aria-labelledby="media-upload-heading"
        className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      >
        <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="p-6">
            <h2
              id="media-upload-heading"
              className="text-lg font-semibold text-slate-900"
            >
              Upload images
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              JPEG, PNG, WebP or GIF. Up to 4 MB per image.
            </p>
            <p className="mt-3 text-xs leading-5 text-slate-500">
              Uploads are checked on the server, so only real image files are
              accepted. Alt text can be added after uploading.
            </p>
          </div>

          <div className="border-t border-slate-200 bg-slate-50 p-4 md:border-l md:border-t-0">
            <label
              htmlFor="media-upload-input"
              onDragOver={(event) => {
                event.preventDefault();
                if (!uploading) setDragging(true);
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (
                  !(nextTarget instanceof Node) ||
                  !event.currentTarget.contains(nextTarget)
                ) {
                  setDragging(false);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                if (!uploading) {
                  void uploadFiles(Array.from(event.dataTransfer.files));
                }
              }}
              className={`flex min-h-32 flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-6 text-center transition focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 ${
                uploading
                  ? "pointer-events-none cursor-not-allowed border-slate-300 bg-slate-100 opacity-60"
                  : dragging
                    ? "cursor-copy border-ember bg-brand-50"
                    : "cursor-pointer border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50"
              }`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className={`h-7 w-7 ${dragging ? "text-ember-deep" : "text-slate-400"}`}
              >
                <path d="M4 16.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2.5" />
                <path d="M12 15V4" />
                <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
              </svg>
              <span className="mt-2 block text-sm font-semibold text-slate-900">
                {uploading ? "Uploading…" : "Drag images here or choose files"}
              </span>
              <span className="mt-1 block text-xs text-slate-500">
                You can select more than one image.
              </span>
              <input
                ref={fileInputRef}
                id="media-upload-input"
                type="file"
                accept={MEDIA_ACCEPT_ATTRIBUTE}
                multiple
                disabled={uploading}
                aria-describedby="media-upload-hint"
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  void uploadFiles(files);
                }}
                className="sr-only"
              />
            </label>
            <p
              id="media-upload-hint"
              className="mt-2 text-center text-xs text-slate-500"
            >
              Maximum 4 MB per image.
            </p>
          </div>
        </div>

        {uploading ? (
          <div
            role="status"
            className="border-t border-slate-200 px-6 py-4"
          >
            <div className="flex items-center justify-between gap-3 text-sm">
              <p className="font-medium text-slate-700">
                Uploading {Math.min(uploadDone + 1, uploadTotal)} of{" "}
                {uploadTotal}
              </p>
              <p className="text-slate-500">{progressPercent}%</p>
            </div>
            <div
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={uploadTotal}
              aria-valuenow={uploadDone}
              aria-valuetext={`${uploadDone} of ${uploadTotal} images uploaded`}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200"
            >
              <div
                className="h-full rounded-full bg-brand-600 transition-[width] duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        ) : null}
      </section>

      {notice ? (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      ) : null}

      {uploadErrors.length > 0 ? (
        <Notice
          tone="danger"
          role="alert"
          title={
            uploadErrors.length === 1
              ? "One image wasn't uploaded"
              : "Some images weren't uploaded"
          }
        >
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {uploadErrors.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {refreshError ? (
        <Notice tone="warning" role="alert">
          {refreshError}
        </Notice>
      ) : null}

      {pendingCleanup.length > 0 ? (
        <section
          aria-labelledby="media-cleanup-heading"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          <h2 id="media-cleanup-heading" className="font-semibold">
            {pendingCleanup.length === 1
              ? "Finish deleting 1 image"
              : `Finish deleting ${pendingCleanup.length} images`}
          </h2>
          <p className="mt-1 text-amber-900">
            {pendingCleanup.length === 1 ? "This image is" : "These images are"}{" "}
            hidden from your library, but the file host didn&apos;t confirm
            deletion. Retry to finish removing the stored files.
          </p>
          <ul className="mt-3 space-y-2">
            {pendingCleanup.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2"
              >
                <span
                  title={item.originalName}
                  className="min-w-0 truncate font-medium text-slate-800"
                >
                  {item.originalName}
                </span>
                <div className="flex flex-wrap items-center gap-3">
                  {cleanupError?.id === item.id ? (
                    <span
                      role="alert"
                      className="text-xs font-medium text-red-700"
                    >
                      {cleanupError.message}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    disabled={cleanupBusyId !== null}
                    onClick={() => void retryCleanup(item)}
                    aria-label={`Retry removing ${item.originalName}`}
                    className={dangerButtonClass}
                  >
                    {cleanupBusyId === item.id ? "Removing…" : "Retry removal"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="media-library-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2
            id="media-library-heading"
            ref={libraryHeadingRef}
            tabIndex={-1}
            className="text-lg font-semibold text-slate-900 outline-none"
          >
            Your images
          </h2>
          {status === "ready" && items.length > 0 ? (
            <p className="text-sm text-slate-500">
              {items.length} of {total} image{total === 1 ? "" : "s"} loaded
              {hasMore ? " (load more to see the rest)" : ""}
            </p>
          ) : null}
        </div>

        {status === "ready" && storage ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="font-medium text-slate-800">Storage used</span>
              <span className={`font-semibold tabular-nums ${storageFull ? "text-amber-800" : "text-slate-900"}`}>
                {formatBytes(usedBytes)}
                {storage.limitBytes !== null ? ` of ${formatBytes(storage.limitBytes)}` : ", no limit on your plan"}
              </span>
            </div>
            {storage.limitBytes !== null ? (
              <div aria-hidden="true" className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${storageFull ? "bg-amber-500" : "bg-slate-900"}`} style={{ width: `${storagePercent}%` }} />
              </div>
            ) : null}
            {storageFull ? <p className="mt-1 text-xs text-amber-800">Your images stay, but you can&apos;t upload more until you delete some or upgrade your plan.</p> : null}
          </div>
        ) : null}

        {status === "ready" && items.length > 0 ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <label htmlFor="media-search" className="block text-xs font-medium text-slate-600">
                Search by file name or alt text
              </label>
              <input id="media-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} className={`${inputClass} mt-1`} />
            </div>
            <div>
              <label htmlFor="media-type" className="block text-xs font-medium text-slate-600">
                File type
              </label>
              <select id="media-type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className={`${inputClass} mt-1`}>
                <option value="">All types</option>
                {ACCEPTED_IMAGE_TYPES.map((type) => <option key={type} value={type}>{mediaTypeLabel(type)}</option>)}
              </select>
            </div>
            {query || typeFilter ? <p role="status" className="pb-2 text-sm text-slate-500">{filtered.length} matching</p> : null}
          </div>
        ) : null}

        {status === "loading" ? (
          <>
            {loadingGrid}
            <p role="status" className="sr-only">
              Loading your images…
            </p>
          </>
        ) : status === "error" ? (
          <div
            role="alert"
            className="rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm"
          >
            <h3 className="text-base font-semibold text-slate-900">
              Images couldn&apos;t be loaded
            </h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">
              {loadError}
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className={`${primaryButtonClass} mt-4`}
            >
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Icon name="media" size={20} />}
            title="No images yet"
            action={
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className={primaryButtonClass}
              >
                Choose images
              </button>
            }
          >
            Upload a product photo, logo or banner to get started. You can add
            alt text after uploading.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState icon={<Icon name="media" size={20} />} title="No images match">
            Try another search, or show all file types.
          </EmptyState>
        ) : (
          <ul className={mediaGridClass}>
            {filtered.map((item) => (
              <MediaCard
                key={item.id}
                item={item}
                editor={{
                  open: editingId === item.id,
                  draft: altDraft,
                  saving: savingAlt,
                  error: altError?.id === item.id ? altError.message : null,
                }}
                deleter={{
                  confirming: confirmingId === item.id,
                  busy: deletingId === item.id,
                  error:
                    deleteError?.id === item.id ? deleteError.message : null,
                }}
                actionsDisabled={savingAlt || deletingId !== null}
                onEditAlt={() => startAltEdit(item)}
                onAltDraftChange={setAltDraft}
                onSaveAlt={(event) => void saveAltText(event, item)}
                onCancelAlt={cancelAltEdit}
                onRequestDelete={() => requestDelete(item)}
                onConfirmDelete={() => void deleteMedia(item)}
                onCancelDelete={cancelDelete}
              />
            ))}
          </ul>
        )}
      </section>

      {status === "ready" && items.length > 0 ? (
        <div className="flex flex-col items-center gap-2">
          {hasMore ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadPage(offset, true)}
              className={secondaryButtonClass}
            >
              {loadingMore ? "Loading…" : "Load more images"}
            </button>
          ) : (
            <p className="text-sm text-slate-500">All images loaded.</p>
          )}
        </div>
      ) : null}

    </div>
  );
}
