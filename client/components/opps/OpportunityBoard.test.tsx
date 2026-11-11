/**
 * OpportunityBoard, rendered (owner's iPhone pass, 7 Oct 2026): the tab root's title rides at the top of the board's
 * scroll; swipe down refetches the board; In motion rows take the SAME logo source as the cards and the detail (the
 * brand's own-domain logo, through LogoMark's chain); a card's foot never repeats "since …"; "More opportunities" with a
 * short "<N> more · <M> filed" line whose "filed" opens the filed view. The data hook and the leaf visuals are mocked.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import type { BoardItem, OpportunityBoard as Board } from "../../hooks/use-opportunity-board";
import { OpportunityBoard } from "./OpportunityBoard";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("../../lib/flags", () => ({ ...jest.requireActual("../../lib/flags"), OPPS_V2: true }));
const replySheets: any[] = [];
jest.mock("./BoardReplySheet", () => ({ BoardReplySheet: (p: any) => { replySheets.push(p); return null; } }));
const logoProps: any[] = [];
jest.mock("../ui/LogoMark", () => ({ LogoMark: (p: any) => { logoProps.push(p); return null; } }));
jest.mock("../../hooks/use-brand-candidate", () => ({ useBrandCandidate: () => ({ data: null }), useBrandDecision: () => ({ mutate: jest.fn() }) }));

let board: Board;
const refetch = jest.fn(async () => undefined);
jest.mock("../../hooks/use-opportunity-board", () => ({ useOpportunityBoard: () => ({ data: board, isLoading: false, error: null, refetch }) }));

const item = (name: string, over: Partial<BoardItem> = {}): BoardItem => ({
  opportunity_id: `o-${name}`,
  brand: { id: 1, name, logo_url: null, category: null, tier: null, research_confirmed: false, image_url: null, safe_logo_url: null, is_person: false },
  deal_ids: ["d1"], lead_deal_id: "d1", lead_thread_id: "t1", qualification: "needs_terms", state: "needs_terms",
  kind: "deal", kind_label: null, poster: "paid", whats_new: null, stage: null, message_count: 2, via: null, channel: "direct",
  standing: "none", line: "Waiting on you since Sep 25", awaiting_response_from: "athlete", her_move_since: "2026-09-25T12:00:00Z",
  overdue: true, going_quiet: false, last_activity_at: "2026-09-25T12:00:00Z", brand_rollup: null, brand_opportunity_ids: [`o-${name}`], ...over,
});

const LOGO = "https://cdn.yoku.app/brand.example/type/logo/w/256/format/png/fallback/lettermark";

beforeEach(() => {
  logoProps.length = 0;
  refetch.mockClear();
  board = {
    whatMatters: [item("Stan Eats")],
    needsTermsBatch: [],
    goingQuiet: [],
    inMotion: [item("Brand A", { stage: "Agreed", brand: { ...item("x").brand, name: "Brand A", research_confirmed: true, logo_url: LOGO, safe_logo_url: LOGO } })],
    explore: [item("Brand B"), item("Brand C")],
    toVerify: [],
    order: [],
    counts: { open: 12, inMotion: 1, toVerify: 1, filed: 113 },
  };
});

function texts(node: any): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.children);
}
const props = () => ({ onOpenItem: jest.fn(), onAskTerms: jest.fn(), onOpenFiltered: jest.fn(), header: <Text>OPPS TITLE</Text> });

it("the tab-root title is the first thing in the board's scroll", () => {
  render(<OpportunityBoard {...props()} />);
  expect(texts(screen.toJSON())[0]).toBe("OPPS TITLE");
});

it("swipe down refetches the board with the shared ink RefreshControl", async () => {
  render(<OpportunityBoard {...props()} />);
  const rc = () => screen.UNSAFE_root.findAll((n: any) => !!n.props?.refreshControl)[0].props.refreshControl;
  expect(rc().props).toMatchObject({ testID: "pull-refresh", tintColor: "#0E0E0E", refreshing: false });
  await act(async () => { rc().props.onRefresh(); });
  expect(refetch).toHaveBeenCalled();
});

it("In motion rows take the brand's own-domain logo — the same source the cards and the detail use", () => {
  render(<OpportunityBoard {...props()} />);
  const row = logoProps.find((p) => p.name === "Brand A");
  expect(row.logoUrl).toBe(LOGO);
});

it("a card says when once: no \"since …\" under the card; the chip and the action stay", () => {
  render(<OpportunityBoard {...props()} />);
  const t = texts(screen.toJSON());
  expect(t).toContain("Waiting on you since Sep 25");
  // The card's own line carries the date; the caption under it does not repeat it.
  expect(t.some((x) => /^since /.test(x) || / · since /.test(x))).toBe(false);
  expect(t.some((x) => /^Waiting \d+ days$/.test(x))).toBe(true);
  expect(t).toContain("Ask for terms");
});

it("More opportunities: \"<N> more · <M> filed\", N the rows below, \"filed\" opens the filed view; no long count line", () => {
  const p = props();
  render(<OpportunityBoard {...p} />);
  const t = texts(screen.toJSON());
  expect(t).toContain("More opportunities");
  expect(t).not.toContain("Everything else");
  expect(t).toContain("2 more · ");
  expect(t).toContain("113 filed");
  expect(t.join(" ")).not.toMatch(/in motion · |to verify · |filed with receipts|See what I filtered out/);
  fireEvent.press(screen.getByTestId("filed-link"));
  expect(p.onOpenFiltered).toHaveBeenCalled();
});

// ── 8 Oct 2026 (owner's phone pass): one heading/count with Home, the action inside its card, the logo chip ──

const findUp = (node: any, test: (n: any) => boolean): any => { for (let n = node; n; n = n.parent) if (test(n)) return n; return null; };

it("What matters next: Home's heading and the board's needsYou count, in plain words (never 'in Nomila’s order')", () => {
  board = { ...board, counts: { ...board.counts, needsYou: 12 } };
  render(<OpportunityBoard {...props()} />);
  const t = texts(screen.toJSON());
  expect(t).toContain("What matters next");
  expect(t).toContain("12 waiting on you, most pressing first.");
  expect(t.join(" ")).not.toMatch(/Nomila’s order|One line, one thing to do| of \d+ open/);
});

it("a new athlete: nothing waiting, no count line", () => {
  board = { ...board, whatMatters: [], inMotion: [], explore: [], needsYou: [], counts: { open: 0, inMotion: 0, toVerify: 0, filed: 0, needsYou: 0 } };
  render(<OpportunityBoard {...props()} />);
  const t = texts(screen.toJSON());
  expect(t).toContain("What matters next");
  expect(t).toContain("Nothing waiting on you right now.");
  expect(t.some((x) => /waiting on you,/.test(x))).toBe(false);
});

it("the card's ONE action sits INSIDE the card, worded by the server's next step; nothing detached below it", () => {
  const signed = item("Brand S", { stage: "Negotiating", next: { action: "confirm_signed", label: "Confirm it’s signed", why: "An e-signature email says every party has signed.", due: null, hers: true }, looks_signed: true });
  board = { ...board, whatMatters: [signed] };
  const p = props();
  render(<OpportunityBoard {...p} />);
  const action = screen.getByTestId(`opp-card-action-${signed.opportunity_id}`);
  expect(texts(action)).toContain("Confirm it’s signed");
  // Its ancestor is the card itself (the pressable carrying the card's label), not a row under the card.
  expect(findUp(action.parent, (n) => typeof n.props?.accessibilityLabel === "string" && n.props.accessibilityLabel.startsWith("Brand S."))).not.toBeNull();
  fireEvent.press(action);
  expect(p.onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ opportunity_id: signed.opportunity_id }));
});

it("a Reply card opens the reply sheet in ONE tap, on the deal's suggested intent; the card body still opens the detail", () => {
  const paid = item("Brand R", { next: { action: "reply", label: "Reply", why: "", due: null, hers: true },
    actions: [{ intent: "accept_terms", label: "Accept terms" }, { intent: "counter", label: "Counter" }, { intent: "decline", label: "Decline" }] });
  board = { ...board, whatMatters: [paid] };
  replySheets.length = 0;
  const p = props();
  render(<OpportunityBoard {...p} />);
  fireEvent.press(screen.getByTestId(`opp-card-action-${paid.opportunity_id}`));
  expect(p.onOpenItem).not.toHaveBeenCalled();
  expect(replySheets.at(-1)).toMatchObject({ intent: "accept_terms", item: expect.objectContaining({ opportunity_id: paid.opportunity_id }) });
  fireEvent.press(screen.getByLabelText(/^Brand R\./));
  expect(p.onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ opportunity_id: paid.opportunity_id }));
});

it("an older server (no next step): the card still carries its action inside, from the card's state", () => {
  render(<OpportunityBoard {...props()} />);
  expect(texts(screen.getByTestId("opp-card-action-o-Stan Eats"))).toContain("Ask for terms");
});

it("the logo chip: a photo card shows the brand's logo; a poster with an evidence domain shows that domain's mark", () => {
  const photo = item("Brand P", { brand: { ...item("x").brand, name: "Brand P", research_confirmed: true, image_url: "https://img.example/cover.jpg", logo_url: LOGO, safe_logo_url: LOGO, domain: "brand.example" } });
  const domainOnly = item("Brand D", { brand: { ...item("x").brand, name: "Brand D", safe_logo_url: "https://www.google.com/s2/favicons?domain=d.example&sz=128", domain: "d.example" } });
  const none = item("Brand N");
  board = { ...board, whatMatters: [photo, domainOnly, none], inMotion: [], explore: [] };
  render(<OpportunityBoard {...props()} />);
  expect(logoProps.find((p) => p.name === "Brand P")).toMatchObject({ logoUrl: LOGO, domain: "brand.example" });
  expect(logoProps.find((p) => p.name === "Brand D")).toMatchObject({ domain: "d.example" });
  // No logo source and no domain: no chip (the poster keeps its monogram; a domain is never guessed from a name).
  expect(logoProps.find((p) => p.name === "Brand N")).toBeUndefined();
});
