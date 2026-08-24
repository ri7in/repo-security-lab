import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tooltip's DOM half, exercised against a stub rather than a browser.
 *
 * This exists because a source-string assertion is not a test. The bug it was
 * written for was that a tap opened the explanation and the same tap's
 * `pointerdown` closed it again, which made every state chip and the whole
 * "What to do" detail unreachable on a phone. Nothing short of driving the
 * real listeners catches that, and pulling in a DOM library for one module is
 * a dependency this project does not want, so the surface the module actually
 * touches is stubbed here: about thirty properties.
 */

/**
 * The module narrows with `target instanceof Element`, so the stub has to be a
 * real class and that class has to be the global `Element` while it runs.
 */
class StubElement {
  tagName = "SPAN";
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  textContent = "";
  children: StubElement[] = [];
  parent: StubElement | null = null;

  setAttribute(): void {
    // The module sets role="presentation"; nothing here reads it.
  }

  append(child: StubElement): void {
    child.parent = this;
    this.children.push(child);
  }

  /** Only `[data-detail]` is ever asked for, which is the whole contract. */
  closest(selector: string): StubElement | null {
    if (selector !== "[data-detail]") return null;
    if (this.dataset["detail"] !== undefined) return this;
    return this.parent === null ? null : this.parent.closest(selector);
  }

  getBoundingClientRect(): DOMRect {
    return box(200, 100, 80, 20);
  }
}

function box(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function makeElement(tagName: string, detail?: string): StubElement {
  const element = new StubElement();
  element.tagName = tagName;
  if (detail !== undefined) element.dataset["detail"] = detail;
  return element;
}

type Listener = (event: unknown) => void;

let listeners: Map<string, Listener[]>;
let body: StubElement;

function install(): void {
  listeners = new Map();
  vi.stubGlobal("Element", StubElement);
  body = makeElement("BODY");
  const add = (type: string, listener: Listener): void => {
    const existing = listeners.get(type) ?? [];
    existing.push(listener);
    listeners.set(type, existing);
  };
  vi.stubGlobal("document", {
    body,
    createElement: (tag: string) => makeElement(tag),
    addEventListener: add,
  });
  vi.stubGlobal("window", {
    innerWidth: 390,
    innerHeight: 844,
    addEventListener: add,
  });
}

function fire(type: string, event: unknown): void {
  for (const listener of listeners.get(type) ?? []) listener(event);
}

/** The tooltip element, once the module has created it. */
function tipNode(): StubElement | undefined {
  return body.children.find((child) => child.className === "tip");
}

function isOpen(): boolean {
  return tipNode()?.dataset["open"] === "1";
}

describe("the tooltip on a device with no pointer to hover with", () => {
  let chip: StubElement;

  beforeEach(async () => {
    vi.resetModules();
    install();
    const { installTooltips } = await import("../src/tooltip.js");
    installTooltips();
    chip = makeElement("SPAN", "This is a fork, so it was not checked.");
  });

  /** The event sequence a real tap produces, in the order a browser sends it. */
  function tap(target: StubElement): void {
    fire("pointerover", { target, pointerType: "touch" });
    fire("pointerdown", { target, pointerType: "touch" });
  }

  it("opens the explanation on a tap and keeps it open", () => {
    tap(chip);
    expect(isOpen()).toBe(true);
    expect(tipNode()?.textContent).toBe("This is a fork, so it was not checked.");
  });

  it("closes it when the same chip is tapped again", () => {
    tap(chip);
    tap(chip);
    expect(isOpen()).toBe(false);
  });

  it("moves to another chip rather than closing", () => {
    const other = makeElement("SPAN", "Gitleaks read every file under 20 MB.");
    tap(chip);
    tap(other);
    expect(isOpen()).toBe(true);
    expect(tipNode()?.textContent).toBe("Gitleaks read every file under 20 MB.");
  });

  it("closes when the reader taps somewhere else", () => {
    tap(chip);
    tap(makeElement("DIV"));
    expect(isOpen()).toBe(false);
  });
});

describe("the tooltip on a device with a pointer", () => {
  let chip: StubElement;

  beforeEach(async () => {
    vi.resetModules();
    install();
    const { installTooltips } = await import("../src/tooltip.js");
    installTooltips();
    chip = makeElement("SPAN", "Every check that ran on this repository finished.");
  });

  it("opens on hover, as it always did", () => {
    fire("pointerover", { target: chip, pointerType: "mouse" });
    expect(isOpen()).toBe(true);
  });

  it("still gets out of the way when the mouse presses", () => {
    fire("pointerover", { target: chip, pointerType: "mouse" });
    fire("pointerdown", { target: chip, pointerType: "mouse" });
    expect(isOpen()).toBe(false);
  });

  it("closes when the pointer leaves for something with no explanation", () => {
    fire("pointerover", { target: chip, pointerType: "mouse" });
    fire("pointerover", { target: makeElement("DIV"), pointerType: "mouse" });
    expect(isOpen()).toBe(false);
  });

  it("opens on keyboard focus and closes on blur", () => {
    fire("focusin", { target: chip });
    expect(isOpen()).toBe(true);
    fire("focusout", {});
    expect(isOpen()).toBe(false);
  });

  it("is dismissible with Escape, which the hover contract requires", () => {
    fire("pointerover", { target: chip, pointerType: "mouse" });
    fire("keydown", { key: "Escape" });
    expect(isOpen()).toBe(false);
  });

  it("gets out of the way when the page scrolls or the window resizes", () => {
    fire("pointerover", { target: chip, pointerType: "mouse" });
    fire("scroll", {});
    expect(isOpen()).toBe(false);
    fire("pointerover", { target: chip, pointerType: "mouse" });
    fire("resize", {});
    expect(isOpen()).toBe(false);
  });

  it("says nothing when a target carries an empty explanation", () => {
    fire("pointerover", { target: makeElement("SPAN", ""), pointerType: "mouse" });
    expect(isOpen()).toBe(false);
  });

  it("positions itself inside the viewport", () => {
    fire("pointerover", { target: chip, pointerType: "mouse" });
    const node = tipNode();
    expect(Number.parseInt(node?.style["left"] ?? "-1", 10)).toBeGreaterThanOrEqual(10);
    expect(Number.parseInt(node?.style["top"] ?? "-1", 10)).toBeGreaterThanOrEqual(10);
  });
});
