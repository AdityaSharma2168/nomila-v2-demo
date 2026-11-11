/**
 * OpportunityDetailScreen, rendered: the letter's order, ONE primary action with subordinate secondaries,
 * verify-first's Decline-primary hierarchy, "Looks signed" changing state only on her Yes, and no email text
 * (the Conversation row opens the live thread). The network boundary (apiRequest) and the data hooks are mocked.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaView, StyleSheet } from "react-native";
import type { OpportunityDetail } from "../hooks/use-opportunity-detail";
import { OpportunityDetailScreen } from "./OpportunityDetailScreen";
import { apiRequest } from "../lib/query-client";

jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }) }));
jest.mock("../lib/query-client", () => ({ apiRequest: jest.fn(async () => ({ json: async () => null })) }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { SafeAreaView: ({ children }: any) => React.createElement(View, null, children), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("../components/ui/LogoMark", () => ({ LogoMark: () => null }));
jest.mock("../lib/haptics", () => {
  const noop = () => {};
  return { haptics: { tap: noop, press: noop, select: noop, success: noop, warning: noop, error: noop } };
});
jest.mock("../components/deals/DealActionSheet", () => ({ DealActionSheet: () => null }));
const contractSheet = jest.fn();
jest.mock("../components/deals/AddContractSheet", () => ({ AddContractSheet: (p: any) => { contractSheet(p); return null; } }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock("../hooks/use-deals", () => ({ useDeals: () => ({ deals: [{ id: "d1", threadId: "t1", brandName: "INIU" }] }) }));
jest.mock("../hooks/use-brand-candidate", () => ({ useBrandCandidate: () => ({ data: null }), useBrandDecision: () => ({ mutate: jest.fn() }) }));

let brandPage: any = null;
const refetchBrand = jest.fn(async () => undefined);
jest.mock("../hooks/use-brand-page", () => ({
  useBrandPage: () => ({ data: brandPage, refetch: refetchBrand }),
  brandPageKey: (id: string) => `/api/v1/me/opportunities/${id}/brand`,
}));
jest.mock("../hooks/use-deal-attachments", () => ({ fetchAttachmentUrl: jest.fn(async () => "https://signed.example/x.pdf") }));

let current: OpportunityDetail;
const refetchDetail = jest.fn(async () => undefined);
jest.mock("../hooks/use-opportunity-detail", () => ({
  useOpportunityDetail: () => ({ data: current, isLoading: false, error: null, refetch: refetchDetail }),
  opportunityDetailKey: (id: string) => `/api/v1/me/opportunities/${id}`,
}));

const base = (over: Partial<OpportunityDetail> = {}): OpportunityDetail => ({
  item: {
    opportunity_id: "o1",
    brand: { id: 7, name: "INIU", logo_url: null, category: null, tier: null, research_confirmed: false, image_url: null, safe_logo_url: null, is_person: false },
    deal_ids: ["d1"], lead_deal_id: "d1", lead_thread_id: "t1", qualification: "needs_terms", state: "needs_terms",
    kind: "deal", kind_label: null, poster: "paid", whats_new: { at: "2026-08-26T12:00:00Z", text: "INIU sent 2 unanswered emails; you haven't replied." },
    stage: null, message_count: 2, via: null, channel: "agency", standing: "none", line: "…",
    awaiting_response_from: "athlete", her_move_since: "2026-08-26T12:00:00Z", overdue: true, going_quiet: false, brand_rollup: null, brand_opportunity_ids: ["o1"], last_activity_at: "2026-08-26T12:00:00Z",
  },
  ask: "1 video + 3-month bio link + copyright license",
  reasons: [{ text: "The brand is asking for your rates.", source: "qualification" }],
  unknowns: ["fee", "dates"],
  take: "Ask what they need before any number.",
  primary: { action: "ask_for_terms", label: "Ask for terms" },
  secondary: [{ action: "decline", label: "Decline" }],
  draft: null, terms: null, looks_signed: false, lead_deal_id: "d1", lead_thread_id: "t1",
  signed_evidence: [], signed_target_deal_id: "d1", signed: null, contract_candidate: null, has_contract: false,
  deck: { confirmed: false, name: "INIU", category: null, description: null, audience: null, sports: [], athletes: [], images: [], unconfirmed_reason: "The emails came through an agency." },
  ...over,
});

/** The rendered text in document order (the ScrollView's refreshControl prop holds a React element, so no JSON.stringify). */
function texts(node: any): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.children);
}

const props = () => ({ opportunityId: "o1", onBack: jest.fn(), onOpenThread: jest.fn() });

it("renders the letter in the approved order", () => {
  current = base();
  render(<OpportunityDetailScreen {...props()} />);
  const order = ["What’s new · Aug 26, 2026", "What they asked", "Why it’s here", "Not known yet", "Nomila’s take", "Ask for terms", "Conversation"];
  const ys = order.map((t) => screen.getByText(t));
  // Same parent tree order = document order in the rendered JSON.
  const json = texts(screen.toJSON()).join("|");
  const idx = order.map((t) => json.indexOf(t));
  expect(ys).toHaveLength(order.length);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
});

it("one primary action; secondaries are links, not buttons of equal weight", () => {
  current = base();
  render(<OpportunityDetailScreen {...props()} />);
  expect(screen.getAllByText("Ask for terms")).toHaveLength(1);
  expect(screen.getByText("Decline")).toBeTruthy();
});

it("verify first: Decline is the primary, asking who they are is secondary", () => {
  current = base({ primary: { action: "decline", label: "Decline" }, secondary: [{ action: "verify", label: "Ask who they are" }],
    item: { ...base().item, qualification: "verify_first", channel: "unverifiable" } });
  const p = props();
  render(<OpportunityDetailScreen {...p} />);
  expect(screen.getByText("Decline")).toBeTruthy();
  fireEvent.press(screen.getByText("Ask who they are"));
  expect(p.onOpenThread).toHaveBeenCalledWith("t1", "INIU");
  expect(screen.getByText("What doesn’t add up")).toBeTruthy();
});

it("Looks signed changes state only on her Yes", () => {
  current = base({ looks_signed: true });
  render(<OpportunityDetailScreen {...props()} />);
  expect(apiRequest).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText("Not yet"));
  expect(apiRequest).not.toHaveBeenCalled();
  expect(screen.queryByText("Looks signed — confirm?")).toBeNull();
});

it("one primary at a time: while 'Looks signed' is up, Yes is the primary and the action steps down; Not yet restores it", () => {
  current = base({ looks_signed: true, primary: { action: "reply", label: "Reply" }, secondary: [], item: { ...base().item, stage: "Negotiating" } });
  render(<OpportunityDetailScreen {...props()} />);
  const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style);
  // the action is outlined (secondary), not the raspberry fill (the one look: the main action is Bold.act)
  expect(flat("detail-action")).toMatchObject({ backgroundColor: "#FFFFFF", borderWidth: 2 });
  expect(screen.getByText("Yes, it’s signed")).toBeTruthy();
  fireEvent.press(screen.getByText("Not yet"));
  expect(flat("detail-action")).toMatchObject({ backgroundColor: "#C8325A" });
});

it("a deal under way has no 'Deal details' (no second detail screen), even from an older server's secondary", () => {
  current = base({ item: { ...base().item, stage: "Agreed" }, primary: { action: "reply", label: "Reply" }, secondary: [{ action: "open_deal" as any, label: "Deal details" }] });
  render(<OpportunityDetailScreen {...props()} />);
  expect(screen.queryByText("Deal details")).toBeNull();
});

it("her Yes posts to the governed signed endpoint for the TARGET deal (not the lead), saying why it looks signed", async () => {
  (apiRequest as jest.Mock).mockClear();
  current = base({ looks_signed: true, signed_target_deal_id: "d9",
    signed_evidence: [{ kind: "legacy_esign", deal_id: "d9", thread_id: "t5", at: null }] });
  render(<OpportunityDetailScreen {...props()} />);
  expect(screen.getByText(/An e-signature email says every party has signed/)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText("Yes, it’s signed")); });
  expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/opportunities/o1/signed", { deal_id: "d9" });
  expect((apiRequest as jest.Mock).mock.calls.some((c) => c[0] === "PATCH")).toBe(false);
});

it("after signing, reading the signed PDF is offered — and only her tap opens the contract review", () => {
  (apiRequest as jest.Mock).mockClear();
  contractSheet.mockClear();
  current = base({ signed: { deal_id: "d9", at: "2026-10-07T00:00:00Z", source: "confirmed" },
    contract_candidate: { thread_id: "t5", message_id: "m5", index: 0, filename: "Release - signed.pdf", at: null } });
  render(<OpportunityDetailScreen {...props()} />);
  expect(screen.getByText("Read the signed contract into your terms?")).toBeTruthy();
  expect(contractSheet).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText("Read it"));
  expect(contractSheet).toHaveBeenCalledWith(expect.objectContaining({ dealId: "d9", attachment: { messageId: "m5", index: 0 } }));
  expect(apiRequest).not.toHaveBeenCalled();
});

it("no offer to read once the deal already holds a contract", () => {
  current = base({ signed: { deal_id: "d9", at: "2026-10-07T00:00:00Z", source: "contract" }, has_contract: true,
    contract_candidate: { thread_id: "t5", message_id: "m5", index: 0, filename: "x - signed.pdf", at: null } });
  render(<OpportunityDetailScreen {...props()} />);
  expect(screen.queryByText("Read the signed contract into your terms?")).toBeNull();
});

it("Conversation opens the live thread; no stored email text is rendered", () => {
  current = base();
  const p = props();
  render(<OpportunityDetailScreen {...p} />);
  expect(screen.getByText(/read live from your inbox/)).toBeTruthy();
  fireEvent.press(screen.getByText("Conversation"));
  expect(p.onOpenThread).toHaveBeenCalledWith("t1", "INIU");
});

it("one message: no What's new", () => {
  current = base({ item: { ...base().item, message_count: 1 } });
  render(<OpportunityDetailScreen {...props()} />);
  expect(screen.queryByText(/What’s new/)).toBeNull();
});

describe("the brand page: several deals with one brand", () => {
  const section = (over: any) => ({
    opportunity_id: "o1", opportunity_status: "open", deal_id: "d1", label: "New", pitched_by_you: false, take: "Reply to them.",
    primary: { action: "open_thread", label: "Reply" }, needs_her: false, looks_signed: false, signed: null, signed_evidence: [],
    contract_candidate: null, has_contract: false, paperwork: [], conversation: { thread_id: "t1", message_count: 2, last_at: null, chains: [] },
    last_activity_at: "2026-10-06T00:00:00Z", shares_opportunity: false, ...over,
  });
  afterEach(() => { brandPage = null; });

  it("renders one section per deal, opens the one that needs her, and shows the signed deal's paperwork when opened", () => {
    current = base();
    brandPage = { brand: { id: 7, name: "gorjana" }, open_section: "d2", sections: [
      section({ deal_id: "d2", opportunity_id: "o2", pitched_by_you: true, needs_her: true, take: "Answer their question first." }),
      section({ deal_id: "d1", opportunity_status: "won", label: "Signed", signed: { at: "2026-10-07", source: "confirmed" },
        paperwork: [{ thread_id: "p1", event: "completed", label: "Signed by all parties", at: "2026-08-15T00:00:00Z", files: [{ message_id: "m1", index: 0, filename: "Release - signed.pdf", signed: true }] }] }),
    ] };
    render(<OpportunityDetailScreen {...props()} />);
    expect(screen.getByText("2 deals with gorjana")).toBeTruthy();
    expect(screen.getByText("Pitched by you")).toBeTruthy();
    expect(screen.getByText("Answer their question first.")).toBeTruthy();
    // The letter is replaced by the sections.
    expect(screen.queryByText("What they asked")).toBeNull();
    expect(screen.queryByText("Signed by all parties")).toBeNull();
    fireEvent.press(screen.getByText("Signed"));
    expect(screen.getByText("Signed by all parties")).toBeTruthy();
    expect(screen.getByText("Release - signed.pdf")).toBeTruthy();
  });

  it("a section that looks signed: Yes is the one primary, its Reply is outlined; no 'Deal details' link", () => {
    current = base();
    brandPage = { brand: { id: 7, name: "Brand G" }, open_section: "d2", sections: [
      section({ deal_id: "d2", opportunity_id: "o2", needs_her: true, looks_signed: true, label: "Negotiating", signed_evidence: [{ kind: "paperwork", deal_id: "d2", thread_id: "p9", at: null }] }),
      section({ deal_id: "d1", label: "New" }),
    ] };
    render(<OpportunityDetailScreen {...props()} />);
    expect(screen.getByText("Yes, it’s signed")).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId("section-action-d2").props.style)).toMatchObject({ backgroundColor: "#FFFFFF", borderWidth: 2 });
    expect(screen.queryByText("Deal details")).toBeNull();
  });

  it("Yes on a section posts to that section's opportunity and deal", async () => {
    (apiRequest as jest.Mock).mockClear();
    current = base();
    brandPage = { brand: { id: 7, name: "gorjana" }, open_section: "d1", sections: [
      section({ deal_id: "d1", looks_signed: true, needs_her: true, signed_evidence: [{ kind: "paperwork", deal_id: "d1", thread_id: "p1", at: null }] }),
      section({ deal_id: "d2", opportunity_id: "o2" }),
    ] };
    render(<OpportunityDetailScreen {...props()} />);
    await act(async () => { fireEvent.press(screen.getByText("Yes, it’s signed")); });
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/opportunities/o1/signed", { deal_id: "d1" });
  });

  it("a chain folded into a single deal offers 'This is a separate deal' — and splits only after she confirms", async () => {
    (apiRequest as jest.Mock).mockClear();
    const { Alert } = require("react-native");
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    current = base();
    brandPage = { brand: { id: 7, name: "gorjana" }, open_section: "d1", sections: [
      section({ conversation: { thread_id: "t1", message_count: 65, last_at: null, chains: [
        { chain_id: "19fac", main: true, message_count: 63, first_at: "2026-07-29T00:00:00Z", last_at: null, first_direction: "inbound" },
        { chain_id: "1a10dc60", main: false, message_count: 2, first_at: "2026-10-05T00:00:00Z", last_at: null, first_direction: "outbound" },
      ] } }),
    ] };
    render(<OpportunityDetailScreen {...props()} />);
    expect(screen.getByText(/you wrote first/)).toBeTruthy();
    fireEvent.press(screen.getByText("This is a separate deal"));
    expect(apiRequest).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => Promise<void> }>;
    await act(async () => { await buttons.find((b) => b.text === "Separate it")!.onPress!(); });
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/deals/d1/split", { chain: "1a10dc60" });
    alert.mockRestore();
  });

  it("one deal: the letter exactly as before, plus its paperwork when there is any", () => {
    current = base();
    brandPage = { brand: { id: 7, name: "INIU" }, open_section: "d1", sections: [
      section({ paperwork: [{ thread_id: "p1", event: "signature_requested", label: "Sent for signature", at: "2026-08-12T00:00:00Z", files: [] }] }),
    ] };
    render(<OpportunityDetailScreen {...props()} />);
    expect(screen.getByText("What they asked")).toBeTruthy();
    expect(screen.getByText(/Sent for signature/)).toBeTruthy();
  });

  it("a calendar invite shows on the deal's timeline as a call, never as its own deal", () => {
    current = base();
    brandPage = { brand: { id: 7, name: "gorjana" }, open_section: "d1", sections: [
      section({ paperwork: [{ thread_id: "c1", event: "meeting", label: "Call · Mon 12 Oct, 11am", at: "2026-10-08T03:32:29Z", files: [] }] }),
      section({ deal_id: "d2", opportunity_id: "o2", paperwork: [
        { thread_id: "c2", event: "meeting", label: "Call · Tue 13 Oct, 2pm", at: "2026-10-08T00:00:00Z", files: [] },
        { thread_id: "p2", event: "signature_requested", label: "Sent for signature", at: "2026-08-12T00:00:00Z", files: [] },
      ] }),
    ] };
    render(<OpportunityDetailScreen {...props()} />);
    expect(screen.getByText("2 deals with gorjana")).toBeTruthy();
    expect(screen.getByText("Calls")).toBeTruthy();
    expect(screen.getByText("Call · Mon 12 Oct, 11am")).toBeTruthy();
    expect(screen.getByText(/Invite received/)).toBeTruthy();
  });
});

describe("timelineTitle", () => {
  const { timelineTitle } = require("../components/opps/BrandSections");
  it("Paperwork, Calls, or Timeline when mixed", () => {
    expect(timelineTitle([{ event: "completed" }])).toBe("Paperwork");
    expect(timelineTitle([{ event: "meeting" }])).toBe("Calls");
    expect(timelineTitle([{ event: "meeting" }, { event: "reminder" }])).toBe("Timeline");
  });
});

describe("sectionMeta", () => {
  const { sectionMeta } = require("../components/opps/BrandSections");
  it("shows when the deal started and when it was signed, not its last activity", () => {
    expect(sectionMeta({ opportunity_status: "won", started_at: "2026-07-29T05:02:08Z", signed: { at: "2026-08-15T02:02:45Z", source: "confirmed" }, last_activity_at: "2026-10-08T03:28:52Z" }))
      .toBe("Closed as won · Started Jul 29, 2026 · Signed Aug 15, 2026");
    expect(sectionMeta({ opportunity_status: "open", started_at: "2026-10-05T20:42:55Z", signed: null, last_activity_at: "2026-10-08T03:28:27Z" }))
      .toBe("Started Oct 5, 2026");
  });
  it("an older server without started_at keeps the last-activity date", () => {
    expect(sectionMeta({ opportunity_status: "open", signed: null, last_activity_at: "2026-09-30T21:45:05Z" })).toBe("Sep 30, 2026");
  });
});

// ── Shell consistency pass (owner's iPhone test, 7 Oct 2026) ─────────────────────────────────────────────────────────

const flat = (style: any) => StyleSheet.flatten(style) ?? {};
const allText = () => texts(screen.toJSON()).join("|");

it("the back control is the shared pushed-screen bar, inside the safe area: ‹ OPPORTUNITIES, 52 high, 16 gutter", () => {
  current = base();
  const p = props();
  render(<OpportunityDetailScreen {...p} />);
  // The root is a SafeAreaView, so the bar can never sit under the status bar.
  expect(screen.UNSAFE_getAllByType(SafeAreaView).length).toBeGreaterThan(0);
  expect(screen.getByTestId("opportunity-detail").type).toBeDefined();
  const bar = screen.getByTestId("stack-header");
  expect(flat(bar.props.style)).toMatchObject({ height: 52, paddingHorizontal: 16 });
  expect(screen.getByText("Opportunities")).toBeTruthy();
  fireEvent.press(screen.getByTestId("stack-header-back"));
  expect(p.onBack).toHaveBeenCalled();
});

it("Why it's here: plain athlete-facing sources; an older server's pipeline names never reach the screen", () => {
  current = base({ reasons: [
    { text: "The brand is asking for your rates.", source: "qualification" },
    { text: "Jelly Otter wrote for them.", source: "the classifier · channel" },
    { text: "Waiting on you since Aug 26.", source: "timing" },
    { text: "A request of you, not a sale.", source: "the classifier · kind" },
    { text: "Something else.", source: "the classifier · mystery" },
  ] });
  render(<OpportunityDetailScreen {...props()} />);
  const t = allText();
  expect(t).toContain("from their email");
  expect(t).toContain("from the sender’s address");
  expect(t).toContain("from the dates");
  expect(t).not.toMatch(/classifier/i);
  expect(t).not.toMatch(/qualification/i);
  expect(screen.queryByText("timing")).toBeNull();
});

it("What's new is hidden when the server sends none, even with several messages", () => {
  current = base({ item: { ...base().item, whats_new: null, message_count: 3 } });
  render(<OpportunityDetailScreen {...props()} />);
  expect(screen.queryByText(/What’s new/)).toBeNull();
});

it("swipe down refetches this opportunity with the shared ink RefreshControl", async () => {
  current = base();
  refetchDetail.mockClear();
  render(<OpportunityDetailScreen {...props()} />);
  const rc = () => screen.UNSAFE_root.findAll((n: any) => !!n.props?.refreshControl)[0].props.refreshControl;
  expect(rc().props).toMatchObject({ testID: "pull-refresh", tintColor: "#0E0E0E", refreshing: false });
  refetchBrand.mockClear();
  await act(async () => { rc().props.onRefresh(); });
  expect(refetchDetail).toHaveBeenCalled();
  expect(refetchBrand).toHaveBeenCalled(); // the brand page's sections refresh too
});

it("an unconfirmed brand's poster is about half a deck; a confirmed brand's deck keeps the full height", () => {
  const { POSTER_HEIGHT } = require("../components/opps/OppDeck");
  current = base();
  const a = render(<OpportunityDetailScreen {...props()} />);
  expect(flat(screen.getByTestId("opp-poster").props.style).minHeight).toBe(POSTER_HEIGHT);
  expect(POSTER_HEIGHT).toBe(Math.round(372 / 2));
  a.unmount();
  current = base({ item: { ...base().item, brand: { ...base().item.brand, research_confirmed: true } },
    deck: { ...base().deck, confirmed: true, images: ["https://x/1.jpg"], description: "A brand." } });
  render(<OpportunityDetailScreen {...props()} />);
  expect(screen.queryByTestId("opp-poster")).toBeNull();
  expect(screen.getByText("Opportunities")).toBeTruthy();
});
