/**
 * caption.test.ts — a post's caption, tags and shot list, read out of what the plan wrote (agent/postKit/caption.ts).
 * Pure: no database, no model. The old-shape bodies are made up in the SHAPE the dev post kits had (a production brief
 * with "Format: … Slide 1: … Caption draft: …", inline or one part per line); no athlete, sport, school or brand of the
 * real world.
 *
 *   C1 the old two-part body ("Caption: … Shots: …") and an unlabelled body read as they always did
 *   C2 a production brief — inline or line by line — yields ONLY its caption draft: no "Format:", "Slide N:", "Shots:"
 *   C3 a brief with no caption label yields "" — never the brief
 *   C4 tags: a "Hashtags:" part and the caption's own, unique; a structured list made safe and capped
 *   C5 the pasted text: the words, a blank line, then the tags the words do not carry
 *   C6 labels a caption may hold in passing are not cut ("Cover-up", a lower-case "format:" mid-sentence)
 *   C7 the structured field (plan 1.7.0): only a leading caption label comes off — never anything mid-caption ("Note:",
 *      "Music:", "Story 2:", "Coach:" stay); a field that opens with a production label is the brief → ""
 *   C8 tags move out of the structured caption: a closing run whole, an inline tag keeps its word, "#23" stays
 *   C9 older bodies: "## Caption" / "## Shots" headings (with or without a colon), "Caption options:" (its first
 *      option), numbered "1. Caption: … 2. Shots: …" (no stray "2."), inline or one per line
 *   C10 tag cleaning: "#game-day" → "#gameday"; NFC ("#café" → "#café")
 */
import { captionField, captionFromBody, hashtagList, hashtagsFromBody, hashtagsOf, partsOfBody, shotListFromBody, splitTags, withTags } from "./caption";

/** No line of a brief may survive into a caption. */
const BRIEF_LINE = /\b(?:Format|Slide\s*\d+|Frame\s*\d+|Shots?|Shot list|Cover|Caption(?: draft)?)\s*:/i;

describe("C1: the shapes that always read", () => {
  it("splits the old two-part body into its caption and its shot list", () => {
    const body = "Caption: The work nobody sees.\nEarly sessions add up. #training #Training #process\nShots: a sprint start, a hard rep.";
    expect(captionFromBody(body)).toBe("The work nobody sees.\nEarly sessions add up. #training #Training #process");
    expect(shotListFromBody(body)).toBe("a sprint start, a hard rep.");
    expect(hashtagsOf(captionFromBody(body))).toEqual(["#training", "#process"]);
  });

  it("an unlabelled body is the words; words then a shot list keeps the words", () => {
    expect(captionFromBody("Just the words, no labels.")).toBe("Just the words, no labels.");
    expect(shotListFromBody("Just the words, no labels.")).toBe("");
    expect(captionFromBody("The words first.\nShots — warm-up, one set, the finish")).toBe("The words first.");
    expect(shotListFromBody("The words first.\nShots — warm-up, one set, the finish")).toBe("warm-up, one set, the finish");
  });
});

describe("C2: a production brief yields only its caption", () => {
  const inline = "Format: carousel, four slides. Slide 1: a wide shot of the track at dawn. Slide 2 (detail): laces tied. "
    + "Slide 3: the first rep. Caption draft: “Four weeks out. Every lap counts.” #seasonprep #trainingday";
  const lined = [
    "Format: reel, 15 seconds",
    "Cover: the start line",
    "Shot 1: warm-up jog",
    "Shot 2: the last rep, slowed down",
    "Caption draft: Four weeks out.",
    "Every lap counts.",
    "Hashtags: #seasonprep #TrainingDay",
  ].join("\n");
  const bulleted = "- **Format:** story, three frames\n- **Frame 1:** countdown sticker\n- **Caption:** See you Saturday.\n- **Notes:** post at noon";

  it.each([
    ["inline", inline, "Four weeks out. Every lap counts. #seasonprep #trainingday"],
    ["one part per line", lined, "Four weeks out.\nEvery lap counts."],
    ["bulleted and bold", bulleted, "See you Saturday."],
  ])("%s", (_name, body, caption) => {
    expect(captionFromBody(body)).toBe(caption);
    expect(captionFromBody(body)).not.toMatch(BRIEF_LINE);
  });

  it("the shot list comes from the shots, else the numbered slides or frames", () => {
    expect(shotListFromBody(inline)).toBe("a wide shot of the track at dawn; laces tied; the first rep");
    expect(shotListFromBody(lined)).toBe("warm-up jog; the last rep, slowed down");
    expect(shotListFromBody(bulleted)).toBe("countdown sticker");
  });

  it("reads every part in order", () => {
    expect(partsOfBody(lined).parts.map((p) => p.label)).toEqual(["brief", "brief", "slide", "slide", "caption", "hashtags"]);
    expect(partsOfBody(inline).preamble).toBe("");
  });
});

describe("C3: no caption label, no caption", () => {
  it.each([
    "Format: story. Frame 1: countdown sticker. Frame 2: the team bus.",
    "Format: reel\nSlide 1: warm-up\nSlide 2: the finish\nMusic: something upbeat",
    "A quick reel from practice.\nFormat: reel\nShots: warm-up, the finish",
  ])("%s → \"\"", (body) => {
    expect(captionFromBody(body)).toBe("");
  });
});

describe("C4: tags", () => {
  it("a Hashtags part and the caption's own tags, first spelling kept", () => {
    expect(hashtagsFromBody("Caption draft: Ready. #GameDay\nHashtags: #seasonprep #gameday #new")).toEqual(["#seasonprep", "#gameday", "#new"]);
  });

  it("a structured list made safe: '#' added, spaces dropped, junk out, unique, capped", () => {
    expect(hashtagList(["#Training", "training", "game day", "#ok!", 7, null, "##double", "#a", "#b"], 5))
      .toEqual(["#Training", "#gameday", "#double", "#a", "#b"]);
    expect(hashtagList("not a list", 5)).toEqual([]);
  });
});

describe("C5: the text that is pasted", () => {
  it("the words, a blank line, then only the tags they do not carry", () => {
    expect(withTags("Four weeks out.", ["#seasonprep", "#trainingday"])).toBe("Four weeks out.\n\n#seasonprep #trainingday");
    expect(withTags("Four weeks out. #SeasonPrep", ["#seasonprep", "#trainingday"])).toBe("Four weeks out. #SeasonPrep\n\n#trainingday");
    expect(withTags("Four weeks out.", [])).toBe("Four weeks out.");
    expect(withTags("", ["#a"])).toBe("#a");
  });
});

describe("C6: words a caption may hold in passing", () => {
  it("are not read as labels", () => {
    expect(captionFromBody("Cover-up season is over. Back on the track.")).toBe("Cover-up season is over. Back on the track.");
    expect(captionFromBody("Caption: New format: same work. Let's go.")).toBe("New format: same work. Let's go.");
  });
});

describe("C7: the structured caption is kept whole", () => {
  it("only a leading caption label comes off", () => {
    expect(captionField("Caption: Four weeks out.")).toBe("Four weeks out.");
    expect(captionField("**Caption draft:** “Four weeks out.”")).toBe("Four weeks out.");
  });
  it.each([
    "Four weeks out. Note: the work starts now.",
    "Race day. Music: whatever the warm-up playlist says.",
    "Story 2: the comeback. It starts Saturday.",
    "Coach: “One more rep.” Me: fine.",
  ])("never cut mid-caption: %s", (text) => {
    expect(captionField(text)).toBe(text);
  });
  it.each(["Format: carousel. Slide 1: the track.", "Slide 1: the track", "Shots: warm-up", "Cover: the start line", "Reel: open on the clock", "Carousel: four slides", "Hook: the record", "On-screen text: 4 weeks", "Overlay: big type", "Audio: trending sound"])(
    "a field that opens with a production label is the brief → \"\": %s", (text) => {
      expect(captionField(text)).toBe("");
    });
});

describe("C8: tags move out of the structured caption", () => {
  it("a closing run whole; an inline tag keeps its word; a number-only tag stays", () => {
    expect(splitTags("Four weeks out. #seasonprep #TrainingDay")).toEqual({ words: "Four weeks out.", tags: ["#seasonprep", "#TrainingDay"] });
    expect(splitTags("Four weeks out.\n\n#seasonprep\n#gameday")).toEqual({ words: "Four weeks out.", tags: ["#seasonprep", "#gameday"] });
    expect(splitTags("Big #GameDay energy, wearing #23.")).toEqual({ words: "Big GameDay energy, wearing #23.", tags: ["#GameDay"] });
    expect(splitTags("No tags here.")).toEqual({ words: "No tags here.", tags: [] });
  });
});

describe("C9: older bodies — headings, options, numbered lists", () => {
  it("markdown headings, with or without a colon", () => {
    const body = "## Format\nReel, 15 seconds\n\n## Caption\nFour weeks out.\nEvery lap counts.\n\n## Shots:\nwarm-up, the finish";
    expect(captionFromBody(body)).toBe("Four weeks out.\nEvery lap counts.");
    expect(shotListFromBody(body)).toBe("warm-up, the finish");
  });
  it("\"Caption options:\" takes the first option", () => {
    expect(captionFromBody("Format: reel\nCaption options:\n1. Four weeks out.\n2. Every lap counts.\nShots: warm-up")).toBe("Four weeks out.");
    expect(captionFromBody("Caption options:\n- Four weeks out.\n- Every lap counts.")).toBe("Four weeks out.");
  });
  it("numbered parts leave no stray list number", () => {
    expect(captionFromBody("1. Caption: Four weeks out. 2. Shots: warm-up, the finish")).toBe("Four weeks out.");
    expect(captionFromBody("1. Format: reel\n2. Caption: Four weeks out.\n3. Shots: warm-up")).toBe("Four weeks out.");
    expect(shotListFromBody("1. Caption: Four weeks out. 2. Shots: warm-up, the finish")).toBe("warm-up, the finish");
  });
  it("what is NOT guaranteed (documented): labels in another language read as an unlabelled body", () => {
    expect(captionFromBody("Formato: reel. Leyenda: Cuatro semanas.")).toBe("Formato: reel. Leyenda: Cuatro semanas.");
  });
});

describe("C10: tag cleaning", () => {
  it("hyphens dropped, NFC-normalised", () => {
    expect(hashtagList(["#game-day", "café", "#Café"], 5)).toEqual(["#gameday", "#café"]);
    expect(hashtagsOf("Coffee #café time")).toEqual(["#café"]);
  });
});
