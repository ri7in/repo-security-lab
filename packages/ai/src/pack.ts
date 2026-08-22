/**
 * Builds the pass-1 scout pack: one prompt holding an entire account.
 *
 * Path visibility, deliberately: real relative paths ARE sent to the scout.
 * The source-blind rule governs what the product PUBLISHES, not what a model
 * reads, and every byte here already sits in a public repository. A code model
 * reasons far better knowing a file is `auth/session.ts`, and withholding that
 * buys no privacy for code anyone can already fetch from GitHub. Secrets are a
 * separate matter and are redacted below before anything is packed.
 */

export interface PackFileInput {
  readonly repositoryId: number;
  readonly repositoryName: string;
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly content: string;
}

/** A span to blank out before the file is shown to any model. */
export interface RedactionSpan {
  readonly path: string;
  readonly line: number;
}

export interface PackFile {
  readonly fileToken: number;
  readonly repositoryId: number;
  readonly repositoryName: string;
  readonly path: string;
  readonly lines: readonly string[];
}

export interface ScoutPack {
  readonly files: readonly PackFile[];
  readonly approximateTokens: number;
  /** Files intentionally excluded, with the reason. Never silently dropped. */
  readonly omitted: readonly {
    readonly path: string;
    readonly reason: "not_code" | "too_large" | "budget_exhausted";
  }[];
}

const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java",
  ".rb", ".php", ".c", ".h", ".cpp", ".cs", ".swift", ".kt", ".kts", ".scala",
  ".sh", ".sql", ".vue", ".svelte", ".dart", ".m",
]);

/** Chars per token. Deliberately low so the estimate over-counts, never under. */
const CHARS_PER_TOKEN = 3.2;

const MAX_FILE_BYTES = 256 * 1024;

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Blanks every line a deterministic scanner flagged as holding a secret.
 *
 * This runs before packing, so a real credential cannot ride into a model
 * prompt. The line is replaced rather than removed to keep line numbering
 * stable, which the grounding gate depends on.
 */
export function redactLines(
  lines: readonly string[],
  redactedLineNumbers: ReadonlySet<number>,
): readonly string[] {
  if (redactedLineNumbers.size === 0) return lines;
  return lines.map((line, index) =>
    redactedLineNumbers.has(index + 1) ? "[redacted: detected secret]" : line,
  );
}

/**
 * Assembles the pack under a token ceiling.
 *
 * Files are admitted largest-signal-first: source files ahead of everything
 * else, and within that, smaller files first so a single huge file cannot
 * starve the rest of an account. Whatever does not fit is reported in
 * `omitted`, because a scan that quietly covered 60% of an account while
 * reporting success is the exact dishonesty this product exists to avoid.
 */
export function buildScoutPack(
  inputs: readonly PackFileInput[],
  options: {
    readonly tokenBudget: number;
    readonly redactions?: readonly RedactionSpan[];
  },
): ScoutPack {
  const redactionsByPath = new Map<string, Set<number>>();
  for (const span of options.redactions ?? []) {
    const existing = redactionsByPath.get(span.path) ?? new Set<number>();
    existing.add(span.line);
    redactionsByPath.set(span.path, existing);
  }

  const omitted: {
    path: string;
    reason: "not_code" | "too_large" | "budget_exhausted";
  }[] = [];
  const admissible: PackFileInput[] = [];

  for (const input of inputs) {
    if (!CODE_EXTENSIONS.has(extensionOf(input.path))) {
      omitted.push({ path: input.path, reason: "not_code" });
      continue;
    }
    if (input.content.length > MAX_FILE_BYTES) {
      omitted.push({ path: input.path, reason: "too_large" });
      continue;
    }
    admissible.push(input);
  }

  admissible.sort((left, right) => left.content.length - right.content.length);

  const files: PackFile[] = [];
  let spent = 0;
  let nextToken = 0;

  for (const input of admissible) {
    const cost = estimateTokens(input.content);
    if (spent + cost > options.tokenBudget) {
      omitted.push({ path: input.path, reason: "budget_exhausted" });
      continue;
    }
    spent += cost;
    files.push({
      fileToken: nextToken,
      repositoryId: input.repositoryId,
      repositoryName: input.repositoryName,
      path: input.path,
      lines: redactLines(
        input.content.split("\n"),
        redactionsByPath.get(input.path) ?? new Set<number>(),
      ),
    });
    nextToken += 1;
  }

  return { files, approximateTokens: spent, omitted };
}

/**
 * Renders the pack with explicit file tokens and 1-based line numbers.
 *
 * Line numbers are printed rather than implied so the scout cites positions it
 * can actually see. A model asked to count lines silently will drift; a model
 * asked to copy a number that is already on the page will not.
 */
export function renderScoutPack(pack: ScoutPack): string {
  const sections = pack.files.map((file) => {
    const body = file.lines
      .map((line, index) => `${String(index + 1)}| ${line}`)
      .join("\n");
    return `<file token="${String(file.fileToken)}" repo="${file.repositoryName}" path="${file.path}">\n${body}\n</file>`;
  });
  return sections.join("\n\n");
}
