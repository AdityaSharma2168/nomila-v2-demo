/**
 * candidateFromResponse — the client reads the server's real answer (services/brandConfirmation.getBrandCandidate:
 * `{ status, candidate: { name, domain, logoUrl, basis } }`). Before 8 Oct it read only a flat `{ name, domain, logo }`,
 * so every real candidate looked like none and "Confirm this is [brand]" never showed.
 */
jest.mock("./../lib/query-client", () => ({ apiRequest: jest.fn() }));
import { candidateFromResponse } from "./use-brand-candidate";

it("the server's view: a candidate with its domain and logo", () => {
  expect(candidateFromResponse({ brandId: 7, name: "Brand X", status: "candidate", candidate: { name: "Brand X", domain: "brandx.example", logoUrl: "https://www.google.com/s2/favicons?domain=brandx.example&sz=128", basis: "name_search" }, confirmed: null, researchIdentity: null, lookup: "not_needed" }))
    .toEqual({ name: "Brand X", domain: "brandx.example", logo: "https://www.google.com/s2/favicons?domain=brandx.example&sz=128" });
});

it("nothing to offer (a lookup started, or already confirmed): no candidate", () => {
  expect(candidateFromResponse({ brandId: 7, name: "Brand X", status: "none", candidate: null, confirmed: null, researchIdentity: null, lookup: "started" })).toBeNull();
  expect(candidateFromResponse({ brandId: 7, name: "Brand X", status: "confirmed_by_you", candidate: null, confirmed: { domain: "brandx.example", at: null }, researchIdentity: null, lookup: "not_needed" })).toBeNull();
  expect(candidateFromResponse(null)).toBeNull();
});

it("the older flat shape still reads", () => {
  expect(candidateFromResponse({ name: "Brand Y", domain: "y.example", logo: null })).toEqual({ name: "Brand Y", domain: "y.example", logo: null });
});
