/**
 * studio-contract.corrective.test.ts — the thread's fresh check carries a failed output's gate codes (quality-scrappy
 * piece 5, ADI-QS-GO): `previewRequestFor` puts `corrective` on the request when the sheet's job has one, and adds no key
 * when it does not — every first check is the request it was.
 *
 * ⚠️ MUTATION M5l: previewRequestFor drops `corrective` — "a Try again's request carries the codes" reds.
 */
import { previewRequestFor } from "./studio-contract";

const base = {
  format: "photo" as const,
  classification: undefined,
  direction: "make it golden hour",
  attachments: [],
  frameAssetId: null,
  interpreter: false,
};

it("a Try again's request carries the codes", () => {
  expect(
    previewRequestFor({ ...base, corrective: ["black", "name_or_handle"] })
      .request.corrective,
  ).toEqual(["black", "name_or_handle"]);
});

it("no corrective, or an empty one: no key — the request it was", () => {
  expect("corrective" in previewRequestFor(base).request).toBe(false);
  expect(
    "corrective" in previewRequestFor({ ...base, corrective: [] }).request,
  ).toBe(false);
});
