/**
 * `npm run studio:phrasebook` — writes docs/studio/phrasebook.md from cases.json (see ./build.ts). $0: rules and the
 * engine's price table only; no model, no database, no network.
 */
import { writeFileSync } from "node:fs";
import { PHRASEBOOK_PATH, loadCases, renderPhrasebook } from "./build";

writeFileSync(PHRASEBOOK_PATH, renderPhrasebook(loadCases()));
console.log(`wrote ${PHRASEBOOK_PATH}`);
