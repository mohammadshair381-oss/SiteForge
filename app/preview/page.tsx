"use client";

import { useEffect, useState } from "react";

/**
 * Opens a shared draft link (`/preview#<token>`). What follows `#` never leaves the
 * browser on its own, so no server or proxy log holds it. This page hands it to the
 * server once, which stores it in a cookie only `/preview` pages receive.
 */
export default function OpenDraftPreview() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const token = window.location.hash.replace(/^#/, "");
    window.history.replaceState(null, "", window.location.pathname);
    fetch("/api/preview/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then((response) => {
        if (response.ok) window.location.replace("/preview/view");
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem", textAlign: "center" }}>
      {failed ? (
        <p role="alert">This preview link has expired or been turned off. Ask for a new one.</p>
      ) : (
        <p role="status">Opening the preview…</p>
      )}
    </main>
  );
}
