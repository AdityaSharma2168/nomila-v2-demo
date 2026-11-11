/**
 * studio/compile — the compile tier: what a native edit SENDS the model, from a frozen intent.
 *
 * A frozen intent (studio/nativeEdit.ts, `FrozenEditIntent`) is the spec: which operations, on which
 * targets, becoming what. This module turns it into the request's model-facing half: the instruction,
 * the manifest that says which image is which, the canvas ratio, and the disclosures she reads when
 * the instruction is less than what she asked for. It reads the brief only for what the request
 * carries (the references, the brand's DO NOTs, the frame's shape), and never her sentence.
 *
 *   templates.ts     CLAUSE_TEMPLATES: one clause template per operation, keyed by operation
 *   preservation.ts  the preservation clause, and which operations waive which of its properties
 *   assemble.ts      clauses → one instruction (scope sentence, preservation last); the native prompt
 *   order.ts         the order one call's clauses compile in: the background, a headline, a look, last
 *   manifest.ts      what each attached image is for, and the "Image N" her object photo is
 *   aspect.ts        the canvas ratio a request pins, on every path
 *   disclosure.ts    what she is told when the model will invent a thing, a brand word was dropped, or her
 *                    product photo is the thing an add places
 *   constraints.ts   what an intent's constraints add: a keep sentence, a DO NOT (the interpreter, I.1)
 *   describe.ts      the card's plain-words lines, from the frozen intent (the interpreter, I.1)
 *   image.ts         the generate, masked-edit and non-native-edit prompt (`buildPrompt`), moved here whole
 *                    from studio/preview.ts, which re-exports it (image-parity)
 *
 * Every output here is pinned byte-for-byte by golden.test.ts.
 */
export { aspectFor, nearestAspect } from "./aspect";
export { buildNativePrompt, compileNativeInstruction } from "./assemble";
export {
  brandDisplay,
  constraintDoNots,
  constraintKeepSentences,
  exclusionClause,
  PRESERVE_PERSON_CLAUSE,
} from "./constraints";
export {
  describeIntent,
  type BrandReason,
  type ChangeTag,
  type DescribedLine,
  type LineProvenance,
  type LineSource,
} from "./describe";
export {
  assumedMoveNote,
  droppedWordsNote,
  inventedObjectNote,
  lookCoversHerNote,
  placedProductNote,
} from "./disclosure";
export { NATIVE_FRAME_LINE, referenceManifest } from "./manifest";
export { sceneLast } from "./order";
export { NATIVE_PRESERVATION, preservationClause } from "./preservation";
export {
  ADD_FRAMING_LINE,
  placedAdds,
  spatialPlace,
  type NativeAddressing,
} from "./templates";
