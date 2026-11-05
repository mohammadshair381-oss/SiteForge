import { signSession, type SessionClaims } from "@/lib/auth/tokens";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { setRequestCookiesFromHeader, clearRequestCookies } from "./mock-next-headers-setup";

export interface AuthHeaders {
  cookie: string;
}

export async function createAuthHeaders(claims: SessionClaims): Promise<AuthHeaders> {
  const token = await signSession(claims);
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

export async function createAuthHeadersForUser(
  userId: string,
  platformRole: "user" | "super_admin" = "user",
  tokenVersion = 0,
): Promise<AuthHeaders> {
  return createAuthHeaders({ userId, platformRole, tokenVersion });
}

export function addAuthHeaders(
  init: RequestInit,
  authHeaders: AuthHeaders,
): RequestInit {
  const existingHeaders = init.headers as Record<string, string> | undefined;
  const existingCookie = existingHeaders?.cookie ?? existingHeaders?.Cookie ?? "";
  const combinedCookie = existingCookie
    ? `${existingCookie}; ${authHeaders.cookie}`
    : authHeaders.cookie;

  return {
    ...init,
    headers: {
      ...existingHeaders,
      cookie: combinedCookie,
    },
  };
}

export function makeRequest(
  url: string,
  body: unknown,
  init: RequestInit = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    body: JSON.stringify(body),
  });
}

export function makeAuthenticatedRequest(
  url: string,
  body: unknown,
  authHeaders: AuthHeaders,
  init: RequestInit = {},
): Request {
  return makeRequest(url, body, addAuthHeaders(init, authHeaders));
}

/**
 * Calls a route handler with automatic cookie header parsing for the mock.
 *
 * Supports both:
 * - Routes without params: (request: Request) => Promise<Response>
 * - App Router dynamic routes: (request: Request, context: { params: Promise<...> }) => Promise<Response>
 *
 * The context overloads stay generic so each dynamic route keeps its own
 * `params` shape instead of being widened to a single shared type.
 */
export async function callHandler<R>(
  handler: (request: Request) => Promise<R>,
  request: Request,
): Promise<R>;
export async function callHandler<C, R>(
  handler: (request: Request, context: C) => Promise<R>,
  request: Request,
  context: C,
): Promise<R>;
export async function callHandler<R>(
  handler: (request: Request, context?: unknown) => Promise<R>,
  request: Request,
  context?: unknown,
): Promise<R> {
  const cookieHeader = request.headers.get("cookie");
  const { setRequestCookiesFromHeader, clearRequestCookies } = await import("./mock-next-headers-setup");
  setRequestCookiesFromHeader(cookieHeader);
  try {
    if (context !== undefined) {
      return await handler(request, context);
    }
    return await handler(request);
  } finally {
    clearRequestCookies();
  }
}