/**
 * milaActivity.test — every activity comes from a real signal (voice room state or the reply
 * stream's phase), maps to one avatar loop and one pill label, and voice wins while a call is live.
 */
import { ACTIVITY_AVATAR, ACTIVITY_LABEL, activityFrom, type MilaActivity } from "./milaActivity";

describe("activityFrom", () => {
  it("maps the text reply's stream phase", () => {
    expect(activityFrom("idle", "idle")).toBe("idle");
    expect(activityFrom("idle", "thinking")).toBe("thinking");
    expect(activityFrom("idle", "tool")).toBe("looking");
    expect(activityFrom("idle", "writing")).toBe("writing");
  });

  it("maps the voice room's state, and voice wins while live", () => {
    expect(activityFrom("speaking", "idle")).toBe("speaking");
    expect(activityFrom("listening", "idle")).toBe("listening");
    expect(activityFrom("connecting", "idle")).toBe("connecting");
    expect(activityFrom("speaking", "writing")).toBe("speaking");
  });

  it("a voice error is not live: the text phase shows", () => {
    expect(activityFrom("error", "idle")).toBe("idle");
    expect(activityFrom("error", "thinking")).toBe("thinking");
  });
});

describe("labels and loops", () => {
  const all: MilaActivity[] = ["idle", "thinking", "looking", "writing", "connecting", "listening", "speaking"];

  it("idle is just her name; work says what she's doing", () => {
    expect(ACTIVITY_LABEL.idle).toBe("Mila");
    expect(ACTIVITY_LABEL.thinking).toBe("Generating…");
    expect(ACTIVITY_LABEL.looking).toBe("Looking things up…");
    expect(ACTIVITY_LABEL.writing).toBe("Writing…");
    expect(ACTIVITY_LABEL.speaking).toBe("Speaking");
    expect(ACTIVITY_LABEL.listening).toBe("Listening");
  });

  it("each activity has one avatar loop; her mouth moves only when she speaks", () => {
    expect(ACTIVITY_AVATAR.thinking).toBe("generating");
    expect(ACTIVITY_AVATAR.looking).toBe("searching");
    expect(ACTIVITY_AVATAR.writing).toBe("writing");
    expect(ACTIVITY_AVATAR.speaking).toBe("speaking");
    for (const a of all) {
      expect(ACTIVITY_AVATAR[a]).toBeDefined();
      if (a !== "speaking") expect(ACTIVITY_AVATAR[a]).not.toBe("speaking");
    }
  });
});
