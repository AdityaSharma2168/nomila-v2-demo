/**
 * PITCH_CONCEPT_V1 (dev only until the owner says): the Nomi Card's creative core comes from the copywriter, grounded in
 * the brand's confirmed research (pitchConcept.ts), and the deck follows the order of the deck that worked. Off:
 * exactly as before. Read per call so the flag stays live. Its own module so the deck planner can read it without
 * loading the model clients.
 */
export function pitchConceptEnabled(): boolean {
  return process.env.PITCH_CONCEPT_V1?.trim().toLowerCase() === "true";
}
