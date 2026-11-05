import type { Metadata } from "next";
import type { ReactNode } from "react";

// The middleware also sends X-Robots-Tag and Referrer-Policy on these addresses.
export const metadata: Metadata = {
  title: "Draft preview",
  robots: { index: false, follow: false, nocache: true, noarchive: true },
  referrer: "no-referrer",
};

export default function PreviewLayout({ children }: { children: ReactNode }) {
  return children;
}
