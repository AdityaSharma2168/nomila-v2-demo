/**
 * evals/agent/postKit/loadPostKitCases.ts — load and check the post-kit cases (evals/agent/postKit/cases/*.json): the
 * file name is the id; keys and descriptions are unique (the mock re-rank finds an asset by its description); every key
 * an expectation or the mock names exists; a clip has a length; brands are "$partner" / "$rival" only, never a real
 * name. Throws on the first broken file, naming it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { POST_FORMATS } from "../../../shared/postKit";
import type { PostKitCase } from "./types";

export const POST_KIT_CASES_DIR = join(__dirname, "cases");

export function loadPostKitCases(dir: string = POST_KIT_CASES_DIR): PostKitCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as PostKitCase;
    const where = `post-kit case ${f}`;
    if (`${c.id}.json` !== f) throw new Error(`${where}: id "${c.id}" must equal the file name`);
    if (!c.description?.trim()) throw new Error(`${where}: needs a description`);
    if (!c.post?.what || !c.post?.body || !c.post?.platform) throw new Error(`${where}: post needs what, body and platform`);
    const keys = c.library.map((a) => a.key);
    if (new Set(keys).size !== keys.length) throw new Error(`${where}: library keys must be unique`);
    if (new Set(c.library.map((a) => a.description)).size !== c.library.length) throw new Error(`${where}: descriptions must be unique`);
    for (const a of c.library) {
      if (a.kind === "clip" && !(typeof a.duration === "number" && a.duration > 0)) throw new Error(`${where}: clip ${a.key} needs a duration`);
      for (const b of a.brands ?? []) if (b !== "$partner" && b !== "$rival") throw new Error(`${where}: ${a.key} names a brand; use "$partner" or "$rival"`);
    }
    if (c.post.partner && c.post.partner !== "$partner") throw new Error(`${where}: the partner is "$partner"`);
    if (c.post.moment?.format && !(POST_FORMATS as readonly string[]).includes(c.post.moment.format)) throw new Error(`${where}: unknown format`);
    const named = [...(c.expect.any_of ?? []), ...c.expect.must_not, ...(c.expect.avoid_picking ?? []), ...Object.keys(c.expect.clip_within ?? {}), ...c.mock.picks.map((p) => p.key)];
    for (const k of named) if (!keys.includes(k)) throw new Error(`${where}: refers to ${k}, which the library does not have`);
    if (typeof c.expect.ai_needed !== "boolean") throw new Error(`${where}: expect.ai_needed must be true or false`);
    return c;
  });
}
