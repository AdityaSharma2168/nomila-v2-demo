/**
 * tileContract.test.ts — the stored grid tile (shared/publicCard.ts PublicGridTile, what the app and the snapshot
 * carry) and the renderer's tile (view.ts PublicTile) are the same shape, in both directions. tsc checks the type
 * assertions (tsconfig.jest.json); the runtime case checks a resolved tile round-trips through the stored type.
 */
import type { PublicGridTile, TileSlot } from "../../../shared/publicCard";
import { TILE_SLOTS } from "../../../shared/publicCard";
import { resolveTileSlots } from "./tiles";
import type { PublicTile, TileSlot as ViewTileSlot } from "./view";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameTile: Same<PublicGridTile, PublicTile> = true;
const sameSlot: Same<TileSlot, ViewTileSlot> = true;

it("the stored tile and the renderer's tile are one shape", () => {
  expect(sameTile && sameSlot).toBe(true);
  const tiles: PublicGridTile[] = resolveTileSlots({ firstName: "Ren", partnerOn: true, bookOn: false, shopOn: false, chapters: [{ id: "highlights", kind: "highlights", title: "Highlights" }], socials: [] });
  expect(tiles.map((t) => t.slot)).toEqual([...TILE_SLOTS]);
});
