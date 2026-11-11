/**
 * widgetPush.test.ts — the onboarding_update card over the room's data channel.
 *
 * The wire is untrusted input (see widgetPush.ts). Pinned here: the card is built key by
 * key, labels come from OUR map (never the wire), an unknown field or an empty value is
 * dropped rather than rendered, a value is one line, markup-free and capped, and a wrong
 * enum or a non-uuid id refuses the whole card.
 */

import { parseWidgetPush } from "./widgetPush";

const RUN = "99999999-8888-4777-8666-555555555555";
const ACTION = "11111111-2222-4333-8444-555555555555";

const base = {
  v: 1,
  kind: "onboarding_update",
  runId: RUN,
  step: "greet",
  next: "doors",
  door: null,
};

test("a greet receipt renders the saved facts with our labels and a composed line", () => {
  const parsed = parseWidgetPush({
    ...base,
    saved: [
      { field: "position", value: "midfielder", agentActionId: ACTION, label: "FROM THE WIRE" },
      { field: "hometown", value: "  Dublin,\n Ohio <b>x</b> ", agentActionId: "not-a-uuid" },
    ],
  });
  expect(parsed).not.toBeNull();
  expect(parsed!.line).toBe("Saved to your profile.");
  expect(parsed!.widget).toEqual({
    type: "onboarding_update",
    data: {
      runId: RUN,
      step: "greet",
      next: "doors",
      door: null,
      saved: [
        { field: "position", label: "Position", value: "midfielder", agentActionId: ACTION },
        { field: "hometown", label: "Hometown", value: "Dublin, Ohio x", agentActionId: null },
      ],
    },
  });
});

test("unknown fields and empty values are dropped, not rendered; a value is capped at 120", () => {
  const parsed = parseWidgetPush({
    ...base,
    saved: [
      { field: "email", value: "x@y.z", agentActionId: null },
      { field: "note", value: "   ", agentActionId: null },
      { field: "note", value: "a".repeat(200), agentActionId: null },
    ],
  });
  expect(parsed!.widget.type).toBe("onboarding_update");
  const saved = (parsed!.widget as { data: { saved: Array<{ field: string; value: string }> } }).data.saved;
  expect(saved.map((s) => s.field)).toEqual(["note"]);
  expect(saved[0].value).toHaveLength(120);
});

test("a doors card with nothing saved composes the doors line; a finished one the done line", () => {
  expect(parseWidgetPush({ ...base, saved: [] })!.line).toBe("Where do you want to start?");
  const done = parseWidgetPush({ ...base, step: "doors", next: "done", door: "deals", saved: [] })!;
  expect(done.line).toBe("You're all set.");
  expect((done.widget as { data: { door: string } }).data.door).toBe("deals");
});

test("a wrong enum, a bad run id, or a wrong version refuses the card", () => {
  const reasons: string[] = [];
  const reject = (r: string) => reasons.push(r);
  expect(parseWidgetPush({ ...base, saved: [], step: "discover" }, reject)).toBeNull();
  expect(parseWidgetPush({ ...base, saved: [], next: "later" }, reject)).toBeNull();
  expect(parseWidgetPush({ ...base, saved: [], door: "exit" }, reject)).toBeNull();
  expect(parseWidgetPush({ ...base, saved: [], runId: "nope" }, reject)).toBeNull();
  expect(parseWidgetPush({ ...base, saved: [], v: 2 }, reject)).toBeNull();
  expect(reasons).toEqual([
    "step not in the allowed set",
    "next not in the allowed set",
    "door not in the allowed set",
    "runId is not a uuid",
    "unsupported schema version (want 1)",
  ]);
});
