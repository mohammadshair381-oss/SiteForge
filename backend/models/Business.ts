import type { StoreDesign } from "@/lib/design-settings";
import type { StoredNavigation } from "@/lib/navigation";
import { Schema, model, models, type Model, type Types } from "mongoose";
import { BUSINESS_STATUSES, THEME_IDS, type BusinessStatus, type ThemeId } from "@/lib/constants";
import { SETUP_STEPS, type SetupStep } from "@/lib/store-setup";

export interface ThemeSettings {
  primaryColor: string;
  accentColor: string;
  font: string;
  heroHeadline: string;
  heroSubheadline: string;
  about: string;
  showProducts: boolean;
  /**
   * Optional visual-builder section list (Phase WB-2). When present and
   * non-empty, the editor manages page composition through sections. Existing
   * businesses without this field continue to render via themeSettings alone.
   * Stored as an array of validated section objects (see lib/sections.ts).
   */
  sections?: unknown[];
  /**
   * Storefront homepage settings (lib/storefront-config.ts): `storefront` is
   * the owner's draft (dashboard preview), `publishedStorefront` the copy the
   * public store renders, written only by the storefront publish routes.
   */
  storefront?: unknown;
  publishedStorefront?: unknown;
  /** Live typeface, button and text-size choices (lib/design-settings.ts). */
  design?: StoreDesign;
  /** The design draft: previews only; never read for the public store. */
  designDraft?: unknown;
  /** Sections of an older homepage after moving to a Home page record (lib/legacy-homepage.ts). Kept, never shown. */
  legacySections?: unknown;
  /** The saved menus have never been published, so visitors must not see them. */
  navigationDraftOnly?: boolean;
  /** The saved design tokens have never been published (see lib/storefront.ts). */
  designTokensDraftOnly?: boolean;
  /**
   * Optional design tokens for dashboard/editor consistency (Phase 1).
   * Allows per-business customization of spacing, radius, shadows in the editor
   * without affecting storefront theme rendering.
   */
  designTokens?: {
    spacing?: { xs?: string; sm?: string; md?: string; lg?: string; xl?: string };
    radius?: { sm?: string; md?: string; lg?: string; xl?: string };
    shadows?: { sm?: string; md?: string; lg?: string };
    // Phase 2A: Extended design tokens
    button?: { radius?: string; paddingX?: string; paddingY?: string };
    contentWidth?: string;
    fontScale?: string;
  };
  /**
   * Optional navigation configuration (Phase 2A).
   * Draft navigation items referencing published pages.
   */
  navigation?: StoredNavigation;
  /**
   * Published snapshot of navigation (Phase 2A).
   * Copied from `navigation` when the business is published.
   * Storefront uses this when available, falling back to `navigation`.
   */
  publishedNavigation?: StoredNavigation;
  /**
   * Published snapshot of design tokens (Phase 2A).
   * Copied from `designTokens` when the business is published.
   */
  publishedDesignTokens?: {
    spacing?: { xs?: string; sm?: string; md?: string; lg?: string; xl?: string };
    radius?: { sm?: string; md?: string; lg?: string; xl?: string };
    shadows?: { sm?: string; md?: string; lg?: string };
    button?: { radius?: string; paddingX?: string; paddingY?: string };
    contentWidth?: string;
    fontScale?: string;
  };
}

export interface BusinessDoc {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  subdomain: string;
  category: string;
  owner: Types.ObjectId;
  description: string;
  logoUrl: string;
  contactEmail: string;
  phone: string;
  address: string;
  /** Where the store delivers or works, in the owner's words. Never used to refuse an order. */
  serviceArea?: string;
  /** When the notification centre last looked for new events (lib/notifications.ts). */
  notificationsSyncedAt?: Date | null;
  /** Move up on every save of these drafts, so an old editor tab cannot overwrite newer edits (lib/draft-version.ts). */
  storefrontDraftVersion?: number;
  designDraftVersion?: number;
  navigationDraftVersion?: number;
  /** Stops two requests catching up on notifications at once. Runs out by itself after a crash. */
  notificationsSyncLeaseUntil?: Date | null;
  /** Written by Super Admin suspend and reactivate, and by the owner's deletion. Absent on stores never changed that way. */
  statusChangedAt?: Date | null;
  /** When the owner deleted the business (soft; lib/business-deletion.ts), and who. Absent otherwise. */
  deletedAt?: Date | null;
  deletedBy?: Types.ObjectId | null;
  /**
   * Moved inside a transaction by anything checking a plan's limit (`takeUsageTurn`,
   * lib/billing.ts). Two such transactions conflict here, so the later one retries and counts
   * what the earlier one added. Its value means nothing.
   */
  usageTurn?: number;
  currency: string;
  themeId: ThemeId;
  themeSettings: ThemeSettings;
  customDomain: string | null;
  status: BusinessStatus;
  publishedAt: Date | null;
  /**
   * Storefront payment setting (NOT subscription billing): whether signed-in,
   * verified customers may choose cash on delivery. Off by default; only the
   * owner may change it (app/api/businesses/[id]/route.ts).
   */
  codEnabled: boolean;
  /**
   * Whether cash on delivery is also open to guests, without an account. Needs `codEnabled`.
   * Off by default: guest orders hold stock with nobody verified behind them, so a store
   * chooses this. Owner only, like `codEnabled`.
   */
  guestCodEnabled?: boolean;
  /** Touched inside a guest COD order, so two at once take turns (see the orders route). */
  lastGuestCodOrderAt?: Date | null;
  /** Whether managers may invite staff (lib/team-invitations.ts). Owner-only setting. */
  managersCanInvite?: boolean;
  /**
   * Storefront shipping settings (lib/shipping.ts validates them on read and
   * write). Absent = no shipping charge and no address step (unchanged).
   */
  shippingSettings?: unknown;
  /** Store tax (lib/checkout-pricing.ts). Absent = no tax. */
  taxSettings?: unknown;
  /**
   * Guided store setup progress (lib/store-setup.ts): the owner's own choices
   * only (last step, confirmed and skipped steps). Absent for businesses
   * created before the wizard; completion is otherwise derived from data.
   */
  setup?: { step: SetupStep | null; done: SetupStep[]; skipped: SetupStep[]; completedAt: Date | null };
  /**
   * The owner's consent to AI suggestions (lib/ai-builder/consent.ts): the
   * disclosure version agreed to, by whom and when, or when it was revoked.
   * Absent = never consented. History: models/AiConsentEvent.ts.
   */
  aiConsent?: {
    version: string;
    grantedAt: Date | null;
    grantedBy: Types.ObjectId | null;
    revokedAt: Date | null;
    revokedBy: Types.ObjectId | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const defaultThemeSettings: ThemeSettings = {
  primaryColor: "#4f46e5",
  accentColor: "#0ea5e9",
  font: "sans",
  heroHeadline: "Welcome to our store",
  heroSubheadline: "Quality you can trust, service you will love.",
  about: "",
  showProducts: true,
};

const businessSchema = new Schema<BusinessDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 140 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    subdomain: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    category: { type: String, required: true, index: true },
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    description: { type: String, default: "", maxlength: 2000 },
    logoUrl: { type: String, default: "" },
    contactEmail: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    serviceArea: { type: String, default: "", trim: true, maxlength: 240 },
    notificationsSyncedAt: { type: Date, default: undefined },
    notificationsSyncLeaseUntil: { type: Date, default: undefined },
    storefrontDraftVersion: { type: Number, default: undefined },
    designDraftVersion: { type: Number, default: undefined },
    navigationDraftVersion: { type: Number, default: undefined },
    statusChangedAt: { type: Date, default: undefined },
    deletedAt: { type: Date, default: undefined },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: undefined },
    usageTurn: { type: Number, default: undefined, select: false },
    currency: { type: String, default: "USD", uppercase: true, trim: true },
    themeId: { type: String, enum: THEME_IDS, default: "aurora" },
    themeSettings: {
      type: Schema.Types.Mixed,
      default: () => ({ ...defaultThemeSettings }),
    },
    customDomain: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    status: { type: String, enum: BUSINESS_STATUSES, default: "draft", index: true },
    publishedAt: { type: Date, default: null },
    codEnabled: { type: Boolean, default: false },
    guestCodEnabled: { type: Boolean, default: false },
    lastGuestCodOrderAt: { type: Date },
    managersCanInvite: { type: Boolean, default: false },
    shippingSettings: { type: Schema.Types.Mixed, default: undefined },
    taxSettings: { type: Schema.Types.Mixed, default: undefined },
    setup: {
      type: new Schema(
        {
          step: { type: String, enum: [...SETUP_STEPS, null], default: null },
          done: { type: [{ type: String, enum: SETUP_STEPS }], default: [] },
          skipped: { type: [{ type: String, enum: SETUP_STEPS }], default: [] },
          completedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: undefined,
    },
    aiConsent: {
      type: new Schema(
        {
          version: { type: String, required: true, maxlength: 40 },
          grantedAt: { type: Date, default: null },
          grantedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
          revokedAt: { type: Date, default: null },
          revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true, versionKey: false },
);

businessSchema.index(
  { customDomain: 1 },
  { unique: true, partialFilterExpression: { customDomain: { $gt: "" } } },
);

export const Business: Model<BusinessDoc> =
  (models.Business as Model<BusinessDoc>) ||
  model<BusinessDoc>("Business", businessSchema);
