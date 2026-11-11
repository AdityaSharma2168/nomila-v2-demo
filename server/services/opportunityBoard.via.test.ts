/** viaOf: the card's "via …" chip names the agency the mail named, never the brand itself. */
// Pure functions only: a stub db, so nothing opens (or outlives) a database.
jest.mock("../db", () => ({ db: {} }));

import { viaOf } from "./opportunityBoard";

describe("viaOf", () => {
  it("names the agency whenever the mail named one", () => {
    expect(viaOf("Golden", "Remedy Organics")).toBe("Golden");
    expect(viaOf(" Broccoli ", "INIU")).toBe("Broccoli");
  });
  it("never repeats the brand and ignores blanks", () => {
    expect(viaOf("Remedy-Organics", "Remedy Organics")).toBeNull();
    expect(viaOf("", "INIU")).toBeNull();
    expect(viaOf(null, "INIU")).toBeNull();
  });
});
