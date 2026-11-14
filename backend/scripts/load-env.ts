import fs from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader for standalone scripts (seed, create-admin).
 * Loads .env.local first, then .env. Existing process.env values win.
 */
export function loadEnv(cwd = process.cwd()): void {
  for (const file of [".env.local", ".env"]) {
    const fullPath = path.join(cwd, file);
    if (!fs.existsSync(fullPath)) continue;

    const contents = fs.readFileSync(fullPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}
