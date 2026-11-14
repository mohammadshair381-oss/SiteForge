import { HttpError } from "./api";

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export function isValidObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

/**
 * Ensures a route parameter is a well-formed MongoDB ObjectId before it reaches
 * Mongoose, so malformed ids produce a consistent 400 instead of a CastError
 * surfacing as a 500.
 */
export function assertObjectId(value: unknown, label = "id"): string {
  if (!isValidObjectId(value)) {
    throw new HttpError(400, `Invalid ${label}`, "invalid_id");
  }
  return value;
}
