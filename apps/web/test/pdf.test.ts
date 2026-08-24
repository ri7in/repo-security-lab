import { describe, expect, it } from "vitest";
import { buildPdf, type PdfReport } from "../src/pdf.js";

/**
 * The PDF is written byte by byte rather than by a library, so the tests are
 * about the parts a reader would not survive getting wrong: the cross-reference
 * offsets a viewer seeks by, the escaping of characters that would otherwise
 * end a string early, and the promise that nothing from a scanned repository
 * can steer the document.
 */

function decode(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function report(overrides: Partial<PdfReport> = {}): PdfReport {
  return {
    title: "Security report for ri7in",
    meta: "3 public repositories examined",
    verdict: "Nothing exposed.",
    footer: "Public report.",
    sections: [
      {
        heading: "What was found",
        emptyText: "Nothing was found.",
        columns: [
          { title: "Repository", weight: 3 },
          { title: "Where", weight: 7, keep: "tail" },
        ],
        rows: [["fixture-repo", "infrastructure/k8s/secrets.yaml:14"]],
      },
    ],
    ...overrides,
  };
}

describe("the report writer", () => {
  it("writes a file a viewer will open", () => {
    const text = decode(buildPdf(report()));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("points the cross-reference table at the real object offsets", () => {
    // A viewer seeks straight to these. One wrong offset and the file opens as
    // damaged, which is worse than no download button at all.
    const bytes = buildPdf(report());
    const text = decode(bytes);
    // "startxref" ends in "xref", so the table is found by its own line.
    const table = text.slice(text.lastIndexOf("\nxref\n"));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) =>
      Number(match[1]),
    );
    expect(offsets.length).toBeGreaterThanOrEqual(6);
    for (const [index, offset] of offsets.entries()) {
      expect(text.slice(offset)).toMatch(
        new RegExp(`^${String(index + 1)} 0 obj`),
      );
    }
  });

  it("points startxref at the cross-reference table", () => {
    const text = decode(buildPdf(report()));
    const declared = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(declared, declared + 4)).toBe("xref");
  });

  it("declares a stream length that matches the stream", () => {
    const text = decode(buildPdf(report()));
    const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(text);
    expect(match).not.toBeNull();
    expect(match?.[2]?.length).toBe(Number(match?.[1]));
  });

  it("escapes a bracket in a path instead of ending the string early", () => {
    // A repository owner controls their own file names. An unescaped ")" would
    // close the literal and let the rest of the path be read as operators.
    const text = decode(
      buildPdf(
        report({
          sections: [
            {
              heading: "What was found",
              emptyText: "none",
              columns: [{ title: "Where", weight: 1, keep: "tail" }],
              rows: [["a(b)c.ts:1"]],
            },
          ],
        }),
      ),
    );
    expect(text).toContain("a\\(b\\)c.ts:1");
    expect(text).not.toContain("(a(b)c.ts:1)");
  });

  it("escapes a backslash in a path", () => {
    const text = decode(
      buildPdf(
        report({
          sections: [
            {
              heading: "h",
              emptyText: "none",
              columns: [{ title: "Where", weight: 1 }],
              rows: [["a\\b.ts"]],
            },
          ],
        }),
      ),
    );
    expect(text).toContain("a\\\\b.ts");
  });

  it("folds characters it cannot encode rather than emitting them raw", () => {
    // The base fonts are single byte. A path in another script has to become
    // something, and a visible "?" is more honest than a mangled glyph.
    const bytes = buildPdf(
      report({
        sections: [
          {
            heading: "h",
            emptyText: "none",
            columns: [{ title: "Where", weight: 1 }],
            rows: [["src/日本.ts"]],
          },
        ],
      }),
    );
    expect(decode(bytes)).toContain("src/??.ts");
    for (const byte of bytes) expect(byte).toBeLessThan(128);
  });

  it("keeps the end of a long path, because that is where the line number is", () => {
    const long = `src/${"deep/".repeat(60)}config.ts:412`;
    const text = decode(
      buildPdf(
        report({
          sections: [
            {
              heading: "h",
              emptyText: "none",
              columns: [{ title: "Where", weight: 1, keep: "tail" }],
              rows: [[long]],
            },
          ],
        }),
      ),
    );
    expect(text).toContain("config.ts:412");
  });

  it("starts a second page rather than writing past the bottom", () => {
    const rows = Array.from({ length: 400 }, (_, index) => [
      `repository-${String(index)}`,
      `src/file-${String(index)}.ts:1`,
    ]);
    const text = decode(
      buildPdf(
        report({
          sections: [
            {
              heading: "h",
              emptyText: "none",
              columns: [
                { title: "Repository", weight: 3 },
                { title: "Where", weight: 7, keep: "tail" },
              ],
              rows,
            },
          ],
        }),
      ),
    );
    const count = Number(/\/Count (\d+)/.exec(text)?.[1]);
    expect(count).toBeGreaterThan(1);
    // Every row has to be somewhere. Silently dropping the tail of a security
    // report is the one failure that would make the download worse than useless.
    expect(text).toContain("repository-399");
  });

  it("repeats the header on a continued page", () => {
    const rows = Array.from({ length: 200 }, (_, index) => [
      `repository-${String(index)}`,
    ]);
    const text = decode(
      buildPdf(
        report({
          sections: [
            {
              heading: "h",
              emptyText: "none",
              columns: [{ title: "Repository", weight: 1 }],
              rows,
            },
          ],
        }),
      ),
    );
    expect([...text.matchAll(/\(REPOSITORY\)/g)].length).toBeGreaterThan(1);
  });

  it("says so when a section has nothing in it", () => {
    const text = decode(
      buildPdf(
        report({
          sections: [
            {
              heading: "What was found",
              emptyText: "Nothing was found.",
              columns: [{ title: "Repository", weight: 1 }],
              rows: [],
            },
          ],
        }),
      ),
    );
    // An empty table with a header reads as a rendering bug.
    expect(text).toContain("Nothing was found.");
  });
});

describe("keeping a section with its table", () => {
  it("does not strand a heading at the foot of a page", () => {
    // The guard advanced to exactly the bottom margin, and the page only
    // breaks strictly below it, so it never fired. These are the row counts
    // where the heading printed alone at the foot of one page while its table
    // began on the next, found by sweeping 20 to 130.
    for (const count of [49, 59, 69, 79, 120, 130]) {
      const bytes = buildPdf(
        report({
          sections: [
            {
              heading: "What was found",
              layout: "list",
              note: "File paths and line numbers only.",
              emptyText: "none",
              columns: [
                { title: "Repository", weight: 4 },
                { title: "What was found", weight: 4 },
                { title: "Severity", weight: 1.8 },
                { title: "How many", weight: 3.2 },
                { title: "Where", weight: 6, keep: "tail" },
                { title: "What to do", weight: 4 },
              ],
              rows: Array.from({ length: count }, (_, index) => [
                `repo-${String(index)}`,
                "generic api key",
                "high",
                "1",
                `src/f${String(index)}.ts:1`,
                "Rotate it",
              ]),
            },
            {
              heading: "What was covered",
              emptyText: "none",
              columns: [
                { title: "Repository", weight: 7 },
                { title: "Status", weight: 3 },
              ],
              rows: [["only-row", "Scanned"]],
            },
          ],
        }),
      );
      const text = decode(bytes);
      const streams = [
        ...text.matchAll(/stream\n([\s\S]*?)\nendstream/g),
      ].map((match) => match[1] ?? "");
      const withHeading = streams.find((body) =>
        body.includes("(What was covered)"),
      );
      expect(withHeading, `${String(count)} rows lost the heading`).toBeDefined();
      expect(withHeading, `${String(count)} rows stranded the heading`).toContain(
        "(only-row)",
      );
    }
  });
});

describe("the list layout stays inside its own text block", () => {
  it("does not run a near-limit repository name past the right margin", () => {
    // The title line is drawn half a point larger than the body but shared the
    // body's character budget, so a 103 character name ended at 565pt against
    // a 555pt margin: still on the page, outside the block every other line
    // respects. The contract allows a hundred characters.
    const longest = "l".repeat(100);
    const bytes = buildPdf(
      report({
        sections: [
          {
            heading: "What was found",
            layout: "list",
            emptyText: "Nothing was found.",
            columns: [
              { title: "Repository", weight: 4 },
              { title: "What to do", weight: 4 },
            ],
            rows: [[longest, "Rotate it"]],
          },
        ],
      }),
    );
    const text = decode(bytes);
    // Every drawn string, with the x it starts at, from the content stream.
    const drawn = [...text.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm[\s\S]{0,40}?\((.*?)\) Tj/g)];
    const head = drawn.find((m) => m[2]?.includes("lll"));
    expect(head, "the title line was not written").toBeDefined();
    const startX = Number(head?.[1]);
    const chars = (head?.[2] ?? "").length;
    // 8.5pt monospace advances 0.6 of its size per character.
    const endX = startX + chars * (8.5 * 0.6);
    expect(endX, `title ends at ${endX.toFixed(1)}pt`).toBeLessThanOrEqual(555);
  });
});

describe("nothing is drawn past the right margin", () => {
  /** Every drawn string with the x it starts at, from the content stream. */
  interface Drawn {
    readonly x: number;
    readonly size: number;
    readonly text: string;
    readonly font: string;
  }

  function drawn(bytes: Uint8Array): Drawn[] {
    const text = decode(bytes);
    return [...text.matchAll(/\/(F\d) ([\d.]+) Tf[\s\S]{0,60}?1 0 0 1 ([\d.]+) [\d.]+ Tm[\s\S]{0,40}?\((.*?)\) Tj/g)].map(
      (match) => ({
        x: Number(match[3]),
        size: Number(match[2]),
        text: match[4] ?? "",
        font: match[1] ?? "F1",
      }),
    );
  }

  // Helvetica and Helvetica-Bold advance widths for printable ASCII, the same
  // numbers the writer uses, restated here so the test measures rather than
  // trusting the module under test.
  const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const HELVETICA_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

  function width(entry: Drawn): number {
    const table = entry.font === "F2" ? HELVETICA_BOLD : HELVETICA;
    let units = 0;
    for (const character of entry.text) {
      const code = character.codePointAt(0) ?? 32;
      const index = code >= 32 && code <= 126 ? code - 32 : "?".charCodeAt(0) - 32;
      units += entry.font.startsWith("F3") || entry.font.startsWith("F4")
        ? 600
        : (table[index] ?? 600);
    }
    return (units * entry.size) / 1000;
  }

  it("keeps a 39 character username inside the page", () => {
    // githubLoginSchema allows 39 characters, and W is the widest letter.
    // Written with no wrapping at all, this put the title's right edge 224
    // points past the end of the paper with the rest of the name gone.
    const bytes = buildPdf(
      report({ title: `Security report for ${"W".repeat(39)}` }),
    );
    for (const entry of drawn(bytes)) {
      const right = entry.x + width(entry);
      expect(right, `"${entry.text.slice(0, 30)}" ends at ${right.toFixed(1)}pt`)
        .toBeLessThanOrEqual(556);
    }
  });

  it("keeps a long verdict inside the page", () => {
    const bytes = buildPdf(
      report({
        verdict:
          "9 things to fix in someone's public code, all listed below with the file and the line. 9 repositories did not finish, so there may be more. 4 were skipped on purpose, as forks or as repositories with no commit.",
      }),
    );
    for (const entry of drawn(bytes)) {
      const right = entry.x + width(entry);
      expect(right, `"${entry.text.slice(0, 30)}" ends at ${right.toFixed(1)}pt`)
        .toBeLessThanOrEqual(556);
    }
  });
});
