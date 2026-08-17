import type { ZizmorConfidence, ZizmorSeverity } from "./types.js";

export const ZIZMOR_VERSION = "1.29.0";
export const ZIZMOR_SOURCE_COMMIT =
  "3c116961091b50bd1a08ffefe916469d4d90093c";
export const ZIZMOR_LINUX_ARCHIVE_SHA256 =
  "dd96df044a6e8538d5f423790f453bdd03d49e5b2bcc38214acc41a2f1297839";
export const ZIZMOR_LINUX_BINARY_SHA256 =
  "a3331b0a69fc0d8bf8087b0d74d5424602c5a0f2fc2770afe2e908a1295692b5";
export const ZIZMOR_LINUX_ARM64_ARCHIVE_SHA256 =
  "415eaa7c0a06479a701b8e44a3e812c1047decc848ec4bede7bd6bbf49f22d20";
export const ZIZMOR_LINUX_ARM64_BINARY_SHA256 =
  "774a1b9fa2514a5645a9cf7f374f24bd538468436db1be1dd76000ffa8567902";

type Variant = readonly [ZizmorSeverity, ZizmorConfidence];
type Declaration = readonly [string, readonly Variant[]];

/**
 * Closed variant vocabulary reviewed from zizmor 1.29.0's exact audit source.
 * It deliberately contains no descriptions, URLs, locations, fixes, or other
 * strings that can originate in scanner output. Tokens are stable positions
 * in this ordered table and may change only with a reviewed scanner upgrade.
 */
const DECLARATIONS = [
  ["adhoc-packages", [["Low", "High"]]],
  [
    "anonymous-definition",
    [
      ["Informational", "High"],
      ["Low", "High"],
    ],
  ],
  ["archived-uses", [["Medium", "High"]]],
  [
    "artipacked",
    [
      ["Informational", "High"],
      ["Low", "Low"],
      ["Medium", "Low"],
      ["Medium", "High"],
      ["High", "High"],
    ],
  ],
  [
    "bot-conditions",
    [
      ["High", "Medium"],
      ["High", "High"],
    ],
  ],
  ["cache-poisoning", [["High", "Low"]]],
  ["concurrency-limits", [["Low", "High"]]],
  ["dangerous-triggers", [["High", "Medium"]]],
  ["dependabot-cooldown", [["Medium", "High"]]],
  ["dependabot-execution", [["High", "High"]]],
  [
    "excessive-permissions",
    [
      ["Low", "High"],
      ["Medium", "Medium"],
      ["Medium", "High"],
      ["High", "High"],
    ],
  ],
  ["forbidden-uses", [["High", "High"]]],
  [
    "github-app",
    [
      ["High", "Low"],
      ["High", "High"],
    ],
  ],
  ["github-env", [["High", "Low"]]],
  ["hardcoded-container-credentials", [["High", "High"]]],
  ["impostor-commit", [["High", "High"]]],
  [
    "insecure-commands",
    [
      ["High", "Low"],
      ["High", "High"],
    ],
  ],
  ["insecure-url-scheme", [["High", "High"]]],
  [
    "known-vulnerable-actions",
    [
      ["Low", "High"],
      ["Medium", "High"],
      ["High", "High"],
    ],
  ],
  ["misfeature", [["Low", "High"]]],
  [
    "obfuscation",
    [
      ["Informational", "High"],
      ["Low", "High"],
    ],
  ],
  ["overprovisioned-secrets", [["Medium", "High"]]],
  ["ref-confusion", [["Medium", "High"]]],
  [
    "ref-version-mismatch",
    [
      ["Low", "High"],
      ["Medium", "High"],
    ],
  ],
  ["secrets-inherit", [["Medium", "High"]]],
  ["secrets-outside-env", [["Medium", "High"]]],
  [
    "self-hosted-runner",
    [
      ["Medium", "Low"],
      ["Medium", "High"],
    ],
  ],
  ["stale-action-refs", [["Low", "High"]]],
  [
    "superfluous-actions",
    [
      ["Informational", "Low"],
      ["Informational", "Medium"],
      ["Informational", "High"],
    ],
  ],
  [
    "template-injection",
    [
      ["Informational", "Low"],
      ["Low", "Low"],
      ["Low", "High"],
      ["Medium", "Medium"],
      ["Medium", "High"],
      ["High", "High"],
    ],
  ],
  [
    "typosquat-uses",
    [
      ["High", "Low"],
      ["High", "High"],
    ],
  ],
  ["undocumented-permissions", [["Low", "High"]]],
  [
    "unpinned-images",
    [
      ["High", "Low"],
      ["High", "High"],
    ],
  ],
  [
    "unpinned-tools",
    [
      ["Medium", "Low"],
      ["Medium", "High"],
    ],
  ],
  ["unpinned-uses", [["High", "High"]]],
  ["unredacted-secrets", [["Medium", "High"]]],
  ["unsound-condition", [["High", "High"]]],
  [
    "unsound-contains",
    [
      ["Informational", "High"],
      ["High", "High"],
    ],
  ],
  ["unsound-ternary", [["Low", "High"]]],
  ["use-trusted-publishing", [["Informational", "High"]]],
] as const satisfies readonly Declaration[];

const BROKER_SEVERITY = {
  Informational: "info",
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;

const BROKER_CONFIDENCE = {
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;

export const ZIZMOR_VARIANTS = Object.freeze(
  DECLARATIONS.flatMap(([ident, variants]) =>
    variants.map(([severity, confidence]) => ({ ident, severity, confidence })),
  ).map((variant, index) =>
    Object.freeze({ token: index + 1, ...variant }),
  ),
);

const TOKENS = new Map<string, number>(
  ZIZMOR_VARIANTS.map((variant) => [
    `${variant.ident}\0${variant.severity}\0${variant.confidence}`,
    variant.token,
  ]),
);

export const ZIZMOR_BROKER_MANIFEST = Object.freeze(
  ZIZMOR_VARIANTS.map((variant) =>
    Object.freeze({
      token: variant.token,
      ruleId: variant.ident,
      category: "workflow-security",
      severity: BROKER_SEVERITY[variant.severity],
      confidence: BROKER_CONFIDENCE[variant.confidence],
      remediationKey: "harden-workflow",
    }),
  ),
);

export function zizmorVariantToken(
  ident: string,
  severity: ZizmorSeverity,
  confidence: ZizmorConfidence,
): number | null {
  return TOKENS.get(`${ident}\0${severity}\0${confidence}`) ?? null;
}
