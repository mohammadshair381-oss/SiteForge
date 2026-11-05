import { dbConnect } from "@/lib/db";
import { handle, ok, created, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertCanChangeLiveWebsite } from "@/lib/publish-gates";
import { assertCanAddPages, withPageCapacity } from "@/lib/usage-limits";
import { Page } from "@/models/Page";
import { Business } from "@/models/Business";
import { pageCreateSchema, normalizePageSlug } from "@/lib/validation";
import { assertSectionMediaOwned } from "@/lib/media-references";
import { uniquePageSlug } from "@/lib/page-operations";
import { findPlaceholders } from "@/lib/page-presets";
import { buildPageTemplate } from "@/lib/page-templates";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";

const PAGE_WRITE_WINDOW_MS = 15 * 60 * 1000;
const PAGE_WRITE_MAX_PER_IP = 20;

interface RouteContext { params: Promise<{ id: string }>; }

export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    await dbConnect();
    const pages = await Page.find({ business: id }).sort({ isHome: -1, createdAt: 1 }).lean();
    return ok({ pages });
  });
}

export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();

    const ip = getClientIp(request);
    await enforceRateLimit({
      key: `pages:create:${id}:${ip ?? "shared"}`,
      windowMs: PAGE_WRITE_WINDOW_MS,
      limit: PAGE_WRITE_MAX_PER_IP,
    });

    const body = pageCreateSchema.parse(await readJson(request));
    const business = await Business.findById(id);
    if (!business) throw new HttpError(404, "Business not found", "not_found");

    if (body.sections) {
      await assertSectionMediaOwned(id, body.sections);
    }

    const wanted = body.slug ? normalizePageSlug(body.slug) : normalizePageSlug(body.title);
    if (!wanted) throw new HttpError(400, "Invalid slug", "invalid_slug");
    // An address the owner typed must be free; one made from the title finds a free one.
    if (body.slug && (await Page.exists({ business: id, slug: wanted }))) {
      throw new HttpError(409, `Another page already uses the address /${wanted}.`, "slug_taken");
    }
    const slug = body.slug ? wanted : await uniquePageSlug(id, wanted);

    // A starting layout. Its [[placeholders]] must be replaced before publishing.
    const templateSections = !body.sections && body.template ? buildPageTemplate(body.template, business) : null;

    // If this is the first page or explicitly home, handle homepage uniqueness
    const existingCount = await Page.countDocuments({ business: id });
    // A page from a template (the Pages screen) is an extra page: making it the
    // homepage replaces the store homepage, so that stays the owner's explicit choice.
    const isHome = body.isHome ?? (existingCount === 0 && !body.template);
    // Replacing the Home page changes what a live store shows at once.
    if (body.isHome === true) await assertCanChangeLiveWebsite(business, user);

    // Refuse before anything changes. Creating the page below checks again, exactly.
    if (!isHome) await assertCanAddPages(id);

    if (isHome) {
      // Unset any existing homepage
      await Page.updateMany({ business: id, isHome: true }, { $set: { isHome: false } });
    }

    const fields = {
      business: id,
      title: body.title,
      slug,
      sections: body.sections ?? templateSections ?? [],
      isHome,
      seoTitle: body.seoTitle ?? "",
      seoDescription: body.seoDescription ?? "",
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(templateSections && findPlaceholders(templateSections).length > 0
        ? { generated: { key: `template-${body.template}-${Date.now().toString(36)}`, source: "template", preset: "template", needsReview: false, createdAt: new Date() } }
        : {}),
      status: "draft",
    };
    // The homepage never counts towards the limit.
    const page = isHome
      ? await Page.create(fields)
      : (await withPageCapacity(id, 1, (session) => Page.create([fields], { session })))[0];

    return created({ page: page.toJSON() });
  });
}