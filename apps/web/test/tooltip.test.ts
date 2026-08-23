import { describe, expect, it } from "vitest";
import { place } from "../src/tooltip.js";

/**
 * The explanation used to be a pseudo-element inside the ledger, and a box
 * that scrolls on one axis clips on both, so a four-line explanation lost its
 * top two lines to the table's own edge and a phone lost 31px off every line
 * to the left one. It is positioned in the viewport now, and these are the
 * cases that were broken.
 */

const VIEWPORT = { width: 1440, height: 900 };
const TIP = { width: 320, height: 86 };

function anchor(top: number, left = 200, height = 22) {
  return { top, bottom: top + height, left, width: 90, height };
}

describe("placing the explanation", () => {
  it("opens above the target when there is room", () => {
    const at = place(anchor(400), TIP, VIEWPORT);
    expect(at.top).toBe(400 - TIP.height - 8);
    expect(at.left).toBe(200);
  });

  it("flips below when the target is near the top", () => {
    // This is the case that was cut in half: 53px of room above the first row
    // and an 86px explanation.
    const at = place(anchor(53), TIP, VIEWPORT);
    expect(at.top).toBe(53 + 22 + 8);
    expect(at.top).toBeGreaterThanOrEqual(0);
  });

  it("keeps the whole box on screen at the top edge", () => {
    const at = place(anchor(0), TIP, VIEWPORT);
    expect(at.top).toBeGreaterThanOrEqual(10);
    expect(at.top + TIP.height).toBeLessThanOrEqual(VIEWPORT.height - 10);
  });

  it("keeps the whole box on screen at the bottom edge", () => {
    const at = place(anchor(VIEWPORT.height - 30), TIP, VIEWPORT);
    expect(at.top + TIP.height).toBeLessThanOrEqual(VIEWPORT.height - 10);
    expect(at.top).toBeGreaterThanOrEqual(10);
  });

  it("pulls back from the right edge rather than running off it", () => {
    // A chip in the last column of the table, which is where the clipping was
    // worst.
    const at = place(anchor(400, 1380), TIP, VIEWPORT);
    expect(at.left + TIP.width).toBeLessThanOrEqual(VIEWPORT.width - 10);
  });

  it("never starts left of the edge on a narrow screen", () => {
    const phone = { width: 390, height: 844 };
    const at = place(anchor(400, 2), { width: 370, height: 120 }, phone);
    expect(at.left).toBeGreaterThanOrEqual(10);
  });

  it("still starts on screen when the box is taller than the viewport", () => {
    const at = place(anchor(400), { width: 320, height: 2000 }, VIEWPORT);
    expect(at.top).toBe(10);
  });

  it("does not push a wide box off the left trying to fit it", () => {
    // Clamping the right edge must not produce a negative left.
    const at = place(anchor(400, 900), { width: 2000, height: 86 }, VIEWPORT);
    expect(at.left).toBeGreaterThanOrEqual(10);
  });
});
