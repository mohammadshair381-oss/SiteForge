// Imported by value: the icons below are built when this module loads, and the
// unit test runner compiles JSX to React.createElement.
import React, { type ReactNode } from "react";

/** The platform's one icon set: 24px grid, 1.7 stroke, decorative (labels carry the meaning). */
const PATHS: Record<string, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7.5" height="9" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="5" rx="1.5" />
      <rect x="13.5" y="11" width="7.5" height="10" rx="1.5" />
      <rect x="3" y="15" width="7.5" height="6" rx="1.5" />
    </>
  ),
  setup: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17" />
    </>
  ),
  editor: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M15 9v11" />
    </>
  ),
  pages: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  theme: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.6-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1 .9-1.8 2-1.8h2a4 4 0 0 0 4-4c0-4.1-4-7.5-9-7.5Z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10.5" cy="7.5" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </>
  ),
  design: (
    <>
      <path d="M4 6h9M18 6h2M4 12h3M12 12h8M4 18h11M20 18h0" />
      <circle cx="15.5" cy="6" r="2.2" />
      <circle cx="9.5" cy="12" r="2.2" />
      <circle cx="17.5" cy="18" r="2.2" />
    </>
  ),
  storefront: (
    <>
      <path d="M4 9.5 5.5 4h13L20 9.5" />
      <path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" />
      <path d="M5 12v8h14v-8M10 20v-4.5h4V20" />
    </>
  ),
  navigation: <path d="M4 6h16M4 12h10M4 18h13" />,
  "ai-builder": (
    <>
      <path d="m11 3 1.9 4.9L18 10l-5.1 2.1L11 17l-1.9-4.9L4 10l5.1-2.1z" />
      <path d="m18.5 15 .9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
    </>
  ),
  products: (
    <>
      <path d="M8.5 8V6.5a3.5 3.5 0 0 1 7 0V8" />
      <path d="M5 8h14l1 13H4z" />
    </>
  ),
  proposals: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  inventory: (
    <>
      <path d="m3 8 9-5 9 5v8l-9 5-9-5z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </>
  ),
  categories: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <circle cx="17.25" cy="17.25" r="3.75" />
    </>
  ),
  coupons: (
    <>
      <path d="M3 9V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3a3 3 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a3 3 0 0 0 0-6Z" />
      <path d="M14 5v2M14 11v2M14 17v2" />
    </>
  ),
  reviews: <path d="m12 3 2.7 5.5 6 .9-4.4 4.2 1 6L12 16.8l-5.3 2.8 1-6-4.3-4.2 6-.9z" />,
  shipping: (
    <>
      <path d="M3 6.5h11V17H3zM14 10h4l3 3.2V17h-7" />
      <circle cx="7" cy="18" r="1.9" />
      <circle cx="17.5" cy="18" r="1.9" />
    </>
  ),
  insights: <path d="M4 20V11M10 20V4M16 20v-6M22 20H2" />,
  orders: (
    <>
      <path d="M8.5 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1.5" />
      <rect x="8.5" y="3" width="7" height="4" rx="1" />
      <path d="M9 12h6M9 16h4" />
    </>
  ),
  customers: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18.5 20a6.5 6.5 0 0 0-3-5.5" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.7" />
      <path d="m21 16-4.5-4.5L7.5 20" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  billing: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M3 10h18M7 15h3" />
    </>
  ),
  business: (
    <>
      <path d="M4 20V9l8-5 8 5v11" />
      <path d="M9.5 20v-6h5v6" />
    </>
  ),
  shield: <path d="M12 3l7.5 3v5.3c0 4.4-3 7.8-7.5 9.7-4.5-1.9-7.5-5.3-7.5-9.7V6z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  "arrow-left": <path d="M19 12H5M11 6l-6 6 6 6" />,
  external: <path d="M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3M14 4h6v6M20 4l-9 9" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-up": <path d="m6 15 6-6 6 6" />,
  "arrow-up": <path d="M12 19V5M6 11l6-6 6 6" />,
  "arrow-down": <path d="M12 5v14M6 13l6 6 6-6" />,
  publish: <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  "panel-left": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 4 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z" />
      <path d="M12 10v4M12 17h0" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  tablet: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  rocket: (
    <>
      <path d="M12 15 9 12c.7-3.6 3-7.6 9-9 0 6-2.700 8.700-6 12Z" />
      <path d="M9 12H5l2.500-3.500H11M12 15v4l3.500-2.500V13" />
      <path d="M6 16c-1.300 1-1.700 3-1.700 3s2-.4 3-1.700" />
    </>
  ),
  eye: (
    <>
      <path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12Z" />
      <circle cx="12" cy="12" r="2.800" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <path d="M12 7.500V12l3 2" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 12.500 9 5 9-5M3 17l9 5 9-5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.500 2.500 3.700 5.500 3.700 9s-1.200 6.500-3.700 9c-2.500-2.500-3.700-5.500-3.700-9S9.500 5.500 12 3Z" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.500 7 8.500 6 8.500-6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4.500" />
      <path d="m11.500 11.500 8-8M16 7l3 3" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  notifications: <path d="M6 9a6 6 0 0 1 12 0c0 6 2.500 7.500 2.500 7.500h-17S6 15 6 9M10 20a2.200 2.200 0 0 0 4 0" />,
  carts: <path d="M3 4h2l2.4 11h10.2L20 8H6.2M9 20h.01M17 20h.01" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.500" />
      <path d="M2.500 20a6.500 6.500 0 0 1 13 0" />
      <path d="M16 4.700a3.500 3.500 0 0 1 0 6.600M18.500 20a6.500 6.500 0 0 0-3-5.500" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className = "" }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      {PATHS[name] ?? PATHS.business}
    </svg>
  );
}

/** The icon of a business workspace section (BusinessTabs segment). */
export function SectionIcon({ segment, size, className }: { segment: string; size?: number; className?: string }) {
  return <Icon name={segment === "" ? "overview" : segment} size={size} className={className} />;
}
