import { z } from "zod";
import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getNotificationSummary, listNotifications, markNotificationsRead } from "@/lib/notifications";
import { NOTIFICATION_KINDS, type NotificationKind, type NotificationRole } from "@/models/Notification";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET ?page=&unread=1&kind=`: what this person's role may see at this store, plus their unread count. `?summary=1`: the count only. */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user, membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
    const params = new URL(request.url).searchParams;
    if (params.get("summary") === "1") {
      return ok(await getNotificationSummary({ businessId: id, userId: String(user._id), role: membership.role as NotificationRole }), { headers: { "Cache-Control": "no-store" } });
    }
    const page = Number(params.get("page"));
    const kind = params.get("kind");
    const result = await listNotifications({
      businessId: id,
      userId: String(user._id),
      role: membership.role as NotificationRole,
      page: Number.isInteger(page) && page >= 1 && page <= 1000 ? page : 1,
      unreadOnly: params.get("unread") === "1",
      kind: (NOTIFICATION_KINDS as readonly string[]).includes(kind ?? "") ? (kind as NotificationKind) : undefined,
    });
    return ok(result, { headers: { "Cache-Control": "no-store" } });
  });
}

const markSchema = z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).min(1).max(100).optional() });

/** `POST { ids? }`: marks them read for this person, or everything they can see. */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user, membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
    const { ids } = markSchema.parse(await readJson(request));
    await markNotificationsRead({ businessId: id, userId: String(user._id), role: membership.role as NotificationRole, ids });
    return ok({ read: true });
  });
}
