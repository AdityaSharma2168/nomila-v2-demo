/**
 * fakeStripeBookings — an in-memory stand-in for the slice of the Stripe SDK the booking flow uses, installed with
 * `jest.mock("<…>/lib/stripe", () => require("<…>/testUtils/fakeStripeBookings").stripeModule)`. Nothing here touches
 * the network: tests never reach providers.
 *
 * Stateful on purpose, so a test can follow one hold from Checkout → authorization → capture / cancel → refund →
 * transfer and assert the money in cents. Knobs on `fake.mode` force the failure paths (a lapsed hold at capture,
 * Stripe not answering, a refund error). Every call is appended to `fake.calls` with its params and idempotency key.
 */
type Call = { op: string; params: any; key?: string };

interface PI { id: string; amount: number; status: string; capture_method: string; metadata: Record<string, string>; latest_charge: string | null }

export interface FakeStripe {
  calls: Call[];
  mode: { capture: "ok" | "lapsed" | "no_answer"; refund: "ok" | "error"; transfer: "ok" | "error"; feeCents: number; accountReady: boolean };
  paymentIntents: Map<string, PI>;
  sessions: Map<string, any>;
  identity: Map<string, any>;
  reset(): void;
  /** Simulate the buyer finishing a hold Checkout: the PI exists, awaiting capture. Returns the completed session. */
  completeHold(sessionId: string): any;
  /** Simulate the buyer paying a pay-link Checkout (automatic capture). */
  completePay(sessionId: string): any;
  client: any;
}

let seq = 0;
const next = (p: string) => `${p}_${++seq}`;

function create(): FakeStripe {
  const f: FakeStripe = {
    calls: [], mode: { capture: "ok", refund: "ok", transfer: "ok", feeCents: 546, accountReady: true },
    paymentIntents: new Map(), sessions: new Map(), identity: new Map(),
    reset() { f.calls.length = 0; f.mode = { capture: "ok", refund: "ok", transfer: "ok", feeCents: 546, accountReady: true }; },
    completeHold(sessionId) {
      const s = f.sessions.get(sessionId);
      const pi: PI = { id: next("pi"), amount: s.amount_total, status: "requires_capture", capture_method: "manual", metadata: s.payment_intent_data?.metadata ?? s.metadata, latest_charge: null };
      f.paymentIntents.set(pi.id, pi);
      Object.assign(s, { status: "complete", payment_status: "unpaid", payment_intent: pi.id });
      return s;
    },
    completePay(sessionId) {
      const s = f.sessions.get(sessionId);
      const pi: PI = { id: next("pi"), amount: s.amount_total, status: "succeeded", capture_method: "automatic", metadata: s.metadata, latest_charge: next("ch") };
      f.paymentIntents.set(pi.id, pi);
      Object.assign(s, { status: "complete", payment_status: "paid", payment_intent: pi.id });
      return s;
    },
    client: null,
  };
  const log = (op: string, params: any, opts?: { idempotencyKey?: string }) => f.calls.push({ op, params, key: opts?.idempotencyKey });

  f.client = {
    disputes: {
      update: async (id: string, params: any) => { log("disputes.update", { id, ...params }); return { id, ...params }; },
    },
    checkout: {
      sessions: {
        create: async (params: any, opts?: any) => {
          log("checkout.sessions.create", params, opts);
          const id = next("cs");
          const s = { id, url: `https://checkout.stripe.test/${id}`, status: "open", expires_at: params.expires_at, amount_total: params.line_items[0].price_data.unit_amount, metadata: params.metadata, payment_intent_data: params.payment_intent_data, payment_status: "unpaid", payment_intent: null };
          f.sessions.set(id, s);
          return s;
        },
        retrieve: async (id: string) => { log("checkout.sessions.retrieve", { id }); const s = f.sessions.get(id); if (!s) throw new Error("no such session"); return s; },
        expire: async (id: string) => { log("checkout.sessions.expire", { id }); const s = f.sessions.get(id); if (s && s.status === "open") s.status = "expired"; return s; },
      },
    },
    paymentIntents: {
      retrieve: async (id: string) => { log("paymentIntents.retrieve", { id }); const pi = f.paymentIntents.get(id); if (!pi) throw new Error("no such PI"); return { ...pi }; },
      capture: async (id: string, params: any, opts?: any) => {
        log("paymentIntents.capture", { id, ...params }, opts);
        const pi = f.paymentIntents.get(id)!;
        if (f.mode.capture === "no_answer") throw new Error("Stripe did not answer");
        if (f.mode.capture === "lapsed") { pi.status = "canceled"; throw Object.assign(new Error("This PaymentIntent could not be captured"), { code: "payment_intent_unexpected_state" }); }
        if (pi.status === "requires_capture") { pi.status = "succeeded"; pi.latest_charge = next("ch"); }
        return { ...pi };
      },
      cancel: async (id: string, params: any, opts?: any) => {
        log("paymentIntents.cancel", { id, ...params }, opts);
        const pi = f.paymentIntents.get(id);
        if (!pi) throw new Error("no such PI");
        if (pi.status === "canceled") throw Object.assign(new Error("already canceled"), { code: "payment_intent_unexpected_state" });
        pi.status = "canceled";
        return { ...pi };
      },
    },
    refunds: {
      create: async (params: any, opts?: any) => {
        log("refunds.create", params, opts);
        if (f.mode.refund === "error") throw new Error("refund declined");
        return { id: next("re"), amount: params.amount, payment_intent: params.payment_intent };
      },
    },
    charges: {
      retrieve: async (id: string, params?: any) => {
        log("charges.retrieve", { id, ...params });
        return { id, balance_transaction: { id: next("txn"), fee: f.mode.feeCents } };
      },
    },
    transfers: {
      list: async (params: any) => { log("transfers.list", params); return { data: [] }; },
      create: async (params: any, opts?: any) => {
        log("transfers.create", params, opts);
        if (f.mode.transfer === "error") throw new Error("insufficient funds");
        return { id: next("tr"), ...params };
      },
    },
    identity: {
      verificationSessions: {
        create: async (params: any, opts?: any) => {
          log("identity.verificationSessions.create", params, opts);
          const id = next("vs");
          const v = { id, status: "requires_input", url: `https://verify.stripe.test/${id}`, metadata: params.metadata };
          f.identity.set(id, v);
          return v;
        },
        retrieve: async (id: string) => { log("identity.verificationSessions.retrieve", { id }); return { ...f.identity.get(id) }; },
      },
    },
    accounts: {
      retrieve: async (id: string) => { log("accounts.retrieve", { id }); const r = f.mode.accountReady; return { id, payouts_enabled: r, charges_enabled: r, details_submitted: true, capabilities: { transfers: r ? "active" : "inactive" }, requirements: { currently_due: r ? [] : ["external_account"] } }; },
    },
  };
  return f;
}

export const fake: FakeStripe = create();

/** The module shape of server/lib/stripe.ts. */
export const stripeModule = {
  getStripe: () => fake.client,
  isTestMode: () => true,
  constructWebhookEvent: () => { throw new Error("not used in these tests"); },
};
