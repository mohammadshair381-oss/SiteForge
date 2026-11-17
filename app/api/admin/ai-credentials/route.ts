import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { HttpError, handle, ok, readJson } from "@/lib/api";
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN, runAuditedAdminAction } from "@/lib/admin-audit";
import { AI_API_KEY_MAX, AI_API_KEY_MIN, aiKeyStatus, clearAiCredentialCache, encryptAiKey, lastFour, loadAiCredentials } from "@/lib/ai-providers/credentials";
import { aiProviders, getAiProvider, isDisclosedProvider } from "@/lib/ai-providers/registry";
import { clearAiRoutingCache } from "@/lib/ai-providers/settings";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { verifyPassword } from "@/lib/auth/password";
import { enforceRateLimit } from "@/lib/rate-limit";
import { recordSecurityEvent } from "@/lib/security-events";
import { AiProviderCredential } from "@/models/AiProviderCredential";
import { User } from "@/models/User";

/**
 * AI provider API keys in the Super Admin panel (owner decision, 2026-11-17; lib/ai-providers/credentials.ts).
 *
 * - `GET`: for each provider, where its key comes from and the last four characters of a key set
 *   here. Never a key.
 * - `PUT { providerId, apiKey, currentPassword, reason }`: sets or replaces a key.
 * - `DELETE { providerId, currentPassword, reason }`: removes the key set here (the server
 *   environment's key, if any, is used again).
 *
 * Both writes need the acting admin's password again and are audited in the same transaction,
 * with only the last four characters. A key never turns AI on (`AI_PROVIDER_ENABLED` stays in the
 * server environment) and is never sent to the provider here: it is first used by a real request.
 */
const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 10;

const providerId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Choose a provider from the list.");
const reason = z.string().trim().min(ADMIN_REASON_MIN, `Give a reason of at least ${ADMIN_REASON_MIN} characters.`).max(ADMIN_REASON_MAX);
const currentPassword = z.string().min(1, "Enter your password to change an API key.").max(200);

const putSchema = z
  .object({
    providerId,
    apiKey: z
      .string()
      .trim()
      .min(AI_API_KEY_MIN, "This does not look like a whole API key. Paste the full key.")
      .max(AI_API_KEY_MAX, "This is longer than an API key. Paste only the key.")
      .regex(/^[A-Za-z0-9._\-]+$/, "An API key has only letters, digits, dots, dashes and underscores. Check that nothing else was pasted."),
    currentPassword,
    reason,
  })
  .strict();
const deleteSchema = z.object({ providerId, currentPassword, reason }).strict();

function providerFor(id: string) {
  const adapter = getAiProvider(id);
  if (!adapter || !isDisclosedProvider(id)) throw new HttpError(404, "There is no such AI provider.", "not_found");
  return adapter;
}

async function stepUp(request: Request, adminId: unknown, password: string): Promise<void> {
  const self = await User.findById(adminId).select("+passwordHash");
  if (!self || !(await verifyPassword(password, self.passwordHash))) {
    await recordSecurityEvent({ type: "admin_reauth_failed", userId: adminId, request });
    throw new HttpError(403, "Your password is incorrect.", "reauthentication_failed", undefined, { currentPassword: "Your password is incorrect." });
  }
}

export async function GET() {
  return handle(async () => {
    await requireSuperAdmin();
    await loadAiCredentials({ force: true });
    const providers = aiProviders()
      .filter((adapter) => isDisclosedProvider(adapter.id))
      .map((adapter) => ({ id: adapter.id, displayName: adapter.displayName, envName: adapter.keyEnvName, ...aiKeyStatus(adapter.id, adapter.keyEnvName) }));
    return ok({ providers }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function PUT(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const admin = await requireSuperAdmin();
    await enforceRateLimit({ key: `admin:ai-credentials:${admin._id}`, limit: LIMIT, windowMs: WINDOW_MS });
    const input = putSchema.parse(await readJson(request));
    const adapter = providerFor(input.providerId);
    await dbConnect();
    await stepUp(request, admin._id, input.currentPassword);

    const encrypted = encryptAiKey(input.apiKey);
    const last4 = lastFour(input.apiKey);
    await runAuditedAdminAction(async (session) => {
      const before = await AiProviderCredential.findById(adapter.id).select("last4").session(session).lean();
      await AiProviderCredential.updateOne(
        { _id: adapter.id },
        { $set: { ...encrypted, last4, updatedBy: admin._id }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true, session },
      );
      return {
        result: null,
        audit: {
          actorId: String(admin._id),
          action: "platform.ai_credentials",
          targetType: "platform",
          targetId: `ai-key:${adapter.id}`,
          targetLabel: `${adapter.displayName} API key`,
          reason: input.reason,
          before: before ? { key: `…${before.last4}` } : { key: null },
          after: { key: `…${last4}` },
        },
      };
    });
    clearAiCredentialCache();
    clearAiRoutingCache();
    await loadAiCredentials({ force: true });
    return ok({ provider: { id: adapter.id, ...aiKeyStatus(adapter.id, adapter.keyEnvName) } });
  });
}

export async function DELETE(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const admin = await requireSuperAdmin();
    await enforceRateLimit({ key: `admin:ai-credentials:${admin._id}`, limit: LIMIT, windowMs: WINDOW_MS });
    const input = deleteSchema.parse(await readJson(request));
    const adapter = providerFor(input.providerId);
    await dbConnect();
    await stepUp(request, admin._id, input.currentPassword);

    const removed = await runAuditedAdminAction(
      async (session) => {
        const before = await AiProviderCredential.findById(adapter.id).select("last4").session(session).lean();
        if (before) await AiProviderCredential.deleteOne({ _id: adapter.id }, { session });
        return {
          result: Boolean(before),
          audit: {
            actorId: String(admin._id),
            action: "platform.ai_credentials",
            targetType: "platform",
            targetId: `ai-key:${adapter.id}`,
            targetLabel: `${adapter.displayName} API key`,
            reason: input.reason,
            before: { key: before ? `…${before.last4}` : null },
            after: { key: null },
          },
        };
      },
      { skipAuditWhen: (result) => !result },
    );
    clearAiCredentialCache();
    clearAiRoutingCache();
    await loadAiCredentials({ force: true });
    return ok({ removed, provider: { id: adapter.id, ...aiKeyStatus(adapter.id, adapter.keyEnvName) } });
  });
}
