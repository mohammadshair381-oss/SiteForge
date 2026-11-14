"use client";

/**
 * Dashboard previews render the storefront on the dashboard host, where store
 * paths (/products, /cart, /account) do not exist. This wrapper keeps the
 * preview on the page: link clicks and form submissions inside it are ignored.
 */
export default function PreviewLinkGuard({ children }: { children: React.ReactNode }) {
  return (
    <div
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest("a[href]")) event.preventDefault();
      }}
      onSubmitCapture={(event) => event.preventDefault()}
    >
      {children}
    </div>
  );
}
