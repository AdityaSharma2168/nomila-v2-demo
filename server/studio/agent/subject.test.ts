/**
 * subject.test.ts — who the tagger's words say is in the frame.
 *
 * Every fixture is a synthetic paraphrase of a cell shape from the enrichment eval's sheet
 * (docs/probes/enrich-eval.md): a named male professional with no male word in the line, a named
 * woman who is not her, a CGI clip whose beat names a man, hands-only product shots, empty frames
 * tagged present, quoted logos that are not names, and a clip whose whole-clip line names nobody
 * while its beats name her.
 *
 * ⚠️ MUTATION, red here by name: make `subjectOf` return "her" unconditionally — the "other" and
 * "nobody" cases red, and library.test's guard cases red with them.
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../lib/mediaEmbed", () => ({
  embedText: jest.fn(),
  cosine: jest.fn(),
}));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn() }));

import { namedPeople, subjectOf } from "./subject";

const present = (
  description: string,
  more: Record<string, unknown> = {},
): Record<string, unknown> => ({
  athlete_present: true,
  description,
  brands_visible: [],
  ...more,
});

describe("subjectOf — another person", () => {
  it("a named professional with NO male word in the line — the name is the only signal, accent included", () => {
    expect(
      subjectOf(
        present(
          "Professional soccer player Tomás Ferré mid-air controlling a soccer ball on the pitch.",
        ),
      ),
    ).toBe("other");
  });

  it("a named woman who is not her", () => {
    expect(
      subjectOf(
        present(
          "Dana Whitlock-Reyes sitting on the track waving to the crowd with her medal around her neck.",
        ),
      ),
    ).toBe("other");
  });

  it("a male word, with a unicode boundary — 'Mané' is not the word 'man'", () => {
    expect(
      subjectOf(present("A male soccer player in a white uniform is mid-air.")),
    ).toBe("other");
    expect(
      subjectOf(present("Ferré leaps for the ball on a green pitch.")),
    ).toBe("nobody"); // no person word — and NOT "other": the accent does not end a word
  });

  it("a clip whose beat names a man, when the whole-clip line names no one", () => {
    expect(
      subjectOf(
        present(
          "A CGI animation of a ball flying into a goal, followed by a still photograph.",
          {
            beats: [
              {
                description:
                  "CGI animation of a ball flying into an empty goal.",
              },
              {
                description:
                  "Still photograph of a male soccer player jumping to control a ball.",
              },
            ],
          },
        ),
      ),
    ).toBe("other");
  });
});

describe("subjectOf — nobody", () => {
  it("an empty frame tagged present: a ball, a bracelet, a graphic", () => {
    expect(
      subjectOf(
        present(
          "A soccer ball sits on the grass of an empty stadium at sunset.",
        ),
      ),
    ).toBe("nobody");
    expect(
      subjectOf(
        present(
          "Abstract graphic of a red left half, a blue right half and a small green square.",
        ),
      ),
    ).toBe("nobody");
  });

  it("hands only — 'a person' and body parts with none of the words for her", () => {
    expect(
      subjectOf(
        present(
          "A close-up shot of a person's hands squeezing a white sports bottle, water squirting out.",
        ),
      ),
    ).toBe("nobody");
    expect(
      subjectOf(
        present(
          "Close-up of hands holding a white squeeze bottle against a blurred green field.",
        ),
      ),
    ).toBe("nobody");
  });
});

describe("subjectOf — her, and the exceptions that keep her rows hers", () => {
  it("a quoted span is a logo or a sign, never a name", () => {
    expect(
      subjectOf(
        present(
          "A female basketball player in a maroon 'MUMBAI COBRAS' jersey dribbles on an outdoor court.",
        ),
      ),
    ).toBe("her");
    expect(
      subjectOf(
        present(
          "A static portrait of a smiling female soccer player posing in front of a 'Get Loud' banner.",
        ),
      ),
    ).toBe("her");
  });

  it("a bigram inside brands_visible is a brand, and a stoplisted place or org is not a person", () => {
    expect(
      subjectOf(
        present(
          "A young athlete in New Balance shoes stretches on the track.",
          {
            brands_visible: ["New Balance"],
          },
        ),
      ),
    ).toBe("her");
    expect(
      subjectOf(
        present("A female athlete runs past Golden Gate Park at dawn."),
      ),
    ).toBe("her");
    expect(namedPeople("Team USA athlete sprints", [])).toEqual([]);
  });

  it("a clip whose whole-clip line names nobody but whose beats name her — judged on both", () => {
    expect(
      subjectOf(
        present(
          "A transition from a casual outdoor setting on a soccer field to a studio portrait in a team uniform.",
          {
            beats: [
              {
                description:
                  "The athlete sits on the grass, tying her shoe and smiling.",
              },
              {
                description:
                  "The athlete poses in a studio with her foot on a ball.",
              },
            ],
          },
        ),
      ),
    ).toBe("her");
  });

  it("is her by default: a row not claiming her, an untagged row, an empty description", () => {
    expect(
      subjectOf({ athlete_present: false, description: "A man walks." }),
    ).toBe("her");
    expect(subjectOf(null)).toBe("her");
    expect(subjectOf(present(""))).toBe("her");
  });
});
