import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Platform fonts: declared here, downloaded only by pages that use them, so
// storefronts (system font stacks) never pay for them.
const heading = localFont({ src: "./fonts/bricolage-grotesque.woff2", variable: "--font-heading", weight: "200 800", display: "swap", preload: false });
const ui = localFont({ src: "./fonts/instrument-sans.woff2", variable: "--font-ui", weight: "400 700", display: "swap", preload: false });

export const metadata: Metadata = {
  title: "SiteForge: build and run your online store",
  description:
    "Create a professional online store without code. Nine complete themes, a visual editor, products, orders and everything you need to sell, in one place.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${heading.variable} ${ui.variable}`}>
      <body className="bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
