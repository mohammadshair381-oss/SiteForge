import React from "react";
import type { ThemeId } from "@/lib/constants";
import { getThemeMeta } from "@/lib/themes";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";

/**
 * A schematic picture of a theme's layout for theme pickers: page colour,
 * header arrangement, hero composition and product-card proportions, all read
 * from the theme's own skin (themes/skins/<id>.ts), so the thumbnail can never
 * drift from the real design. Decorative: the picker labels carry the name.
 */
export default function ThemeThumbnail({ themeId, primary, accent, className = "" }: { themeId: ThemeId; primary?: string; accent?: string; className?: string }) {
  const skin = STORE_SKINS[themeId];
  const meta = getThemeMeta(themeId);
  const bg = meta.palette[0];
  const brand = primary ?? meta.palette[1];
  const second = accent ?? meta.palette[2];
  const ink = skin.dark ? "rgba(255,255,255,0.85)" : "rgba(17,17,17,0.82)";
  const faint = skin.dark ? "rgba(255,255,255,0.12)" : "rgba(17,17,17,0.1)";
  const card = skin.dark ? "rgba(255,255,255,0.08)" : "rgba(17,17,17,0.08)";
  const { header, hero, card: cardVariant } = skin.layout;
  const line = (width: string, height = 3, color = ink, extra: React.CSSProperties = {}) => (
    <span style={{ display: "block", width, height, borderRadius: 2, background: color, ...extra }} />
  );
  const round = skin.button.includes("rounded-none") ? 0 : skin.button.includes("rounded-full") ? 99 : 3;
  // The widest column count of the theme's product grid.
  const cards = Math.max(...[...skin.grid.matchAll(/grid-cols-(\d)/g)].map((m) => Number(m[1])));
  const aspect = skin.media.includes("3/4") ? "3 / 4" : skin.media.includes("4/5") ? "4 / 5" : "1 / 1";

  const headerNode =
    header === "centered" || header === "signboard" ? (
      <div style={{ padding: "5px 8px 3px", borderBottom: `1px solid ${faint}`, display: "grid", justifyItems: "center", gap: 3 }}>
        {line("28%", 4)}
        <div style={{ display: "flex", gap: 4 }}>{[0, 1, 2, 3].map((i) => <span key={i}>{line("10px", 2, faint)}</span>)}</div>
      </div>
    ) : header === "marketplace" || header === "grocer" ? (
      <div style={{ borderBottom: `1px solid ${faint}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 8px" }}>
          {line("12%", 4)}
          <span style={{ flex: 1, height: 7, borderRadius: 99, background: faint }} />
          <span style={{ width: 7, height: 7, borderRadius: 99, background: brand }} />
        </div>
        <div style={{ display: "flex", gap: 5, padding: "0 8px 4px" }}>{[0, 1, 2, 3, 4].map((i) => <span key={i}>{line("12px", 2, faint)}</span>)}</div>
      </div>
    ) : (
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: header === "minimal" ? "4px 8px" : "6px 8px", borderBottom: `1px solid ${faint}` }}>
        {line(header === "minimal" ? "14%" : "16%", header === "minimal" ? 2 : 4)}
        <div style={{ display: "flex", gap: 4, marginLeft: 6 }}>{[0, 1, 2].map((i) => <span key={i}>{line("9px", 2, faint)}</span>)}</div>
        <span style={{ marginLeft: "auto", width: 6, height: 6, borderRadius: 99, background: brand }} />
      </div>
    );

  const photo = `linear-gradient(135deg, ${brand}, ${second})`;
  const textLines = (color = ink, align: "flex-start" | "center" = "flex-start") => (
    <div style={{ display: "grid", gap: 3, justifyItems: align }}>
      {line("60%", 5, color)}
      {line("42%", 5, color)}
      {line("30%", 2, color, { opacity: 0.6, marginTop: 2 })}
      <span style={{ marginTop: 3, width: 22, height: 7, borderRadius: round, background: brand }} />
    </div>
  );

  let heroNode: React.ReactNode;
  switch (hero) {
    case "immersive":
    case "campaign":
      heroNode = (
        <div style={{ height: "48%", background: photo, display: "flex", alignItems: "flex-end", justifyContent: hero === "campaign" ? "center" : "flex-start", padding: 8 }}>
          {textLines("rgba(255,255,255,0.92)", hero === "campaign" ? "center" : "flex-start")}
        </div>
      );
      break;
    case "statement":
      heroNode = (
        <div style={{ display: "flex", gap: 8, padding: 8, height: "42%", alignItems: "flex-end" }}>
          <div style={{ flex: 1.4, display: "grid", gap: 3 }}>
            {line("95%", 8)}
            {line("75%", 8)}
            <span style={{ width: 22, height: 7, background: brand }} />
          </div>
          <div style={{ flex: 1, height: "100%", position: "relative" }}>
            <span style={{ position: "absolute", inset: 0, transform: "translate(3px,3px)", background: brand }} />
            <span style={{ position: "absolute", inset: 0, background: faint, border: `1.5px solid ${ink}` }} />
          </div>
        </div>
      );
      break;
    case "arch":
      heroNode = (
        <div style={{ display: "flex", gap: 8, padding: 8, height: "44%", alignItems: "center" }}>
          <div style={{ flex: 1 }}>{textLines()}</div>
          <span style={{ width: "34%", height: "100%", borderRadius: "999px 999px 0 0", background: photo }} />
        </div>
      );
      break;
    case "panel":
      heroNode = (
        <div style={{ display: "flex", gap: 4, padding: "6px 8px", height: "40%" }}>
          <div style={{ flex: 2, borderRadius: 5, background: photo, padding: 7, display: "flex", alignItems: "center" }}>{textLines("rgba(255,255,255,0.92)")}</div>
          <div style={{ flex: 1, display: "grid", gap: 4 }}>
            <span style={{ borderRadius: 5, background: card }} />
            <span style={{ borderRadius: 5, background: card }} />
          </div>
        </div>
      );
      break;
    case "editorial":
      heroNode = (
        <div style={{ display: "flex", gap: 8, padding: 8, height: "44%" }}>
          <div style={{ flex: 1.4, display: "grid", gap: 3, alignContent: "start" }}>
            {line("90%", 6, ink, { opacity: 0.85 })}
            {line("70%", 6, ink, { opacity: 0.85 })}
            {line("40%", 2, faint, { marginTop: 3 })}
          </div>
          <span style={{ flex: 1, marginTop: "14%", background: photo }} />
        </div>
      );
      break;
    case "spotlight":
      heroNode = (
        <div style={{ position: "relative", display: "flex", gap: 8, padding: 8, height: "44%", alignItems: "center", backgroundImage: `linear-gradient(${faint} 1px, transparent 1px), linear-gradient(90deg, ${faint} 1px, transparent 1px)`, backgroundSize: "8px 8px" }}>
          <div style={{ flex: 1 }}>{textLines()}</div>
          <span style={{ width: "38%", height: "80%", borderRadius: 6, background: photo, boxShadow: `0 0 18px ${second}` }} />
        </div>
      );
      break;
    case "banner":
      heroNode = (
        <div style={{ margin: "6px 8px", height: "38%", borderRadius: 8, background: `${brand}22`, display: "flex", gap: 6, padding: 7, alignItems: "center" }}>
          <div style={{ flex: 1 }}>{textLines()}</div>
          <span style={{ width: "36%", height: "100%", borderRadius: 6, background: photo }} />
        </div>
      );
      break;
    case "room":
    default:
      heroNode = (
        <div style={{ position: "relative", margin: "6px 8px 0", height: "42%", background: photo }}>
          <div style={{ position: "absolute", left: 6, bottom: 6, width: "48%", background: bg, padding: 5 }}>{textLines()}</div>
        </div>
      );
  }

  return (
    <div
      aria-hidden="true"
      data-thumb={themeId}
      className={`relative aspect-[16/10] w-full overflow-hidden rounded-lg ring-1 ring-black/10 ${className}`}
      style={{ background: bg, fontSize: 0 }}
    >
      {headerNode}
      {heroNode}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cards}, minmax(0, 1fr))`, gap: cardVariant === "menu" ? 4 : 3, padding: "6px 8px" }}>
        {Array.from({ length: cards }, (_, i) =>
          cardVariant === "menu" ? (
            <span key={i} style={{ display: "flex", gap: 3, alignItems: "center", padding: 3, borderRadius: 4, background: card }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: photo }} />
              {line("60%", 2)}
            </span>
          ) : (
            <span key={i} style={{ display: "grid", gap: 2 }}>
              <span style={{ aspectRatio: aspect, borderRadius: skin.media === "aspect-square" && round ? 3 : 0, background: card }} />
              {line("70%", 2, faint)}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
