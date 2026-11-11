/**
 * latestOffer — the one money number a deal action anchors on. Pure.
 */
jest.mock("../db", () => ({ db: {} })); // pure: pickLatestOffer never touches the database

import { pickLatestOffer } from "./latestOffer";

const cs = (amount: unknown) => ({ key_details: { offer_struct: { amount } } });

describe("pickLatestOffer", () => {
  it("the latest offer on the thread wins over the stale detection snapshot", () => {
    // Brand opened at $200, came up to $950: the draft and the payment must see $950.
    expect(pickLatestOffer({ amount: "200", source: "inbox_scan" }, [{ conversation_state: cs(950) }]))
      .toEqual({ amount: 950, source: "thread" });
  });

  it("a figure she confirmed (contract / entered deal) wins over the thread", () => {
    expect(pickLatestOffer({ amount: "1200", source: "contract_upload" }, [{ conversation_state: cs(950) }]))
      .toEqual({ amount: 1200, source: "confirmed" });
    expect(pickLatestOffer({ amount: "1200", source: "inbox_scan", raw_data: { confirmed: { by: "athlete" } } }, [{ conversation_state: cs(950) }]))
      .toEqual({ amount: 1200, source: "confirmed" });
  });

  it("the most recently active thread that states an offer decides", () => {
    const threads = [
      { conversation_state: cs(500), last_message_at: "2026-10-01T00:00:00Z" },
      { conversation_state: cs(null), last_message_at: "2026-10-09T00:00:00Z" },
      { conversation_state: cs(800), last_message_at: "2026-10-05T00:00:00Z" },
    ];
    expect(pickLatestOffer({ amount: null }, threads)).toEqual({ amount: 800, source: "thread" });
  });

  it("falls back to deals.amount only when nothing newer exists; null when nothing at all", () => {
    expect(pickLatestOffer({ amount: "300" }, [{ conversation_state: null }])).toEqual({ amount: 300, source: "deal_row" });
    expect(pickLatestOffer({ amount: null }, [])).toBeNull();
    expect(pickLatestOffer({ amount: "0" }, [{ conversation_state: cs("abc") }])).toBeNull();
  });
});
