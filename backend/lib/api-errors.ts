/**
 * Reading an API error in a form (safe for client components). The server's `handle()`
 * answers `{ error, code, fields }`. Messages are written for people, so they can be
 * shown as they are; `fields` is keyed by the field's path, such as `shippingAddress.city`.
 */
export interface ApiErrorInfo {
  message: string;
  code: string | null;
  fields: Record<string, string>;
}

export async function readApiError(response: Response, fallback: string): Promise<ApiErrorInfo> {
  const data = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown; fields?: unknown } | null;
  return apiErrorFrom(data, fallback);
}

export function apiErrorFrom(data: { error?: unknown; code?: unknown; fields?: unknown } | null | undefined, fallback: string): ApiErrorInfo {
  const fields: Record<string, string> = {};
  if (data?.fields && typeof data.fields === "object") {
    for (const [key, value] of Object.entries(data.fields)) {
      if (typeof value === "string" && value) fields[key] = value;
    }
  }
  return {
    message: typeof data?.error === "string" && data.error ? data.error : fallback,
    code: typeof data?.code === "string" ? data.code : null,
    fields,
  };
}

/**
 * The message for a form's general error area. Once every problem is shown beside its
 * field, the summary only has to point at them; anything else keeps the full message.
 */
export function summaryMessage(info: ApiErrorInfo, shownFields: readonly string[]): string {
  const keys = Object.keys(info.fields);
  return keys.length > 0 && keys.every((key) => shownFields.includes(key)) ? "Please correct the highlighted fields." : info.message;
}

/** The accessibility attributes that tie an input to its message from `FieldError`. */
export function invalidProps(fields: Record<string, string | undefined>, name: string, idPrefix: string): { "aria-invalid"?: true; "aria-describedby"?: string } {
  return fields[name] ? { "aria-invalid": true, "aria-describedby": fieldErrorId(idPrefix, name) } : {};
}

export const fieldErrorId = (idPrefix: string, name: string) => `${idPrefix}-${name.replace(/[^a-zA-Z0-9]+/g, "-")}-error`;
