/**
 * catalog.test.ts — capabilitiesFor(): "content" (post kits, Track E) reads AGENT_POST_KITS and AGENT_V3 at call time
 * and is on only when BOTH are (design "Moments → post kits" §13/§16 step 5); the tiles that stand for a Welcome
 * registry capability (REGISTRY_TILES) agree with the registry for the athlete (available now and open to them).
 */
import { CAPABILITIES, REGISTRY_TILES, capabilitiesFor } from "./catalog";
import { availableNow, capability } from "../welcome/registry";
import { openToAthlete } from "../welcome/turnOn";

const ENV_KEYS = ["AGENT_POST_KITS", "AGENT_V3", "BOOKINGS_ENABLED", "BOOKINGS_PILOT_ATHLETE_IDS", "SHOP_V1", "PUBLIC_CARD"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => { for (const k of ["BOOKINGS_ENABLED", "BOOKINGS_PILOT_ATHLETE_IDS", "SHOP_V1", "PUBLIC_CARD"]) delete process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const content = () => capabilitiesFor().find((c) => c.id === "content");

test("content is unavailable off; available with a screen once AGENT_POST_KITS and AGENT_V3 are both on; nothing else moves", () => {
  delete process.env.AGENT_POST_KITS;
  delete process.env.AGENT_V3;
  const off = capabilitiesFor();
  expect(off).toEqual(CAPABILITIES);
  expect(off.find((c) => c.id === "content")).toMatchObject({ available: false, screen: null });

  process.env.AGENT_POST_KITS = "true";
  process.env.AGENT_V3 = "true";
  const on = capabilitiesFor();
  expect(on.find((c) => c.id === "content")).toMatchObject({ available: true, screen: "studio" });
  // Every other entry is untouched.
  expect(on.filter((c) => c.id !== "content")).toEqual(CAPABILITIES.filter((c) => c.id !== "content"));

  process.env.AGENT_POST_KITS = "false";
  expect(content()).toMatchObject({ available: false, screen: null });
});

test("one flag alone is not enough: the door is the Studio library, dark without AGENT_V3", () => {
  process.env.AGENT_POST_KITS = "true";
  delete process.env.AGENT_V3;
  expect(content()).toMatchObject({ available: false, screen: null });

  delete process.env.AGENT_POST_KITS;
  process.env.AGENT_V3 = "true";
  expect(content()).toMatchObject({ available: false, screen: null });
});

const PILOT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const tile = (id: string, athleteId?: string) => capabilitiesFor(athleteId).find((c) => c.id === id)!;

test("every registry tile names a real registry capability", () => {
  for (const [id, key] of Object.entries(REGISTRY_TILES)) {
    expect(CAPABILITIES.some((c) => c.id === id)).toBe(true);
    expect(capability(key)).toBeDefined();
  }
});

test("the tiles agree with the registry, per athlete, whatever the flags (dev's flags included)", () => {
  for (const flags of [{}, { BOOKINGS_ENABLED: "true", BOOKINGS_PILOT_ATHLETE_IDS: PILOT, SHOP_V1: "true", PUBLIC_CARD: "true" }]) {
    for (const k of ["BOOKINGS_ENABLED", "BOOKINGS_PILOT_ATHLETE_IDS", "SHOP_V1", "PUBLIC_CARD"]) delete process.env[k];
    Object.assign(process.env, flags);
    for (const athleteId of [PILOT, OTHER]) {
      for (const [id, key] of Object.entries(REGISTRY_TILES)) {
        expect([id, athleteId, tile(id, athleteId).available]).toEqual([id, athleteId, availableNow(capability(key)!) && openToAthlete(key, athleteId)]);
      }
    }
  }
});

test("shop is planned, so never a live tile; bookings only for a pilot athlete", () => {
  Object.assign(process.env, { BOOKINGS_ENABLED: "true", BOOKINGS_PILOT_ATHLETE_IDS: PILOT, SHOP_V1: "true", PUBLIC_CARD: "true" });
  expect(tile("shop", PILOT).available).toBe(false);
  expect(tile("bookings", PILOT).available).toBe(true);
  expect(tile("bookings", OTHER).available).toBe(false);
  expect(tile("bookings").available).toBe(false);   // no athlete in hand: fails closed
  expect(tile("public_card", OTHER).available).toBe(true);
  expect(tile("pitch_deck", OTHER).available).toBe(true);
  delete process.env.PUBLIC_CARD;
  expect(tile("public_card", OTHER).available).toBe(false);
});
