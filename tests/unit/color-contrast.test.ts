import assert from "node:assert/strict";
import test from "node:test";

import { contrastRatio, parseHexColor, readableTextColor } from "../../backend/lib/color-contrast";

test("parses #rgb and #rrggbb only", () => {
  assert.deepEqual(parseHexColor("#4F46E5"), [79, 70, 229]);
  assert.deepEqual(parseHexColor("#fff"), [255, 255, 255]);
  for (const bad of ["", "4f46e5", "#12345", "rgb(0,0,0)", "#ggg", null, undefined]) {
    assert.equal(parseHexColor(bad), null, String(bad));
  }
});

test("contrast ratio matches the WCAG reference values", () => {
  assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255]) * 100) / 100, 21);
  assert.equal(contrastRatio([119, 119, 119], [119, 119, 119]), 1);
  // #767676 on white is the classic 4.54:1 AA boundary.
  assert.equal(Math.round(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255]) * 100) / 100, 4.54);
});

test("readable text colour picks white on dark and black on light theme colours", () => {
  assert.equal(readableTextColor("#4f46e5"), "#ffffff"); // default indigo
  assert.equal(readableTextColor("#0f172a"), "#ffffff");
  assert.equal(readableTextColor("#facc15"), "#000000"); // yellow
  assert.equal(readableTextColor("#ffffff"), "#000000");
  assert.equal(readableTextColor("not a colour"), null);
});

test("the chosen text colour always reaches WCAG AA (4.5:1) on any theme colour", () => {
  let worst = Infinity;
  for (let r = 0; r <= 255; r += 15) {
    for (let g = 0; g <= 255; g += 15) {
      for (let b = 0; b <= 255; b += 15) {
        const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        const text = readableTextColor(hex) === "#ffffff" ? [255, 255, 255] : [0, 0, 0];
        worst = Math.min(worst, contrastRatio([r, g, b], text as [number, number, number]));
      }
    }
  }
  assert.ok(worst >= 4.5, `worst contrast ${worst.toFixed(2)}`);
});
