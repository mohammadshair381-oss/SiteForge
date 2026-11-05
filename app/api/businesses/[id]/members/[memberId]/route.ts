import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { assertObjectId } from "@/lib/ids";
import { requireBusinessRole } from "@/lib/auth/guards";
import { runSerializedMembershipMutation } from "@/lib/membership-transaction";
import { membershipRoleUpdateSchema } from "@/lib/validation";
import { Membership } from "@/models/Membership";
import { Business } from "@/models/Business";

interface RouteContext {
  params: Promise<{ id: string; memberId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, memberId } = await context.params;
    const { user, membership: actor } = await requireBusinessRole(id, ["owner"]);
    const mid = assertObjectId(memberId, "member id");
    const body = membershipRoleUpdateSchema.parse(await readJson(request));
    await dbConnect();

    const target = await Membership.findOne({ _id: mid, business: id });
    if (!target) throw new HttpError(404, "Member not found", "not_found");

    if (target.user && target.user.equals(user._id)) {
      throw new HttpError(
        400,
        "You cannot change your own membership role",
        "cannot_modify_self",
      );
    }

    const updated = await runSerializedMembershipMutation(
      actor.business,
      actor._id,
      async (session) => {
        const current = await Membership.findOne({ _id: mid, business: id }).session(session);
        if (!current) throw new HttpError(404, "Member not found", "not_found");

        // Idempotent no-op, decided from the transaction's consistent read so a
        // concurrent change can no longer make this report a stale success.
        if (current.role === body.role) return current;

        // The primary owner may be promoted but never demoted.
        const business = await Business.findById(actor.business)
          .select("owner")
          .session(session)
          .lean();
        if (business && current.user.equals(business.owner) && body.role !== "owner") {
          throw new HttpError(
            409,
            "The primary owner cannot be demoted or removed",
            "primary_owner",
          );
        }

        // Demoting an active owner could leave the business ownerless.
        if (current.role === "owner" && current.status === "active") {
          const owners = await Membership.countDocuments({
            business: id,
            role: "owner",
            status: "active",
          }).session(session);
          if (owners <= 1) {
            throw new HttpError(
              409,
              "A business must always have at least one active owner",
              "last_owner",
            );
          }
        }

        current.role = body.role;
        await current.save({ session });
        return current;
      },
    );

    return ok({ membership: updated.toJSON() });
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, memberId } = await context.params;
    const { user, membership: actor } = await requireBusinessRole(id, ["owner"]);
    const mid = assertObjectId(memberId, "member id");
    await dbConnect();

    const target = await Membership.findOne({ _id: mid, business: id });
    if (!target) throw new HttpError(404, "Member not found", "not_found");

    if (target.user && target.user.equals(user._id)) {
      throw new HttpError(400, "You cannot remove your own membership", "cannot_modify_self");
    }

    await runSerializedMembershipMutation(actor.business, actor._id, async (session) => {
      const current = await Membership.findOne({ _id: mid, business: id }).session(session);
      if (!current) throw new HttpError(404, "Member not found", "not_found");

      // The primary owner membership cannot be removed.
      const business = await Business.findById(actor.business)
        .select("owner")
        .session(session)
        .lean();
      if (business && current.user.equals(business.owner)) {
        throw new HttpError(
          409,
          "The primary owner cannot be demoted or removed",
          "primary_owner",
        );
      }

      // Removing the last active owner would leave the business ownerless.
      if (current.role === "owner" && current.status === "active") {
        const owners = await Membership.countDocuments({
          business: id,
          role: "owner",
          status: "active",
        }).session(session);
        if (owners <= 1) {
          throw new HttpError(
            409,
            "A business must always have at least one active owner",
            "last_owner",
          );
        }
      }

      await Membership.deleteOne({ _id: mid, business: id }, { session });
    });

    return ok({ removed: true, id: mid });
  });
}
