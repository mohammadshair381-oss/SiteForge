import assert from "node:assert/strict";
import test, { before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { MediaItem } from "../../backend/lib/media-client";

// TSX in this test runner compiles to classic React.createElement calls.
(globalThis as unknown as { React?: typeof React }).React = React;

type CardComponent = (props: {
  item: MediaItem;
  selected: boolean;
  onSelect: (item: MediaItem) => void;
}) => React.ReactElement;

type PickerComponent = (props: {
  businessId: string;
  selectedUrl?: string;
  onSelect: (selection: unknown) => void;
  allowClear?: boolean;
  disabled?: boolean;
}) => React.ReactElement;

let MediaPickerCard: CardComponent;
let MediaPicker: PickerComponent;

before(async () => {
  const module = await import("../../frontend/components/dashboard/MediaPicker");
  MediaPickerCard = module.MediaPickerCard;
  MediaPicker = module.default;
});

const ITEM: MediaItem = {
  id: "64b7f0c2a1b2c3d4e5f60712",
  url: "https://cdn.test/media/64b7f0c2a1b2c3d4e5f60712/mug.png",
  originalName: "mug.png",
  mimeType: "image/png",
  size: 1536,
  altText: "A blue mug on a desk",
  createdAt: "2026-01-05T00:00:00.000Z",
};

const NOOP = () => {};

function renderCard(overrides: Partial<Parameters<CardComponent>[0]> = {}): string {
  return renderToStaticMarkup(
    React.createElement(MediaPickerCard, {
      item: ITEM,
      selected: false,
      onSelect: NOOP,
      ...overrides,
    }),
  );
}

test("MediaPickerCard: shows filename and alt text without leaking storage keys", () => {
  const html = renderCard();

  assert.match(html, /mug\.png/);
  assert.match(html, /A blue mug on a desk/);
  assert.match(html, /aria-pressed="false"/);
  assert.doesNotMatch(html, /storageKey|AWS_SECRET|AWS_ACCESS/i);
});

test("MediaPickerCard: marks the selected image accessibly", () => {
  const html = renderCard({ selected: true });

  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Selected/);
});

test("MediaPickerCard: labels a missing alt text instead of rendering an empty string", () => {
  const html = renderCard({ item: { ...ITEM, altText: "" } });

  assert.match(html, /No alt text/);
});

test("MediaPicker: renders a dialog trigger without opening on first paint", () => {
  const html = renderToStaticMarkup(
    React.createElement(MediaPicker, {
      businessId: "biz-1",
      onSelect: NOOP,
    }),
  );

  assert.match(html, /Choose from media library/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("MediaPicker: an existing selection offers change and clear actions", () => {
  const html = renderToStaticMarkup(
    React.createElement(MediaPicker, {
      businessId: "biz-1",
      selectedUrl: ITEM.url,
      onSelect: NOOP,
      allowClear: true,
    }),
  );

  assert.match(html, /Change image/);
  assert.match(html, /Remove image/);
  assert.doesNotMatch(html, /Choose from media library/);
});
