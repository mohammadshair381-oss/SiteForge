"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeVariantImage } from "@/lib/variant-image-event";

/**
 * The first image in the themes that stack their product images. It shows the chosen
 * variant's own image when it has one, and the product's otherwise. The page's other images
 * stay as they are, so each theme keeps its layout.
 */
export default function VariantImage({ productId, src, alt, className, loading }: { productId: string; src: string; alt: string; className?: string; loading?: "eager" | "lazy" }) {
  const ref = useRef<HTMLImageElement>(null);
  const [override, setOverride] = useState("");

  useEffect(() => {
    const target = ref.current?.ownerDocument;
    if (!target) return;
    return subscribeVariantImage(target, productId, setOverride);
  }, [productId]);

  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={ref} src={override || src} alt={alt} loading={loading} className={className} />;
}
