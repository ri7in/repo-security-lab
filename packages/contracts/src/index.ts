/**
 * Versioned shared contracts for the product.
 *
 * Every schema here is a Zod validator plus an inferred type. Hosted DTO and
 * broker schemas are strict and closed: they cannot express archive-derived
 * strings, paths, snippets, or secrets, and unknown fields reject the whole
 * document. See `docs/architecture.md` for the boundary rationale.
 */
export { CONTRACTS_SCHEMA_VERSION } from "./version.js";
export * from "./primitives.js";
export * from "./states.js";
export * from "./coverage.js";
export * from "./failure.js";
export * from "./broker.js";
export * from "./api.js";
export * from "./ai.js";
export * from "./scan-domain.js";
