"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  filterMediaItems,
  formatBytes,
  mediaErrorMessage,
  mergeMediaItems,
  parseMediaList,
  parseMediaPagination,
  type MediaItem,
} from "@/lib/media-client";
import { buttonClass, focusRing } from "@/components/ui/Button";
import { inputClass } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Surface";

export interface MediaSelection {
  id: string;
  url: string;
  altText: string;
  originalName: string;
}

export interface MediaPickerProps {
  /** Business id supplied by the authenticated server page, never by a URL query. */
  businessId: string;
  /** Current image URL, used to preselect a library item when it matches. */
  selectedUrl?: string;
  onSelect: (selection: MediaSelection | null) => void;
  disabled?: boolean;
  /** Shows a "Remove image" action next to the trigger (sections). */
  allowClear?: boolean;
  buttonLabel?: string;
  changeLabel?: string;
  /** Added to the trigger's accessible name, e.g. "product image". */
  contextLabel?: string;
}

type LoadStatus = "loading" | "ready" | "error";

const primaryButtonClass = buttonClass();

const secondaryButtonClass = buttonClass({ variant: "secondary" });

const subtleButtonClass = buttonClass({ variant: "ghost" });

const pickerGridClass = "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4";

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

function MediaThumb({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative aspect-[4/3] overflow-hidden bg-slate-100">
      {failed ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-slate-500">
          <Icon name="media" size={24} />
          <span className="text-[11px] font-medium">Preview unavailable</span>
        </div>
      ) : (
        // A plain <img> is deliberate: media lives on a per-deployment S3/CDN
        // host, so next/image would need runtime-wide remotePatterns.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}

export function MediaPickerCard({
  item,
  selected,
  onSelect,
}: {
  item: MediaItem;
  selected: boolean;
  onSelect: (item: MediaItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      aria-pressed={selected}
      className={`group relative w-full overflow-hidden rounded-xl border bg-white text-left transition-colors ${focusRing} ${
        selected
          ? "border-slate-900 ring-2 ring-slate-900"
          : "border-slate-200 hover:border-slate-400"
      }`}
    >
      {/* The filename and alt text below carry the accessible name; the
          thumbnail itself is decorative inside this labelled control. */}
      <MediaThumb src={item.url} alt="" />
      {selected ? (
        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">
          <Icon name="check" size={12} />
          Selected
        </span>
      ) : null}
      <span className="block p-3">
        <span
          title={item.originalName}
          className="block truncate text-sm font-semibold text-slate-900"
        >
          {item.originalName}
        </span>
        <span
          title={item.altText || undefined}
          className={`mt-1 block truncate text-xs ${
            item.altText ? "text-slate-500" : "font-medium text-amber-700"
          }`}
        >
          {item.altText || "No alt text"}
        </span>
        <span className="mt-1 block text-[11px] text-slate-500">
          {formatBytes(item.size)}
        </span>
      </span>
    </button>
  );
}

export default function MediaPicker({
  businessId,
  selectedUrl = "",
  onSelect,
  disabled = false,
  allowClear = false,
  buttonLabel = "Choose from media library",
  changeLabel = "Change image",
  contextLabel,
}: MediaPickerProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const titleId = useId();
  const descriptionId = useId();
  const searchId = useId();

  useEffect(() => {
    setMounted(true);
  }, []);

  const loadPage = useCallback(
    async (nextOffset: number, append = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (append) setLoadingMore(true);
      else {
        setStatus("loading");
        setLoadError(null);
      }

      try {
        const response = await fetch(
          `/api/businesses/${businessId}/media?limit=30&offset=${nextOffset}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const payload = await readJson(response);
        if (controller.signal.aborted) return;

        if (!response.ok) {
          setLoadError(
            mediaErrorMessage(
              "load",
              payload,
              "We couldn't load your images. Try again in a moment.",
            ),
          );
          setStatus("error");
          return;
        }

        const media = parseMediaList(payload);
        if (media === null) {
          setLoadError(
            "The media list came back in an unexpected format. Try again.",
          );
          setStatus("error");
          return;
        }

        setItems((current) =>
          append ? mergeMediaItems(current, media) : media,
        );
        setOffset(nextOffset + media.length);
        setHasMore(parseMediaPagination(payload).hasMore);
        setStatus("ready");
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        setLoadError(
          "We couldn't reach the server. Check your connection and try again.",
        );
        setStatus("error");
      } finally {
        if (append) setLoadingMore(false);
      }
    },
    [businessId],
  );

  const load = useCallback(() => loadPage(0, false), [loadPage]);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      return;
    }
    // Reopening starts from the saved selection and an unfiltered library, not
    // a stale draft or an old search.
    setItems([]);
    setOffset(0);
    setHasMore(false);
    setSelectedId(null);
    setQuery("");
    void load();
    return () => abortRef.current?.abort();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const triggerElement = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusTimer = window.setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      // Return focus to the control that opened the picker (unless it was
      // removed while the dialog was open).
      (triggerElement ?? previousFocusRef.current)?.focus();
    };
  }, [open]);

  // Keep Escape working if focus ever lands outside the panel (for example
  // after the retry button is replaced by the reloaded grid).
  useEffect(() => {
    if (!open) return;
    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    }
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [open]);

  // Safety net for focus lost when a focused element is removed from the
  // dialog (retry/clear-search). The Tab trap handles normal keyboard paths;
  // this keeps the dialog usable when the DOM swaps underneath focus.
  useEffect(() => {
    if (!open) return;
    const root = dialogRef.current;
    if (root && !root.contains(document.activeElement)) {
      closeButtonRef.current?.focus();
    }
  });

  function close() {
    setOpen(false);
  }

  const selectedItem = selectedId
    ? items.find((item) => item.id === selectedId) ?? null
    : selectedUrl
      ? items.find((item) => item.url === selectedUrl) ?? null
      : null;

  const filteredItems = filterMediaItems(items, query);

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;

    const root = dialogRef.current;
    if (!root) return;

    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const dialog =
    open && mounted
      ? createPortal(
          <div
            className="ui-fade fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={descriptionId}
              onKeyDown={handleDialogKeyDown}
              className="ui-pop flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-lg sm:max-h-[85vh] sm:rounded-2xl"
            >
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                <div className="min-w-0">
                  <h2
                    id={titleId}
                    className="text-lg font-semibold tracking-tight text-slate-900"
                  >
                    Choose an image
                  </h2>
                  <p
                    id={descriptionId}
                    className="mt-1 text-sm text-slate-600"
                  >
                    Select an image from this business&apos;s media library.
                  </p>
                </div>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={close}
                  aria-label="Close image picker"
                  className={`-m-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 ${focusRing}`}
                >
                  <Icon name="x" size={20} />
                </button>
              </div>

              <div className="border-b border-slate-200 px-5 py-3">
                <label htmlFor={searchId} className="sr-only">
                  Search images
                </label>
                <input
                  id={searchId}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    // The picker is rendered inside a product form; Enter in
                    // the search box must not submit that outer form.
                    if (event.key === "Enter") event.preventDefault();
                  }}
                  placeholder="Search by filename or alt text"
                  className={inputClass}
                />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" aria-busy={status === "loading"}>
                {status === "loading" ? (
                  <>
                    <ul aria-hidden="true" className={pickerGridClass}>
                      {Array.from({ length: 8 }, (_, index) => (
                        <li
                          key={index}
                          className="overflow-hidden rounded-xl border border-slate-200 bg-white"
                        >
                          <Skeleton className="aspect-[4/3] !rounded-none" />
                          <div className="space-y-2 p-3">
                            <Skeleton className="h-3.5 w-3/4" />
                            <Skeleton className="h-3 w-1/2" />
                          </div>
                        </li>
                      ))}
                    </ul>
                    <p role="status" className="sr-only">
                      Loading your images…
                    </p>
                  </>
                ) : status === "error" ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-red-200 bg-red-50 px-5 py-8 text-center"
                  >
                    <h3 className="text-base font-semibold text-red-900">
                      Images couldn&apos;t be loaded
                    </h3>
                    <p className="mx-auto mt-1 max-w-md text-sm text-red-800">
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
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
                    <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white">
                      <Icon name="media" size={20} />
                    </span>
                    <h3 className="text-base font-semibold text-slate-900">
                      No images yet
                    </h3>
                    <p className="mx-auto mt-1 max-w-sm text-sm text-slate-600">
                      Upload product photos or banners in your media library,
                      then come back to choose one.
                    </p>
                    <a
                      href={`/dashboard/businesses/${businessId}/media`}
                      target="_blank"
                      rel="noreferrer"
                      className={`${secondaryButtonClass} mt-4`}
                    >
                      Open media library
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
                    <h3 className="text-base font-semibold text-slate-900">
                      No images match your search
                    </h3>
                    <p className="mt-1 text-sm text-slate-600">
                      Try a different filename or alt-text phrase.
                    </p>
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      className={`${secondaryButtonClass} mt-4`}
                    >
                      Clear search
                    </button>
                  </div>
                ) : (
                  <>
                    <ul className={pickerGridClass}>
                      {filteredItems.map((item) => (
                        <li key={item.id}>
                          <MediaPickerCard
                            item={item}
                            selected={selectedItem?.id === item.id}
                            onSelect={(picked) => setSelectedId(picked.id)}
                          />
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-xs text-slate-500">
                      Showing {filteredItems.length} of {items.length}{" "}
                      {items.length === 1 ? "image" : "images"}
                    </p>
                    {hasMore ? (
                      <button
                        type="button"
                        disabled={loadingMore}
                        onClick={() => void loadPage(offset, true)}
                        className={`${secondaryButtonClass} mt-3`}
                      >
                        {loadingMore ? "Loading…" : "Load more images"}
                      </button>
                    ) : null}
                    <p className="mt-2 text-xs text-slate-500">
                      Search covers the images currently loaded.
                    </p>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4">
                <p
                  aria-live="polite"
                  className="min-w-0 truncate text-sm text-slate-600"
                >
                  {selectedItem ? (
                    <>
                      Selected:{" "}
                      <span className="font-semibold text-slate-900">
                        {selectedItem.originalName}
                      </span>
                    </>
                  ) : (
                    "Select an image to continue."
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={close}
                    className={secondaryButtonClass}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!selectedItem}
                    onClick={() => {
                      if (!selectedItem) return;
                      onSelect({
                        id: selectedItem.id,
                        url: selectedItem.url,
                        altText: selectedItem.altText,
                        originalName: selectedItem.originalName,
                      });
                      close();
                    }}
                    className={primaryButtonClass}
                  >
                    Use image
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled}
          aria-haspopup="dialog"
          className={secondaryButtonClass}
        >
          {selectedUrl ? changeLabel : buttonLabel}
          {contextLabel ? (
            <span className="sr-only"> for {contextLabel}</span>
          ) : null}
        </button>
        {allowClear && selectedUrl ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            disabled={disabled}
            className={subtleButtonClass}
          >
            Remove image
          </button>
        ) : null}
      </div>
      {dialog}
    </>
  );
}
