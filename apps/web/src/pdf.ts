/**
 * A very small PDF writer.
 *
 * The download button used to call `window.print()`, which opens a dialog and
 * asks the visitor to pick "Save as PDF" themselves. People clicked download
 * and got a print preview, which is not what download means anywhere else.
 *
 * The alternative was a PDF library. The smallest credible one is a few hundred
 * kilobytes for a page of tables, on a site whose entire premise is that it
 * costs nothing to run and loads on a bad connection. Writing the file directly
 * is about two hundred lines and has no supply chain at all.
 *
 * Deliberately limited: the base fourteen fonts only, no compression, no
 * images, no Unicode. Courier is used for every table because its advance width
 * is exactly 0.6 em, so column widths can be computed in characters instead of
 * requiring embedded font metrics. Text outside printable ASCII becomes "?",
 * which matters for a path in a non-Latin script and is called out in the file.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/**
 * Advance widths in 1/1000 em for printable ASCII, space through tilde.
 *
 * Measured from the system Helvetica with the canvas text-measurement API at
 * 1000px, and checked against the values a viewer uses for the base-14 faces
 * this document names: space 278, period 278, M 833, W 944, digits 556, and
 * the at sign 1015 regular, 975 bold.
 *
 * The writer used to divide the page width by a flat points-per-character
 * guess. At 0.49 em against a real average of 0.53 that was already too
 * generous for ordinary text, and for a title it was not applied at all: a
 * report for a 39 character username, which the login schema allows, put the
 * title's right edge 224 points past the end of the paper, and the words on
 * it were simply gone.
 */
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333,
  278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
  584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
  500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556,
  278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** The same, for Helvetica-Bold. */
const HELVETICA_BOLD_WIDTHS: readonly number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333,
  278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333,
  584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278,
  556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556,
  333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
  333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Courier and Courier-Bold are fixed pitch at 600/1000 em. */
const COURIER_WIDTH = 600;

/** How wide a string is in points, in the font the writer will draw it with. */
function measure(text: string, font: string, size: number): number {
  const table =
    font === "F1"
      ? HELVETICA_WIDTHS
      : font === "F2"
        ? HELVETICA_BOLD_WIDTHS
        : null;
  let units = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 32;
    if (table === null) {
      units += COURIER_WIDTH;
      continue;
    }
    // Outside printable ASCII the writer substitutes "?", which is why an
    // unknown character is charged at that width rather than at zero.
    const index = code >= 32 && code <= 126 ? code - 32 : "?".charCodeAt(0) - 32;
    units += table[index] ?? COURIER_WIDTH;
  }
  return (units * size) / 1000;
}

/** Breaks text into lines that fit a real width, measured rather than guessed. */
function wrapToWidth(
  text: string,
  font: string,
  size: number,
  maxWidth: number,
): readonly string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((entry) => entry !== "")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && measure(candidate, font, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
    // A single word wider than the line, a 39 character username or a deep
    // path, is broken rather than allowed off the page. This has to run on
    // the branch above too: the first version skipped it whenever the long
    // word had just started a fresh line, which is exactly when it happens.
    while (measure(line, font, size) > maxWidth && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && measure(line.slice(0, cut), font, size) > maxWidth) {
        cut -= 1;
      }
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line !== "") lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

const TOP = PAGE_HEIGHT - MARGIN;
const BOTTOM = 58;
const MONO_SIZE = 8;
/** Courier advances exactly 600/1000 of the point size, for every glyph. */
const MONO_ADVANCE = MONO_SIZE * 0.6;
const ROW_HEIGHT = 11.5;

export interface PdfColumn {
  readonly title: string;
  /** Share of the table width, in arbitrary units summed across the row. */
  readonly weight: number;
  /** Which end to keep when a value is too long. A path keeps its tail. */
  readonly keep?: "head" | "tail";
}

export interface PdfSection {
  readonly heading: string;
  readonly note?: string;
  readonly columns: readonly PdfColumn[];
  readonly rows: readonly (readonly string[])[];
  /** Shown in place of the table when there are no rows. */
  readonly emptyText: string;
  /**
   * How each row is drawn.
   *
   * `table` fits short values into columns. `list` gives each row its own
   * block, wrapping every value across as many lines as it needs, and is for
   * rows that carry sentences. Six columns of prose in a 515pt page truncated
   * the severity to "crit..." and the advice to "Use a paramete...", which in
   * a security report is worse than another line of paper.
   */
  readonly layout?: "table" | "list";
}

export interface PdfReport {
  readonly title: string;
  readonly meta: string;
  readonly verdict: string;
  readonly sections: readonly PdfSection[];
  readonly footer: string;
}

/** Escapes a string into a PDF literal, folding anything unprintable to "?". */
function literal(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 63;
    const safe = code >= 32 && code <= 126 ? character : "?";
    out +=
      safe === "\\" || safe === "(" || safe === ")" ? `\\${safe}` : safe;
  }
  return out;
}

/** Trims to a character budget, keeping whichever end carries the meaning. */
function fit(value: string, characters: number, keep: "head" | "tail"): string {
  if (characters <= 0) return "";
  if (value.length <= characters) return value;
  if (characters <= 3) return value.slice(0, characters);
  return keep === "tail"
    ? `...${value.slice(value.length - (characters - 3))}`
    : `${value.slice(0, characters - 3)}...`;
}

interface Page {
  readonly operations: string[];
  cursor: number;
}

function newPage(): Page {
  return { operations: [], cursor: TOP };
}

function write(
  page: Page,
  x: number,
  y: number,
  font: string,
  size: number,
  value: string,
): void {
  page.operations.push(
    `BT /${font} ${String(size)} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${literal(value)}) Tj ET`,
  );
}

function rule(page: Page, y: number, grey = 0.82): void {
  page.operations.push(
    `${grey.toFixed(2)} G 0.6 w ${String(MARGIN)} ${y.toFixed(2)} m ${String(PAGE_WIDTH - MARGIN)} ${y.toFixed(2)} l S 0 G`,
  );
}

/**
 * Breaks a value into lines that fit a character budget.
 *
 * Words are kept whole where they fit. A single token longer than the budget,
 * which a deep file path usually is, is cut rather than allowed to run off the
 * page.
 */
function wrap(value: string, characters: number): readonly string[] {
  if (characters <= 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of value.split(" ")) {
    let piece = word;
    while (piece.length > characters) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      lines.push(piece.slice(0, characters));
      piece = piece.slice(characters);
    }
    if (current === "") {
      current = piece;
    } else if (current.length + 1 + piece.length <= characters) {
      current += ` ${piece}`;
    } else {
      lines.push(current);
      current = piece;
    }
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

/** Character budget and x offset for every column of a table. */
function layout(
  columns: readonly PdfColumn[],
): readonly { readonly x: number; readonly characters: number }[] {
  const total = columns.reduce((sum, column) => sum + column.weight, 0);
  let x = MARGIN;
  return columns.map((column) => {
    const width = (column.weight / total) * CONTENT_WIDTH;
    const entry = {
      x,
      // One character of gutter, so neighbouring columns never touch.
      characters: Math.max(1, Math.floor(width / MONO_ADVANCE) - 1),
    };
    x += width;
    return entry;
  });
}

export function buildPdf(report: PdfReport): Uint8Array<ArrayBuffer> {
  const pages: Page[] = [newPage()];
  let page = pages[0] as Page;

  const advance = (amount: number): void => {
    page.cursor -= amount;
    if (page.cursor < BOTTOM) {
      page = newPage();
      pages.push(page);
      page.cursor = TOP;
    }
  };

  // The title was written straight out with no wrapping at all, on the
  // assumption that "Security report for <name>" is short. The login schema
  // allows 39 characters, and a wide one put the right edge 224 points past
  // the paper with the end of the name gone.
  for (const line of wrapToWidth(report.title, "F2", 17, CONTENT_WIDTH)) {
    write(page, MARGIN, page.cursor, "F2", 17, line);
    advance(19);
  }
  for (const line of wrapToWidth(report.meta, "F1", 9, CONTENT_WIDTH)) {
    write(page, MARGIN, page.cursor, "F1", 9, line);
    advance(11);
  }
  advance(9);
  for (const line of wrapToWidth(report.verdict, "F2", 11, CONTENT_WIDTH)) {
    write(page, MARGIN, page.cursor, "F2", 11, line);
    advance(14);
  }
  advance(-4);
  rule(page, page.cursor);
  advance(20);

  for (const section of report.sections) {
    // A heading alone at the foot of a page reads as a section with no
    // content, so it moves to the next page with its first row.
    //
    // This used to advance to exactly BOTTOM, and `advance` only breaks when
    // the cursor lands strictly below it, so the guard never fired: at
    // seventy-nine findings the heading printed at the very foot of page eight
    // with sixty-six points of white space above it and its table began on
    // page nine.
    if (page.cursor < BOTTOM + ROW_HEIGHT * 4) {
      advance(page.cursor - BOTTOM + 1);
    }
    write(page, MARGIN, page.cursor, "F2", 11, section.heading);
    advance(13);
    if (section.note !== undefined) {
      write(page, MARGIN, page.cursor, "F1", 8, section.note);
      advance(13);
    }
    if (section.rows.length === 0) {
      const budget = Math.max(1, Math.floor(CONTENT_WIDTH / MONO_ADVANCE) - 1);
      for (const line of wrap(section.emptyText, budget)) {
        write(page, MARGIN, page.cursor, "F3", MONO_SIZE, line);
        advance(ROW_HEIGHT);
      }
      advance(14);
      continue;
    }
    if (section.layout === "list") {
      const budget = Math.max(1, Math.floor(CONTENT_WIDTH / MONO_ADVANCE) - 1);
      // The title line is drawn half a point larger than the body, so it needs
      // its own budget. Sharing the body's let a near-limit repository name
      // (the contract allows a hundred characters) run ten points past the
      // right margin: still on the page, but outside the text block every
      // other line respects.
      const headBudget = Math.max(
        1,
        Math.floor(CONTENT_WIDTH / ((MONO_SIZE + 0.5) * 0.6)) - 1,
      );
      const labelWidth =
        Math.max(...section.columns.slice(1).map((column) => column.title.length)) + 2;
      for (const [index, row] of section.rows.entries()) {
        write(
          page,
          MARGIN,
          page.cursor,
          "F4",
          MONO_SIZE + 0.5,
          fit(`${String(index + 1)}. ${row[0] ?? ""}`, headBudget, "head"),
        );
        advance(ROW_HEIGHT);
        for (const [column, heading] of section.columns.slice(1).entries()) {
          const value = row[column + 1] ?? "";
          if (value === "") continue;
          const label = `${heading.title}:`.padEnd(labelWidth, " ");
          const lines = wrap(value, budget - labelWidth - 3);
          for (const [line, text] of lines.entries()) {
            write(
              page,
              MARGIN + 12,
              page.cursor,
              "F3",
              MONO_SIZE,
              line === 0 ? `${label}${text}` : `${" ".repeat(labelWidth)}${text}`,
            );
            advance(ROW_HEIGHT);
          }
        }
        advance(5);
      }
      advance(9);
      continue;
    }
    const columns = layout(section.columns);
    const header = (): void => {
      for (const [index, column] of section.columns.entries()) {
        const slot = columns[index];
        if (slot === undefined) continue;
        write(
          page,
          slot.x,
          page.cursor,
          "F4",
          MONO_SIZE,
          fit(column.title.toUpperCase(), slot.characters, "head"),
        );
      }
      advance(4);
      rule(page, page.cursor, 0.55);
      advance(ROW_HEIGHT);
    };
    header();
    for (const row of section.rows) {
      const wrapped = page.cursor;
      for (const [index, column] of section.columns.entries()) {
        const slot = columns[index];
        if (slot === undefined) continue;
        write(
          page,
          slot.x,
          page.cursor,
          "F3",
          MONO_SIZE,
          fit(row[index] ?? "", slot.characters, column.keep ?? "head"),
        );
      }
      advance(ROW_HEIGHT);
      // A table that ran onto a new page repeats its header, so a printed
      // page is readable on its own.
      if (page.cursor > wrapped) header();
    }
    advance(14);
  }

  // Helvetica at 7.5pt averages close to half its point size per character.
  // The footer ran off the right edge as one unwrapped line, taking the URL
  // with it, which is the one part of it a reader might want.
  const footerLines = wrap(report.footer, Math.floor(CONTENT_WIDTH / 3.6));
  const footerHeight = footerLines.length * 9.5;
  if (page.cursor < BOTTOM + footerHeight + 20) {
    page = newPage();
    pages.push(page);
  }
  rule(page, BOTTOM + footerHeight + 6);
  for (const [index, line] of footerLines.entries()) {
    write(
      page,
      MARGIN,
      BOTTOM + footerHeight - 9.5 - index * 9.5,
      "F1",
      7.5,
      line,
    );
  }

  // Every page states whose report it is and where it sits in the document.
  // Twelve pages of ledger cards are visually interchangeable, and a page
  // separated from the first carried no account name, no date and no number,
  // so a shuffled printout could not be reassembled.
  for (const [index, sheet] of pages.entries()) {
    const stamp = `${report.title} - page ${String(index + 1)} of ${String(pages.length)}`;
    const size = 7;
    write(
      sheet,
      PAGE_WIDTH - MARGIN - measure(stamp, "F1", size),
      BOTTOM - 24,
      "F1",
      size,
      stamp,
    );
  }

  return serialize(pages);
}

function serialize(pages: readonly Page[]): Uint8Array<ArrayBuffer> {
  const pageIds = pages.map((_, index) => 7 + index * 2);
  const objects = new Map<number, string>();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`,
  );
  const fonts: readonly [number, string][] = [
    [3, "Helvetica"],
    [4, "Helvetica-Bold"],
    [5, "Courier"],
    [6, "Courier-Bold"],
  ];
  for (const [id, name] of fonts) {
    objects.set(
      id,
      `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`,
    );
  }
  for (const [index, current] of pages.entries()) {
    const pageId = pageIds[index] as number;
    const streamId = pageId + 1;
    const body = current.operations.join("\n");
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] ` +
        "/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> " +
        `/Contents ${String(streamId)} 0 R >>`,
    );
    objects.set(
      streamId,
      `<< /Length ${String(body.length)} >>\nstream\n${body}\nendstream`,
    );
  }

  const ids = [...objects.keys()].sort((left, right) => left - right);
  let file = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (const id of ids) {
    offsets.set(id, file.length);
    file += `${String(id)} 0 obj\n${objects.get(id) ?? ""}\nendobj\n`;
  }
  const startxref = file.length;
  const highest = (ids.at(-1) ?? 0) + 1;
  file += `xref\n0 ${String(highest)}\n0000000000 65535 f \n`;
  for (let id = 1; id < highest; id += 1) {
    const offset = offsets.get(id);
    file +=
      offset === undefined
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  file += `trailer\n<< /Size ${String(highest)} /Root 1 0 R >>\nstartxref\n${String(startxref)}\n%%EOF\n`;

  // Every byte written above is ASCII, which is what makes the byte offsets in
  // the cross-reference table equal to the string indices used to build them.
  const bytes = new Uint8Array(new ArrayBuffer(file.length));
  for (let index = 0; index < file.length; index += 1) {
    bytes[index] = file.charCodeAt(index) & 0xff;
  }
  return bytes;
}
