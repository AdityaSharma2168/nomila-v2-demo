/**
 * build-landing-sports.ts — writes landing/sports.js (the landing page's sport grid) from shared/sports.ts, the one sport
 * list. Run after changing shared/sports.ts:  npx tsx scripts/build-landing-sports.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { landingSportsModule } from "../shared/sports";

const out = join(__dirname, "..", "landing", "sports.js");
writeFileSync(out, landingSportsModule(), "utf8");
console.log(`wrote ${out}`);
