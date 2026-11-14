/**
 * Tells a product page's images which variant was chosen (browser only). The option picker
 * and the images are separate parts of a server-rendered page, each arranged by the theme.
 * Uses the element's own document, because the store can be shown inside a preview frame.
 */
const EVENT = "siteforge:variant-image";

export function publishVariantImage(target: Document, productId: string, url: string): void {
  target.dispatchEvent(new CustomEvent(EVENT, { detail: { productId, url } }));
}

/** Calls back with the chosen variant's image, or "" for the product's own. Returns the unsubscribe. */
export function subscribeVariantImage(target: Document, productId: string, listener: (url: string) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ productId: string; url: string }>).detail;
    if (detail?.productId === productId) listener(detail.url);
  };
  target.addEventListener(EVENT, handler);
  return () => target.removeEventListener(EVENT, handler);
}
