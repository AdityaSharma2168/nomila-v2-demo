/**
 * studioTemplateSeedSql — PRINTS the SQL that seeds every Studio template into the `prompts` registry (piece 4's three
 * and piece 8's Create Anything templates, 18 in all), each at its seed's version and reproducing today's literal
 * exactly (server/studio/templates/seeds.ts `seedSql`). It connects to nothing and writes nothing: the output is for Adi
 * to read and run on DEV (quality-scrappy piece 4, ADI-QS-GO — "seed rows are proposed as SQL for me to run on dev, not
 * applied by you").
 *
 *   npx tsx server/scripts/studioTemplateSeedSql.ts [--status draft|published]
 *
 * Default `draft`: the resolver reads published rows only, so a draft row sits inert until it is promoted.
 */
import { seedSql } from "../studio/templates/seeds";

const i = process.argv.indexOf("--status");
const status = i >= 0 ? process.argv[i + 1] : "draft";
if (status !== "draft" && status !== "published")
  throw new Error("--status is draft or published");
console.log(seedSql(status));
