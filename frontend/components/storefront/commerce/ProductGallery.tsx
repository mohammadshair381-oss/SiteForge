"use client";

import { useEffect, useId, useRef, useState } from "react";
import { subscribeVariantImage } from "@/lib/variant-image-event";

/**
 * Product image gallery: the selected image large, the others as thumbnail
 * buttons (keyboard and screen-reader friendly; the selected one is
 * `aria-pressed`). Switching crossfades the image (off with reduced motion).
 * Fixed proportions, so nothing shifts while images load.
 */
export default function ProductGallery({
  images,
  name,
  alt,
  frameClass,
  thumbClass,
  placeholder,
  productId,
}: {
  /** Follow the chosen variant's own picture (variant products). */
  productId?: string;
  images: string[];
  name: string;
  /** Owner-written alt text for the first image (default: the product name). */
  alt?: string;
  /** Classes for the large image frame (proportion, radius, background). */
  frameClass: string;
  thumbClass: string;
  /** Shown when the product has no image. */
  placeholder: React.ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const labelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // A chosen variant's own picture takes the large frame until a thumbnail is picked.
  const [variantImage, setVariantImage] = useState("");
  useEffect(() => {
    const target = rootRef.current?.ownerDocument;
    if (!target || !productId) return;
    return subscribeVariantImage(target, productId, setVariantImage);
  }, [productId]);
  const current = variantImage || images[index] || images[0];

  return (
    <div ref={rootRef} className="space-y-3">
      <div className={`overflow-hidden ${frameClass}`}>
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={current} src={current} alt={variantImage ? name : index === 0 ? alt || name : `${name}, image ${index + 1} of ${images.length}`} className="sf-fade h-full w-full object-cover" />
        ) : (
          placeholder
        )}
      </div>
      {images.length > 1 && (
        <div role="group" aria-labelledby={labelId}>
          <p id={labelId} className="sr-only">Product images</p>
          <ul className="grid grid-cols-5 gap-2 sm:gap-3">
            {images.map((src, i) => (
              <li key={src}>
                <button
                  type="button"
                  aria-pressed={!variantImage && i === index}
                  aria-label={`Show image ${i + 1} of ${images.length}`}
                  onClick={() => {
                    setVariantImage("");
                    setIndex(i);
                  }}
                  className={`block aspect-square w-full overflow-hidden transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-2 ${thumbClass} ${
                    !variantImage && i === index ? "opacity-100 ring-2 ring-current" : "opacity-70 hover:opacity-100"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
