import { Schema, model, models, type Model } from "mongoose";

/**
 * The platform's own settings: one document, `_id: "platform"` (lib/platform-settings.ts).
 * Only things a Super Admin may change at run time live here. Secrets and integration
 * switches stay in the environment, and are never read into or written from this.
 * `aiRouting` only names providers and models, and can only narrow what the environment allows.
 * With no document, every default applies.
 */
export interface PlatformSettingsDoc {
  _id: string;
  supportEmail: string;
  maintenanceEnabled: boolean;
  maintenanceMessage: string;
  registrationOpen: boolean;
  /** Moves up by one on every save, so a save from an out-of-date page can be refused. */
  revision?: number;
  /** Which AI provider and model handles which task (lib/ai-providers/settings.ts). */
  aiRouting?: unknown;
  aiRoutingRevision?: number;
  updatedAt?: Date;
}

const platformSettingsSchema = new Schema<PlatformSettingsDoc>(
  {
    _id: { type: String, required: true },
    supportEmail: { type: String, default: "", trim: true, lowercase: true, maxlength: 254 },
    maintenanceEnabled: { type: Boolean, default: false },
    maintenanceMessage: { type: String, default: "", trim: true, maxlength: 300 },
    registrationOpen: { type: Boolean, default: true },
    revision: { type: Number, default: 0, min: 0 },
    aiRouting: { type: Schema.Types.Mixed, default: undefined },
    aiRoutingRevision: { type: Number, default: undefined, min: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false, autoIndex: false, autoCreate: false },
);

export const PlatformSettings: Model<PlatformSettingsDoc> =
  (models.PlatformSettings as Model<PlatformSettingsDoc>) || model<PlatformSettingsDoc>("PlatformSettings", platformSettingsSchema);
