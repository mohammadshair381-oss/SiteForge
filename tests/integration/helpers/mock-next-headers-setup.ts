/**
 * Test setup for mocking next/headers.
 * Import this FIRST before any route handlers.
 */

import { createRequire } from "node:module";

interface MockCookie {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

// The cookie state is stored on globalThis so that, even when this module is
// evaluated more than once under tsx (the `--import` preload vs. a test file's
// own import), every copy shares the same state. Without this, a test importing
// getMockCookieStore() could read an empty map while the route handler under
// test writes to a different copy.
const sharedMockState = globalThis as unknown as {
  __mockCookieStore?: Map<string, MockCookie>;
  __mockRequestCookies?: Map<string, MockCookie> | null;
  __mockRequestHeaders?: Record<string, string> | null;
};

const mockCookieStore: Map<string, MockCookie> =
  sharedMockState.__mockCookieStore ??
  (sharedMockState.__mockCookieStore = new Map());

function getRequestCookies(): Map<string, MockCookie> | null {
  return sharedMockState.__mockRequestCookies ?? null;
}

function setRequestCookies(cookies: Map<string, MockCookie> | null): void {
  sharedMockState.__mockRequestCookies = cookies;
}

const mockCookieStoreMethods = {
  get(name: string) {
    // First check current request's cookies (from Cookie header)
    const requestCookies = getRequestCookies();
    if (requestCookies && requestCookies.has(name)) {
      return requestCookies.get(name);
    }
    // Fall back to explicitly set cookies
    const cookie = mockCookieStore.get(name);
    return cookie ? { name: cookie.name, value: cookie.value } : undefined;
  },

  set(name: string, value: string, options?: Record<string, unknown>) {
    mockCookieStore.set(name, { name, value, options });
  },

  delete(name: string) {
    mockCookieStore.delete(name);
    getRequestCookies()?.delete(name);
  },

  getAll() {
    const all = new Map<string, MockCookie>();
    // Merge request cookies with set cookies (set cookies take precedence)
    const requestCookies = getRequestCookies();
    if (requestCookies) {
      for (const [name, cookie] of requestCookies) {
        all.set(name, cookie);
      }
    }
    for (const [name, cookie] of mockCookieStore) {
      all.set(name, cookie);
    }
    return Array.from(all.values());
  },

  has(name: string) {
    return Boolean(getRequestCookies()?.has(name)) || mockCookieStore.has(name);
  },

  clear() {
    mockCookieStore.clear();
  },

  // Internal method to set current request cookies
  _setRequestCookies(cookies: Map<string, MockCookie>) {
    setRequestCookies(cookies);
  },

  _clearRequestCookies() {
    setRequestCookies(null);
  },
};

async function mockCookies() {
  return mockCookieStoreMethods;
}

async function mockHeaders() {
  // Empty unless a test opts in with setMockRequestHeaders (e.g. a Host header
  // for server components that resolve the storefront from it).
  return new Headers(sharedMockState.__mockRequestHeaders ?? {});
}

// Monkey-patch next/headers in the require cache BEFORE any other imports
const require = createRequire(import.meta.url);
const nextHeadersPath = require.resolve("next/headers");

const mockModule = {
  cookies: mockCookies,
  headers: mockHeaders,
};

require.cache[nextHeadersPath] = {
  id: nextHeadersPath,
  filename: nextHeadersPath,
  loaded: true,
  exports: mockModule,
  parent: null,
  children: [],
  isPreloading: false,
  path: nextHeadersPath,
  paths: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  require: require as any,
} as NodeModule;

export function resetMockCookieStore(): void {
  mockCookieStore.clear();
  setRequestCookies(null);
}

export function getMockCookieStore(): Map<string, MockCookie> {
  return mockCookieStore;
}

export function setRequestCookiesFromHeader(cookieHeader: string | null): void {
  const cookies = new Map<string, MockCookie>();
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const [name, ...valueParts] = part.trim().split("=");
      if (name && valueParts.length > 0) {
        cookies.set(name, { name, value: valueParts.join("=") });
      }
    }
  }
  setRequestCookies(cookies);
}

export function clearRequestCookies(): void {
  setRequestCookies(null);
}

/** Headers returned by the mocked `headers()`; pass null to restore the empty default. */
export function setMockRequestHeaders(headers: Record<string, string> | null): void {
  sharedMockState.__mockRequestHeaders = headers;
}

export {};
