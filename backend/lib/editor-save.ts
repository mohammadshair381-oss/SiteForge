import { apiErrorFrom } from "@/lib/api-errors";
export interface EditorSaveResponse {
  page?: { version?: number };
  [key: string]: unknown;
}

export class EditorSaveError extends Error {
  constructor(
    message: string,
    readonly stage: "page" | "theme",
    readonly status: number | undefined,
    readonly pageSaved: boolean,
    readonly response?: EditorSaveResponse,
    /** The server's error code (e.g. `review_required`, `placeholders_remaining`). */
    readonly code?: string,
    /** The server's per-field messages, keyed by path such as `sections.2.content.title`. */
    readonly fields?: Record<string, string>,
    /** How long the server asked to wait before trying again (a 429's `Retry-After`). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EditorSaveError";
  }
}

interface SavePageBackedEditorInput {
  businessId: string;
  pageId: string;
  pagePayload: Record<string, unknown>;
  themeId: string;
  savedThemeId: string;
  font: string;
  savedFont: string;
  fetcher?: typeof fetch;
}

async function patchJson(
  fetcher: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  stage: "page" | "theme",
  previousResponse?: EditorSaveResponse,
): Promise<EditorSaveResponse> {
  let response: Response;
  let data: EditorSaveResponse;

  try {
    response = await fetcher(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await response.json();
    data =
      parsed && typeof parsed === "object"
        ? (parsed as EditorSaveResponse)
        : {};
  } catch (error) {
    throw new EditorSaveError(
      error instanceof Error ? error.message : "Unable to save changes",
      stage,
      undefined,
      stage === "theme",
      previousResponse,
    );
  }

  if (!response.ok) {
    const retryAfterSeconds = Number(response.headers.get("Retry-After"));
    throw new EditorSaveError(
      typeof data.error === "string" ? data.error : "Unable to save changes",
      stage,
      response.status,
      stage === "theme",
      previousResponse,
      typeof (data as { code?: unknown }).code === "string" ? (data as { code: string }).code : undefined,
      apiErrorFrom(data as { fields?: unknown }, "").fields,
      retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined,
    );
  }

  return data;
}

export async function savePageBackedEditorChanges({
  businessId,
  pageId,
  pagePayload,
  themeId,
  savedThemeId,
  font,
  savedFont,
  fetcher = fetch,
}: SavePageBackedEditorInput): Promise<EditorSaveResponse> {
  const pageResponse = await patchJson(
    fetcher,
    `/api/businesses/${businessId}/pages/${pageId}`,
    pagePayload,
    "page",
  );

  const businessUpdate: Record<string, unknown> = {};
  if (themeId !== savedThemeId) businessUpdate.themeId = themeId;
  if (font !== savedFont) businessUpdate.themeSettings = { font };

  if (Object.keys(businessUpdate).length > 0) {
    await patchJson(
      fetcher,
      `/api/businesses/${businessId}`,
      businessUpdate,
      "theme",
      pageResponse,
    );
  }

  return pageResponse;
}
