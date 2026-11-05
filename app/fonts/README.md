# Platform fonts

Self-hosted so the Content Security Policy (`font-src 'self'`) stays unchanged
and no request leaves for a font service. A browser downloads a face only when
the page uses it.

Platform pages (`.app-surface`):

- `bricolage-grotesque.woff2`: Bricolage Grotesque (variable, Latin), SIL Open Font License 1.1.
- `instrument-sans.woff2`: Instrument Sans (variable, Latin), SIL Open Font License 1.1.

Storefront themes (`theme-*.woff2`, all variable, Latin, SIL Open Font License 1.1,
declared in `app/globals.css`):

- Sora (Aurora), Plus Jakarta Sans (Market), Fraunces (Bistro), Hanken Grotesk
  (Studio, Atelier text), Archivo (Launch), Bodoni Moda (Atelier), Space Grotesk
  (Volt), Nunito (Harvest), Newsreader (Forma).
