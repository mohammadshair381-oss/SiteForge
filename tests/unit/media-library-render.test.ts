import assert from "node:assert/strict";
import test, { before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { MediaCardProps } from "../../frontend/components/dashboard/MediaLibrary";
import type { MediaItem } from "../../backend/lib/media-client";

// TSX in this test runner compiles to classic React.createElement calls.
(globalThis as unknown as { React?: typeof React }).React = React;

type MediaCardComponent = (props: MediaCardProps) => React.ReactElement;
let MediaCard: MediaCardComponent;

before(async () => {
  const module = await import("../../frontend/components/dashboard/MediaLibrary");
  MediaCard = module.MediaCard;
});

const ITEM: MediaItem = {
  id: "64b7f0c2a1b2c3d4e5f60712",
  url: "https://cdn.test/media/mug.png",
  originalName: "mug.png",
  mimeType: "image/png",
  size: 1536,
  altText: "A blue mug on a desk",
  createdAt: "2026-01-05T00:00:00.000Z",
};

const NOOP = () => {};

function renderCard(overrides: Partial<MediaCardProps> = {}): string {
  const props: MediaCardProps = {
    item: ITEM,
    editor: { open: false, draft: "", saving: false, error: null },
    deleter: { confirming: false, busy: false, error: null },
    actionsDisabled: false,
    onEditAlt: NOOP,
    onAltDraftChange: NOOP,
    onSaveAlt: NOOP,
    onCancelAlt: NOOP,
    onRequestDelete: NOOP,
    onConfirmDelete: NOOP,
    onCancelDelete: NOOP,
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(MediaCard, props));
}

test("media card: shows the preview, metadata and existing alt text", () => {
  const html = renderCard();

  assert.match(html, /mug\.png/);
  assert.match(html, /src="https:\/\/cdn\.test\/media\/mug\.png"/);
  assert.match(html, /alt="A blue mug on a desk"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /1\.5 KB/);
  assert.match(html, /PNG image/);
  assert.match(html, /added Jan 5, 2026/);
  assert.match(html, /A blue mug on a desk/);
  assert.match(html, /aria-label="Edit alt text for mug\.png"/);
  assert.match(html, /aria-label="Delete mug\.png"/);
  assert.doesNotMatch(html, /storageKey|AWS_SECRET|AWS_ACCESS/i);
});

test("media card: flags missing alt text", () => {
  const html = renderCard({ item: { ...ITEM, altText: "" } });

  assert.match(
    html,
    /Missing\. Describe this image for screen readers\./,
  );
  assert.match(html, /text-amber-700/);
  // An empty alt attribute is correct for a decorative preview; the card
  // heading still identifies the file.
  assert.match(html, /alt=""/);
});

test("media card: opens the inline alt-text editor with the current value", () => {
  const html = renderCard({
    editor: {
      open: true,
      draft: "A blue mug",
      saving: false,
      error: "Alt text must be 240 characters or fewer.",
    },
  });

  assert.match(html, /id="alt-text-64b7f0c2a1b2c3d4e5f60712"/);
  assert.match(html, /value="A blue mug"/);
  assert.match(html, /maxLength="240"/);
  assert.match(html, /autofocus=""/);
  assert.match(html, /aria-label="Save alt text for mug\.png"/);
  assert.match(html, /aria-label="Cancel editing alt text for mug\.png"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Alt text must be 240 characters or fewer\./);
  assert.doesNotMatch(html, /aria-label="Delete mug\.png"/);
});

test("media card: saving alt text disables the editor controls", () => {
  const html = renderCard({
    editor: { open: true, draft: "A blue mug", saving: true, error: null },
  });

  assert.match(html, /Saving…/);
  assert.match(html, /disabled=""[^>]*aria-label="Save alt text for mug\.png"/);
  assert.match(
    html,
    /disabled=""[^>]*aria-label="Cancel editing alt text for mug\.png"/,
  );
});

test("media card: deletion requires an inline confirmation", () => {
  const html = renderCard({
    deleter: { confirming: true, busy: false, error: null },
  });

  assert.match(html, /Delete “mug\.png”/);
  assert.match(html, /be undone/);
  assert.match(html, /aria-label="Confirm deleting mug\.png"/);
  assert.match(html, /Keep image/);
  assert.match(html, /Delete image/);
  assert.doesNotMatch(html, /aria-label="Edit alt text for mug\.png"/);
});

test("media card: a failed deletion offers an explicit retry", () => {
  const html = renderCard({
    deleter: {
      confirming: true,
      busy: false,
      error:
        "The image is hidden, but the file host didn't confirm deletion. Try again to finish removing it.",
    },
  });

  assert.match(html, /Try delete again/);
  assert.match(html, /role="alert"/);
  assert.match(html, /confirm deletion/);
  assert.match(html, /aria-label="Confirm deleting mug\.png"/);
});

test("media card: a busy deletion disables the retry control", () => {
  const html = renderCard({
    deleter: { confirming: true, busy: true, error: null },
  });

  assert.match(html, /Deleting…/);
  assert.match(html, /disabled=""[^>]*aria-label="Confirm deleting mug\.png"/);
  assert.match(html, /aria-busy="true"/);
});

test("media card: conflicting actions are disabled during another save", () => {
  const html = renderCard({ actionsDisabled: true });

  assert.match(
    html,
    /disabled=""[^>]*aria-label="Edit alt text for mug\.png"/,
  );
  assert.match(html, /disabled=""[^>]*aria-label="Delete mug\.png"/);
});

