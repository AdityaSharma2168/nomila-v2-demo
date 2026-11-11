/**
 * context/index.ts — the canonical athlete context (Phase A Step 2d-1). Barrel.
 *
 *   buildCanonicalContext(athleteId) → { ctx, legacy }       the contract (§2.2) + the adapter's legacy bits for parity
 *   recordView / promptView / deckView / searchView / identityView   pure projections (§2.3)
 *   searchAnchorFor, hintsFromSearchView                    the ONE search anchor and the research hints (2d-5)
 *   shadowCompare                                           G1 parity infrastructure (§3.4)
 * No reader consults it through a switch any more (CANONICAL_CONTEXT_READERS / CONTEXT_SHADOW deleted 2 Nov 2026);
 * athleteKnowledge reads the builder directly.
 */

export * from "./contract";
export * from "./coverage";
export { buildCanonicalContext, type BuiltContext } from "./build";
export { identityView, readIdentityView, identityFence, type IdentityView } from "./views/identity";
export { searchView, readSearchView, searchAnchorFor, hintsFromSearchView, type SearchView } from "./views/search";
export { searchInputsFor, type SearchInputs, type LegacySearchInputs } from "./searchInputs";
export { promptView, readPromptExtras, CONTEXT_BLOCK_OPEN, CONTEXT_BLOCK_CLOSE, type PromptView, type PromptPurpose, type PromptExtras } from "./views/prompt";
export { deckView, readDeckExtras, type DeckExtras } from "./views/deck";
export { recordView, readRecordExtras, provenanceOf, type RecordExtras } from "./views/record";
export { CONTEXT_READERS, type ContextReader, shadowCompare, structuralDiff, SHADOW_IGNORE, onboardingFactsForShadow, promptFactsForShadow, recentShadowResults, shadowIdentity, shadowSearch, legacyIdentityFields, identityFieldsForShadow, type ShadowResult, type DiffEntry, type OnboardingFactsLike, type LegacyIdentityRow } from "./shadow";
