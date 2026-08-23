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
