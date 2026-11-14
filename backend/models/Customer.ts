import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * A storefront customer ACCOUNT, scoped to exactly one business.
 *
 * Customer accounts are deliberately separate from platform users
 * (`models/User.ts`): a customer is never a business owner, staff member or
 * admin, and the same email registered with two businesses is two unrelated
 * accounts. Authentication uses `lib/auth/customer-session.ts` and
 * `lib/auth/customer-guards.ts`, never the platform session.
 *
 * Not yet used for the dashboard customer list: that list is still DERIVED
 * FROM ORDERS (`lib/customers.ts`) and stays the source of truth for order
 * history until customer accounts are linked to orders in a later phase.
 *
 * Index policy: `autoIndex` and `autoCreate` are OFF. The declared indexes
 * (notably the unique `{ business, email }`) must be created by an explicitly
 * approved operation before customer registration goes live; see
 * `docs/customer-accounts.md`. Nothing here creates indexes or collections
 * automatically.
 */
export interface CustomerAddress {
  _id: Types.ObjectId;
  label?: string;
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  phone?: string;
  isDefault?: boolean;
}

export interface CustomerDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  /**
   * Legacy field from the original placeholder model. Customer accounts are
   * NOT platform users: this must stay null and is never read for auth.
   */
  user: Types.ObjectId | null;
  name: string;
  email: string;
  phone: string;
  notes: string;
  /** bcrypt hash; `select: false` and stripped from JSON. Absent = no password set. */
  passwordHash?: string;
  /** Account switch: inactive accounts are refused by the customer guard. */
  active: boolean;
  /** Incremented to revoke every existing session (logout everywhere, password change). */
  tokenVersion: number;
  /** null = not verified. Written by the server only. */
  emailVerifiedAt: Date | null;
  /** Saved delivery addresses (lib/customer-addresses.ts). */
  addresses?: CustomerAddress[];
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<CustomerDoc>(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, required: true, trim: true, maxlength: 140 },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    phone: { type: String, default: "", trim: true },
    notes: { type: String, default: "", maxlength: 2000 },
    passwordHash: { type: String, select: false },
    active: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0, min: 0 },
    emailVerifiedAt: { type: Date, default: null },
    addresses: {
      type: [
        {
          label: { type: String, default: "", trim: true, maxlength: 40 },
          name: { type: String, required: true, trim: true, maxlength: 100 },
          line1: { type: String, required: true, trim: true, maxlength: 160 },
          line2: { type: String, default: "", trim: true, maxlength: 160 },
          city: { type: String, required: true, trim: true, maxlength: 80 },
          region: { type: String, default: "", trim: true, maxlength: 80 },
          postalCode: { type: String, required: true, trim: true, maxlength: 20 },
          country: { type: String, required: true, trim: true, maxlength: 60 },
          phone: { type: String, default: "", trim: true, maxlength: 30 },
          isDefault: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
    // Never build indexes or create the collection implicitly (see above).
    autoIndex: false,
    autoCreate: false,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.passwordHash;
        delete ret.tokenVersion;
        return ret;
      },
    },
  },
);

customerSchema.index({ business: 1, email: 1 }, { unique: true });

// Changing the password revokes every existing customer session.
customerSchema.pre("save", function () {
  if (!this.isNew && this.isModified("passwordHash")) {
    this.tokenVersion = (this.tokenVersion ?? 0) + 1;
  }
});

export const Customer: Model<CustomerDoc> =
  (models.Customer as Model<CustomerDoc>) ||
  model<CustomerDoc>("Customer", customerSchema);
