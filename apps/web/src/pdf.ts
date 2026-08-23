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

  write(page, MARGIN, page.cursor, "F2", 17, report.title);
  advance(19);
  write(page, MARGIN, page.cursor, "F1", 9, report.meta);
  advance(20);
  write(page, MARGIN, page.cursor, "F2", 11, report.verdict);
  advance(10);
  rule(page, page.cursor);
  advance(20);

  for (const section of report.sections) {
    // A heading alone at the foot of a page reads as a section with no
    // content, so it moves to the next page with its first row.
    if (page.cursor < BOTTOM + ROW_HEIGHT * 4) advance(page.cursor - BOTTOM);
    write(page, MARGIN, page.cursor, "F2", 11, section.heading);
    advance(13);
    if (section.note !== undefined) {
      write(page, MARGIN, page.cursor, "F1", 8, section.note);
      advance(13);
    }
    if (section.rows.length === 0) {
      write(page, MARGIN, page.cursor, "F3", MONO_SIZE, section.emptyText);
      advance(24);
      continue;
    }
    if (section.layout === "list") {
      const budget = Math.max(1, Math.floor(CONTENT_WIDTH / MONO_ADVANCE) - 1);
      const labelWidth =
        Math.max(...section.columns.slice(1).map((column) => column.title.length)) + 2;
      for (const [index, row] of section.rows.entries()) {
        write(
          page,
          MARGIN,
          page.cursor,
          "F4",
          MONO_SIZE + 0.5,
          fit(`${String(index + 1)}. ${row[0] ?? ""}`, budget, "head"),
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
