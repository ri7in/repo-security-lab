import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface BoundaryPolicy {
  readonly external: ReadonlySet<string> | "app-packages";
  readonly builtins: ReadonlySet<string>;
  readonly minimumFiles: number;
  readonly namedFile: string;
}

interface SourceShape {
  readonly imports: readonly string[];
  readonly callsFetch: boolean;
}

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(candidate);
      return entry.isFile() && entry.name.endsWith(".ts") ? [candidate] : [];
    }),
  );
  return files.flat();
}

function inspectSource(source: string): SourceShape {
  const tree = ts.createSourceFile(
    "boundary.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports: string[] = [];
  let callsFetch = false;
  const recordLiteral = (node: ts.Expression | undefined): void => {
    if (node !== undefined && ts.isStringLiteral(node)) imports.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      recordLiteral(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        recordLiteral(node.arguments[0]);
      }
      if (
        (ts.isIdentifier(node.expression) && node.expression.text === "fetch") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "fetch")
      ) {
        callsFetch = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { imports, callsFetch };
}

function validateBoundary(source: string, policy: BoundaryPolicy): void {
  const shape = inspectSource(source);
  if (shape.callsFetch) throw new Error("network fetch is outside this boundary");
  for (const specifier of shape.imports) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (specifier.startsWith("node:")) {
      if (!policy.builtins.has(specifier)) {
        throw new Error(`forbidden builtin: ${specifier}`);
      }
      continue;
    }
    if (
      policy.external === "app-packages"
        ? specifier.startsWith("@app/")
        : policy.external.has(specifier)
    ) {
      continue;
    }
    throw new Error(`forbidden package: ${specifier}`);
  }
}

const policies: Readonly<Record<string, BoundaryPolicy>> = {
  normalize: {
    external: new Set(["@app/contracts", "@app/scanners"]),
    builtins: new Set(),
    minimumFiles: 1,
    namedFile: "index.ts",
  },
  broker: {
    external: new Set(["@app/contracts"]),
    builtins: new Set(["node:crypto"]),
    minimumFiles: 1,
    namedFile: "index.ts",
  },
  ai: {
    external: new Set(["@app/contracts"]),
    builtins: new Set(),
    minimumFiles: 1,
    namedFile: "index.ts",
  },
  archive: {
    external: new Set(),
    builtins: new Set([
      "node:fs",
      "node:fs/promises",
      "node:path",
      "node:stream",
      "node:zlib",
    ]),
    minimumFiles: 2,
    namedFile: "tar-gzip.ts",
  },
  scanners: {
    external: new Set(["@app/contracts", "zod"]),
    builtins: new Set([
      "node:child_process",
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:url",
    ]),
    minimumFiles: 4,
    namedFile: "gitleaks.ts",
  },
  worker: {
    external: "app-packages",
    builtins: new Set([
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:path",
      "node:stream",
      "node:stream/promises",
    ]),
    minimumFiles: 2,
    namedFile: "worker.ts",
  },
};

describe("first-party source-isolation boundaries", () => {
  it("keeps source-processing packages structurally network-blind", async () => {
    // This checks first-party dependency discipline, not runtime sandboxing.
    // The Linux public-scan gate remains the enforcement boundary.
    let observedAllowedBrokerCrypto = false;
    for (const [packageName, policy] of Object.entries(policies)) {
      const directory = path.join(root, "packages", packageName, "src");
      const files = await sourceFiles(directory);
      expect(files.length).toBeGreaterThanOrEqual(policy.minimumFiles);
      expect(files.map((file) => path.basename(file))).toContain(policy.namedFile);
      for (const file of files) {
        const source = await readFile(file, "utf8");
        validateBoundary(source, policy);
        if (
          packageName === "broker" &&
          inspectSource(source).imports.includes("node:crypto")
        ) {
          observedAllowedBrokerCrypto = true;
        }
      }
    }
    expect(observedAllowedBrokerCrypto).toBe(true);
  });

  it("rejects synthetic network imports and calls", () => {
    const isolated = policies["normalize"];
    if (isolated === undefined) throw new Error("test policy missing");
    expect(() =>
      validateBoundary('import "node:https";', isolated),
    ).toThrow("forbidden builtin");
    expect(() => validateBoundary('fetch("https://example.test");', isolated)).toThrow(
      "network fetch",
    );
  });
});
