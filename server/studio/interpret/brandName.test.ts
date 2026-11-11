/**
 * brandIdForName — the brand she named, as its row: exactly one match or nothing (interpreter, I.4).
 * Real SQL on PGlite; every row synthetic.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { inboxBrands } from "../../../shared/schema";
import { closeTestDb, db, initTestDb } from "../../testUtils/pgliteDb";
import { brandIdForName } from "./brandName";

/** `normalized_name` is UNIQUE; each synthetic row gets its own, so two rows may share a name. */
let seq = 0;
async function brand(
  name: string,
  opts: { agency?: boolean | null } = {},
): Promise<number> {
  const [row] = await db
    .insert(inboxBrands)
    .values({
      name,
      normalized_name: `synthetic-${++seq}`,
      ...(opts.agency === undefined ? {} : { is_agency: opts.agency }),
    })
    .returning({ id: inboxBrands.id });
  return row.id;
}

beforeAll(async () => {
  await initTestDb();
});
afterAll(async () => {
  await closeTestDb();
});

describe("brandIdForName", () => {
  it("finds the one advertiser with that name, whatever her casing or spacing", async () => {
    const id = await brand("Synthbrand Alpha");
    expect(await brandIdForName("synthbrand alpha")).toBe(id);
    expect(await brandIdForName("  SYNTHBRAND ALPHA ")).toBe(id);
  });

  it("matches the whole name only — never a prefix, never a longer name", async () => {
    await brand("Synthbrand Beta Tech");
    expect(await brandIdForName("synthbrand beta")).toBeNull();
    await brand("Synthbrand Gamma");
    expect(await brandIdForName("synthbrand gamma tech")).toBeNull();
  });

  it("answers nothing when two advertisers share the name — never a guess between them", async () => {
    await brand("Synthbrand Delta");
    await brand("SYNTHBRAND DELTA");
    expect(await brandIdForName("synthbrand delta")).toBeNull();
  });

  it("never answers with an agency row, and an agency does not make a real one ambiguous", async () => {
    await brand("Synthbrand Epsilon", { agency: true });
    expect(await brandIdForName("synthbrand epsilon")).toBeNull();
    const real = await brand("Synthbrand Zeta", { agency: false });
    await brand("Synthbrand Zeta", { agency: true });
    expect(await brandIdForName("synthbrand zeta")).toBe(real);
    const unset = await brand("Synthbrand Eta", { agency: null });
    expect(await brandIdForName("synthbrand eta")).toBe(unset);
  });

  it("answers nothing for no name and for a name with no row", async () => {
    expect(await brandIdForName("")).toBeNull();
    expect(await brandIdForName("   ")).toBeNull();
    expect(await brandIdForName("synthbrand nowhere")).toBeNull();
  });
});
