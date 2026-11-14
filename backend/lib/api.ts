import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DatabaseNotPreparedError, databaseNotPreparedMessage, isTransactionsUnavailableError, transactionsUnavailableMessage } from "./db-errors";
import { formatValidationError } from "./validation-messages";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string = "error",
    public headers?: Record<string, string>,
    /** Per-field messages, for a form to show beside each field. */
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function created<T>(data: T) {
  return NextResponse.json(data, { status: 201 });
}

export function fail(
  status: number,
  message: string,
  code = "error",
  headers?: Record<string, string>,
) {
  return NextResponse.json({ error: message, code }, { status, headers });
}

/**
 * Reads a JSON request body, converting a malformed/empty body into a
 * consistent 400 instead of an unhandled SyntaxError (which would surface as a
 * 500). Zod validation of the parsed value still happens at the call site and
 * keeps its own 422 status.
 */
/** Far above any form in the product; validating an unbounded body can exhaust memory. */
const MAX_JSON_BODY_CHARS = 2 * 1024 * 1024;

export async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_JSON_BODY_CHARS) {
    throw new HttpError(413, "This request is too large", "payload_too_large");
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, "Invalid JSON body", "invalid_json");
  }
  if (text.length > MAX_JSON_BODY_CHARS) {
    throw new HttpError(413, "This request is too large", "payload_too_large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body", "invalid_json");
  }
}

/**
 * Wraps a route handler so thrown HttpError/ZodError become safe JSON errors.
 * Unexpected errors are logged server-side and never leak internals.
 */
export async function handle(
  fn: () => Promise<Response> | Response,
): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.fields) return NextResponse.json({ error: error.message, code: error.code, fields: error.fields }, { status: error.status, headers: error.headers });
      return fail(error.status, error.message, error.code, error.headers);
    }
    if (error instanceof ZodError) {
      const { message, fields } = formatValidationError(error);
      return NextResponse.json({ error: message, code: "validation_error", fields }, { status: 422 });
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      return fail(409, "That record already exists", "conflict");
    }
    if (isTransactionsUnavailableError(error)) {
      console.error(JSON.stringify({ event: "transactions_unavailable", fix: "MongoDB must be a replica set: see docs/database-preparation.md" }));
      return fail(503, transactionsUnavailableMessage(process.env.NODE_ENV === "production"), "transactions_unavailable");
    }
    // dbConnect has already logged which indexes are missing.
    if (error instanceof DatabaseNotPreparedError) {
      return fail(503, databaseNotPreparedMessage(process.env.NODE_ENV === "production"), "database_not_prepared");
    }
    console.error("[api] unhandled error", error);
    return fail(500, "Internal server error", "internal_error");
  }
}
