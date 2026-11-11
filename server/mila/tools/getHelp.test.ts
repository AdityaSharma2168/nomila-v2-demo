/**
 * getHelp.test.ts — get_help returns the static capabilities catalog (no DB, no
 * athlete data). The key guarantees: it only references WIRED screens, and it marks
 * the navigate-only screens (Studio / Pitches / Media / Signals — no read tool) as
 * milaCanRead:false so the model can't be led into implying it knows their contents.
 */

import { getHelpTool } from "./getHelp";

const help = () =>
  getHelpTool.execute("athlete-a", {} as never) as Promise<{
    capabilities: { title: string; detail: string }[];
    screens: { screen: string; milaCanRead: boolean }[];
    note: string;
  }>;

const WIRED = ["deals", "score", "signals", "profile", "studio", "pitches", "media"];

describe("get_help tool", () => {
  it("returns capabilities + screens + a guidance note", async () => {
    const r = await help();
    expect(r.capabilities.length).toBeGreaterThan(0);
    expect(r.screens.length).toBeGreaterThan(0);
    expect(typeof r.note).toBe("string");
    expect(r.note.length).toBeGreaterThan(0);
  });

  it("only references the 7 wired screen ids", async () => {
    const { screens } = await help();
    for (const s of screens) expect(WIRED).toContain(s.screen);
  });

  it("marks navigate-only screens (no read tool) as milaCanRead:false", async () => {
    const { screens } = await help();
    const readable = Object.fromEntries(
      screens.map((s) => [s.screen, s.milaCanRead]),
    );
    // Navigate-only — Mila can take you there but can't report on them.
    expect(readable.studio).toBe(false);
    expect(readable.pitches).toBe(false);
    expect(readable.media).toBe(false);
    expect(readable.signals).toBe(false);
    // Backed by a read tool — Mila can answer about these.
    expect(readable.deals).toBe(true);
    expect(readable.score).toBe(true);
    expect(readable.profile).toBe(true);
  });

  it("is athlete-agnostic — the same catalog for everyone", async () => {
    const a = await getHelpTool.execute("athlete-a", {} as never);
    const b = await getHelpTool.execute("athlete-b", {} as never);
    expect(a).toEqual(b);
  });
});
