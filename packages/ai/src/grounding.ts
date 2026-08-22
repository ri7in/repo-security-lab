import { aiScoutFlagSchema, type AiScoutFlag } from "@app/contracts";
import type { PackFile, ScoutPack } from "./pack.js";

/**
 * The grounding gate.
 *
 * This is the guardrail that makes model output safe to act on. A scout flag
 * is accepted only if the text it claims to have found appears verbatim at the
 * lines it cited. A model that invents a vulnerability must also invent source
 * code that happens to sit at a specific line of a specific file, which it
 * cannot do, so fabrications are rejected structurally rather than by
 * judgement.
 *
 * Everything here is deterministic. No model participates in deciding whether
 * a model's own claim is grounded.
 */

export type GroundingRejection =
  | "malformed"
  | "unknown_file"
  | "line_range_invalid"
  | "line_out_of_bounds"
  | "span_too_wide"
  | "quote_not_present"
  | "quote_in_redacted_region";

export interface GroundedFlag {
  readonly flag: AiScoutFlag;
  readonly file: PackFile;
  /** Exact lines the flag points at, for the judge prompt. */
  readonly excerpt: readonly string[];
}

export interface GroundingResult {
  readonly grounded: readonly GroundedFlag[];
  readonly rejected: readonly {
    readonly reason: GroundingRejection;
    readonly fileToken: number | null;
  }[];
}

/** A flag may not point at more than this many lines. */
const MAX_SPAN_LINES = 80;

const REDACTION_MARKER = "[redacted: detected secret]";

/**
 * Grounds one already-parsed flag against the pack.
 *
 * Returns the rejection reason rather than a bare null so the caller can
 * report model quality honestly instead of silently discarding output.
 */
function groundOne(
  flag: AiScoutFlag,
  byToken: ReadonlyMap<number, PackFile>,
): GroundedFlag | { reason: GroundingRejection; fileToken: number | null } {
  const file = byToken.get(flag.fileToken);
  if (file === undefined) {
    return { reason: "unknown_file", fileToken: flag.fileToken };
  }
  if (flag.lineEnd < flag.lineStart) {
    return { reason: "line_range_invalid", fileToken: flag.fileToken };
  }
  if (flag.lineEnd - flag.lineStart + 1 > MAX_SPAN_LINES) {
    return { reason: "span_too_wide", fileToken: flag.fileToken };
  }
  if (flag.lineEnd > file.lines.length) {
    return { reason: "line_out_of_bounds", fileToken: flag.fileToken };
  }

  const excerpt = file.lines.slice(flag.lineStart - 1, flag.lineEnd);
  const joined = excerpt.join("\n");

  // A flag must not be built on redacted content: the model never saw the real
  // bytes there, so any claim about them is unfounded by construction.
  if (excerpt.some((line) => line.includes(REDACTION_MARKER))) {
    return { reason: "quote_in_redacted_region", fileToken: flag.fileToken };
  }

  // Whitespace is normalized on both sides. Models reflow indentation when
  // echoing code, and rejecting on that alone would discard true findings.
  const normalize = (value: string): string =>
    value.replace(/\s+/g, " ").trim();

  if (!normalize(joined).includes(normalize(flag.evidenceQuote))) {
    return { reason: "quote_not_present", fileToken: flag.fileToken };
  }

  return { flag, file, excerpt };
}

/**
 * Grounds a raw scout response.
 *
 * Input is `unknown` on purpose: parsing and grounding belong together, so a
 * caller cannot accidentally trust a shape that was never validated.
 */
export function groundScoutFlags(
  rawFlags: readonly unknown[],
  pack: ScoutPack,
): GroundingResult {
  const byToken = new Map(pack.files.map((file) => [file.fileToken, file]));
  const grounded: GroundedFlag[] = [];
  const rejected: {
    reason: GroundingRejection;
    fileToken: number | null;
  }[] = [];
  const seen = new Set<string>();

  for (const raw of rawFlags) {
    const parsed = aiScoutFlagSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ reason: "malformed", fileToken: null });
      continue;
    }
    const outcome = groundOne(parsed.data, byToken);
    if ("reason" in outcome) {
      rejected.push(outcome);
      continue;
    }
    // Collapse duplicates: a scout often reports the same span twice under
    // different CWEs, and judging it twice wastes the scarcest budget we have.
    const key = `${String(parsed.data.fileToken)}:${String(parsed.data.lineStart)}:${String(parsed.data.lineEnd)}:${parsed.data.cwe}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grounded.push(outcome);
  }

  return { grounded, rejected };
}
