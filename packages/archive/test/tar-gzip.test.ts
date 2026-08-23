/* eslint-disable @typescript-eslint/require-await -- fixture generator models a chunked async network body */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { DEFAULT_ARCHIVE_LIMITS, extractTarGzip } from "@app/archive";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function destination(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "repo-security-archive-"));
  temporaryDirectories.push(parent);
  return path.join(parent, "extracted");
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function header(name: string, size: number, type = "0"): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  octal(0o600, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(
    block,
    148,
  );
  return block;
}

function entry(name: string, data: Buffer, type = "0"): Buffer {
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header(name, data.length, type), data, padding]);
}

function tar(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1_024)]);
}

function paxRecord(key: string, value: string): Buffer {
  let length = Buffer.byteLength(` ${key}=${value}\n`) + 1;
  while (true) {
    const text = `${length} ${key}=${value}\n`;
    const actual = Buffer.byteLength(text);
    if (actual === length) return Buffer.from(text);
    length = actual;
  }
}

async function* compressed(input: Buffer): AsyncIterable<Uint8Array> {
  const gzip = gzipSync(input);
  const midpoint = Math.max(1, Math.floor(gzip.length / 2));
  yield gzip.subarray(0, midpoint);
  yield gzip.subarray(midpoint);
}

describe("streaming tar.gz guard and extractor", () => {
  it("extracts regular files and directories with fixed private modes", async () => {
    const target = await destination();
    const report = await extractTarGzip(
      compressed(
        tar([
          entry("root/", Buffer.alloc(0), "5"),
          entry("root/src/", Buffer.alloc(0), "5"),
          entry("root/src/index.ts", Buffer.from("export const safe = true;\n")),
        ]),
      ),
      target,
    );
    expect(await readFile(path.join(target, "root/src/index.ts"), "utf8")).toBe(
      "export const safe = true;\n",
    );
    expect(report).toMatchObject({
      entryCount: 3,
      regularFileCount: 1,
      directoryCount: 2,
      extractedBytes: 26,
    });
  });

  it.each([
    ["path traversal", "../outside"],
    ["absolute path", "/outside"],
    ["Windows path", "root\\outside"],
    ["case collision", "root/FILE"],
  ])("rejects %s and cleans partial output", async (_label, hostilePath) => {
    const target = await destination();
    const entries = [entry("root/file", Buffer.from("one"))];
    entries.push(entry(hostilePath, Buffer.from("two")));
    await expect(extractTarGzip(compressed(tar(entries)), target)).rejects.toMatchObject(
      { code: "ARCHIVE_UNSAFE", message: "ARCHIVE_UNSAFE" },
    );
    await expect(readFile(path.join(target, "root/file"))).rejects.toThrow();
  });

  it("rejects links and device-like special entries", async () => {
    for (const type of ["1", "2", "3", "4", "6"]) {
      await expect(
        extractTarGzip(
          compressed(tar([entry("root/special", Buffer.alloc(0), type)])),
          await destination(),
        ),
      ).rejects.toMatchObject({ code: "ARCHIVE_UNSAFE" });
    }
  });

  it("rejects case collisions in implicit parent directories", async () => {
    await expect(
      extractTarGzip(
        compressed(
          tar([
            entry("root/Source/one.ts", Buffer.from("one")),
            entry("root/source/two.ts", Buffer.from("two")),
          ]),
        ),
        await destination(),
      ),
    ).rejects.toMatchObject({ code: "ARCHIVE_UNSAFE" });
  });

  it("accepts bounded PAX global metadata and a safe path override", async () => {
    const target = await destination();
    const global = paxRecord("comment", "immutable-commit");
    const extended = paxRecord("path", "root/long-name.ts");
    const report = await extractTarGzip(
      compressed(
        tar([
          entry("pax_global_header", global, "g"),
          entry("root/PaxHeaders/file", extended, "x"),
          entry("root/placeholder", Buffer.from("safe")),
        ]),
      ),
      target,
    );
    expect(await readFile(path.join(target, "root/long-name.ts"), "utf8")).toBe(
      "safe",
    );
    expect(report.regularFileCount).toBe(1);
  });

  it("rejects malicious PAX path and global structural overrides", async () => {
    for (const [type, record] of [
      ["x", paxRecord("path", "../../escape")],
      ["g", paxRecord("path", "root/replaced")],
      ["x", paxRecord("GNU.sparse.size", "1")],
    ] as const) {
      await expect(
        extractTarGzip(
          compressed(
            tar([
              entry("pax_header", record, type),
              entry("root/file", Buffer.from("x")),
            ]),
          ),
          await destination(),
        ),
      ).rejects.toMatchObject({ code: "ARCHIVE_UNSAFE" });
    }
  });

  it("fails fixed limits before trusting declared file bytes", async () => {
    // Derived from the limit rather than hardcoded, so raising the ceiling
    // moves the test with it instead of silently exercising a different check.
    const oversized = tar([
      header("root/huge", DEFAULT_ARCHIVE_LIMITS.individualFileBytes + 1),
    ]);
    await expect(
      extractTarGzip(compressed(oversized), await destination()),
    ).rejects.toMatchObject({ code: "ARCHIVE_LIMIT" });

    await expect(
      extractTarGzip(
        compressed(tar([entry("root/one", Buffer.alloc(0)), entry("root/two", Buffer.alloc(0))])),
        await destination(),
        { entries: 1 },
      ),
    ).rejects.toMatchObject({ code: "ARCHIVE_LIMIT" });
  });

  it("rejects a high-ratio gzip bomb after the allowance", async () => {
    await expect(
      extractTarGzip(
        compressed(tar([entry("root/zeros", Buffer.alloc(3 * 1_024 * 1_024))])),
        await destination(),
      ),
    ).rejects.toMatchObject({ code: "ARCHIVE_LIMIT" });
  });

  it("hard-bounds inflated metadata and trailing zero padding", async () => {
    const padded = Buffer.concat([
      tar([entry("root/file", Buffer.from("x"))]),
      Buffer.alloc(10_000),
    ]);
    await expect(
      extractTarGzip(compressed(padded), await destination(), {
        extractedBytes: 1_024,
        entries: 1,
        paxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_LIMIT" });
  });

  it("propagates the compressed-byte ceiling through the gunzip stream", async () => {
    await expect(
      extractTarGzip(
        compressed(tar([entry("root/file", Buffer.from("safe"))])),
        await destination(),
        { compressedBytes: 1 },
      ),
    ).rejects.toMatchObject({ code: "ARCHIVE_LIMIT" });
  });

  it("rejects bad checksums and truncated archives without parser details", async () => {
    const badChecksum = tar([entry("root/file", Buffer.from("safe"))]);
    badChecksum[0] = 0x58;
    const truncated = tar([header("root/file", 12)]).subarray(0, 600);
    for (const fixture of [badChecksum, truncated]) {
      await expect(
        extractTarGzip(compressed(fixture), await destination()),
      ).rejects.toMatchObject({ code: "ARCHIVE_INVALID", message: "ARCHIVE_INVALID" });
    }
  });

  it("never removes a destination it did not create", async () => {
    const target = await destination();
    await mkdir(target);
    await writeFile(path.join(target, "owned-by-caller"), "preserve");
    await expect(
      extractTarGzip(
        compressed(tar([entry("root/file", Buffer.from("safe"))])),
        target,
      ),
    ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
    expect(await readFile(path.join(target, "owned-by-caller"), "utf8")).toBe(
      "preserve",
    );
  });
});
