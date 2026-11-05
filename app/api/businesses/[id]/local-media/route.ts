import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { Media } from "@/models/Media";
import { localExists, localRemove, getContentType, localMediaUrl } from "@/lib/local-storage";
import { Business } from "@/models/Business";
import { isValidObjectId } from "@/lib/ids";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Public, unauthenticated image read for local development storage. It must never
 * change data: a missing file is only a 404, because on any other storage the file
 * is never on this disk, and a visitor could otherwise delete a store's media.
 */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    if (process.env.LOCAL_MEDIA_ENABLED !== "true" || process.env.NODE_ENV === "production") {
      throw new HttpError(404, "Media not found", "not_found");
    }
    const { id } = await context.params;
    if (!isValidObjectId(id)) throw new HttpError(404, "Media not found", "not_found");
    const { searchParams } = new URL(request.url);
    const encodedKey = searchParams.get("key");
    if (!encodedKey) throw new HttpError(400, "Missing key parameter", "missing_key");

    // Decode the key (base64 encoded in the URL)
    let key: string;
    try {
      key = Buffer.from(encodedKey, "base64").toString("utf8");
    } catch {
      throw new HttpError(400, "Invalid key encoding", "invalid_key");
    }

    await dbConnect();

    // Find the media record: must belong to this business, not deleted.
    // Tenant isolation is enforced by the business filter below;
    // no requireBusinessRole guard is needed since the query itself
    // guarantees the media record belongs to the business ID in the URL.
    const media = await Media.findOne({
      business: id,
      storageKey: key,
      deletedAt: null,
    }).lean();
    if (!media) throw new HttpError(404, "Media not found", "not_found");

    // Verify the business is published. Unpublished or suspended businesses
    // must follow the existing storefront access policy (per lib/tenant.ts
    // getPublicStorefront). This check aligns the local-media serving route
    // with the same publication gate used for public storefront access.
    const business = await Business.findById(id);
    if (!business || business.status !== "published") {
      throw new HttpError(404, "Media not found", "not_found");
    }

    // Verify tenant ownership: the route businessId must match the media's business
    // (already guaranteed by the find query above)

    // Check if the file exists locally
    const exists = await localExists(key);
    if (!exists) {
      throw new HttpError(404, "Media file missing on disk", "file_missing");
    }

    // Read the file buffer
    const filePath = join(process.cwd(), "media-dev", key);
    let buf: Buffer;
    try {
      buf = await readFile(filePath);
    } catch {
      throw new HttpError(404, "Media file missing on disk", "file_missing");
    }

    // Determine content type
    const contentType = getContentType(key);

    // Build headers with string values (required by NextResponse/Headers)
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": buf.length.toString(),
    };

    // Build the response using NextResponse with proper types
    const res = new NextResponse(
      Buffer.from(buf),
      {
        status: 200,
        headers: headers as HeadersInit,
      }
    );
    return res;
  });
}

/** Route context type local */
interface RouteContext {
  params: Promise<{ id: string }>;
}