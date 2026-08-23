/**
 * One tooltip, positioned in the viewport, outside every scroll container.
 *
 * The explanation used to be a `::after` on the chip itself. Two things were
 * wrong with that. The table scrolls sideways, and a box that scrolls on one
 * axis clips on both, so the tooltip was cut off by the table's own edge: on
 * the live report a four-line explanation lost its top two lines to a
 * container with 53px of room above the first row. And it opened upward
 * unconditionally, so a row near the top of the table had nowhere to put it.
 *
 * The native `title` attribute is not the answer either: it waits about a
 * second before appearing, which is long enough that people conclude hovering
 * does nothing and stop trying.
 *
 * So: a single element appended to the body, positioned per target, flipped
 * below the target when there is no room above, and clamped to the viewport.
 * It appears immediately and it cannot be clipped by anything.
 */

const OFFSET = 8;
const EDGE = 10;

let tip: HTMLElement | null = null;

function element(): HTMLElement {
  if (tip !== null) return tip;
  const created = document.createElement("div");
  created.className = "tip";
  created.setAttribute("role", "presentation");
  document.body.append(created);
  tip = created;
  return created;
}

function show(target: HTMLElement): void {
  const detail = target.dataset["detail"];
  if (detail === undefined || detail === "") return;
  const node = element();
  node.textContent = detail;
  node.dataset["open"] = "1";
  // Measured after the text is in, because the height decides which side it
  // goes on.
  node.style.left = "0px";
  node.style.top = "0px";
  const anchor = target.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  const above = anchor.top - box.height - OFFSET;
  const below = anchor.bottom + OFFSET;
  const top = above >= EDGE ? above : below;
  const left = Math.min(
    Math.max(EDGE, anchor.left),
    Math.max(EDGE, window.innerWidth - box.width - EDGE),
  );
  node.style.left = `${String(Math.round(left))}px`;
  node.style.top = `${String(Math.round(top))}px`;
}

function hide(): void {
  if (tip !== null) delete tip.dataset["open"];
}

/**
 * Watches the whole document, so a chip added to the table later is covered
 * without anything having to register it.
 */
export function installTooltips(): void {
  const find = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element
      ? target.closest<HTMLElement>("[data-detail]")
      : null;

  document.addEventListener(
    "pointerover",
    (event) => {
      const target = find(event.target);
      if (target === null) {
        hide();
        return;
      }
      show(target);
    },
    { passive: true },
  );
  document.addEventListener("pointerdown", hide, { passive: true });
  document.addEventListener("focusin", (event) => {
    const target = find(event.target);
    if (target !== null) show(target);
    else hide();
  });
  document.addEventListener("focusout", hide);
  // Dismissible without moving the pointer, which the hover contract requires.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  window.addEventListener("scroll", hide, { passive: true, capture: true });
  window.addEventListener("resize", hide, { passive: true });
}
