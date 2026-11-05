import { Schema, model, models, type Model } from "mongoose";

export interface CategoryDoc {
  key: string;
  name: string;
  description: string;
  icon: string;
  active: boolean;
  sort: number;
}

const categorySchema = new Schema<CategoryDoc>(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    icon: { type: String, default: "" },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

export const Category: Model<CategoryDoc> =
  (models.Category as Model<CategoryDoc>) ||
  model<CategoryDoc>("Category", categorySchema);
