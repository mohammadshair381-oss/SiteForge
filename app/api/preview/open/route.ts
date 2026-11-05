import { handle, ok, HttpError, readJson } from "@/lib/api";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { PREVIEW_COOKIE, PREVIEW_COOKIE_MAX_AGE } from "@/lib/preview-link-options";
import { resolvePreviewLink } from "@/lib/preview-links";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * `POST { token }` swaps a draft link's token for a cookie only `/preview` pages
 * receive. The token is checked again on every page, so revoking a link or its
 * expiry still takes effect at once. An invalid link is a plain 404, whichever it is.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    await enforceRateLimit({ key: `preview-open:ip:${getClientIp(request)}`, limit: 30, windowMs: 15 * 60 * 1000 });
    const body = (await readJson(request)) as { token?: unknown };
    if (!(await resolvePreviewLink(body?.token))) throw new HttpError(404, "Not found", "not_found");
    const response = ok({ opened: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set({
      name: PREVIEW_COOKIE,
      value: String(body.token),
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/preview",
      maxAge: PREVIEW_COOKIE_MAX_AGE,
    });
    return response;
  });
}
