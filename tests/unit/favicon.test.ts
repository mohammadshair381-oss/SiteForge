import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const app = join(process.cwd(), "app");

test("icon.svg uses the brand colour and is a self-contained SVG", () => {
  const svg = readFileSync(join(app, "icon.svg"), "utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/);
  assert.match(svg, /fill="#191918"/, "ink from the platform identity (docs/design-system.md)");
  assert.match(svg, /fill="#f4511e"/, "ember from the platform identity");
  assert.ok(!/<script|href=|xlink:|<image/i.test(svg), "no scripts or external references");
});

test("favicon.ico is a valid icon with 16 and 32 px PNG images", () => {
  const ico = readFileSync(join(app, "favicon.ico"));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, "type: icon");
  const count = ico.readUInt16LE(4);
  assert.equal(count, 2);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const width = ico.readUInt8(entry) || 256;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    sizes.push(width);
    assert.ok(offset + length <= ico.length);
    assert.deepEqual([...ico.subarray(offset, offset + 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG payload");
    assert.equal(ico.readUInt32BE(offset + 16), width, "PNG width matches the entry");
  }
  assert.deepEqual(sizes, [16, 32]);
});
