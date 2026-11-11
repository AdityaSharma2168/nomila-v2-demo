/**
 * frontDoorLogic — the Scouting hero's stage line: the label and its band, never the band twice.
 */
import { stageLine } from "./frontDoorLogic";

it("stageLine: label · band, or just the label when it already names the band", () => {
  expect(stageLine({ label: "College", band: "developing" })).toBe("College · Developing");
  expect(stageLine({ label: "Established professional", band: "established" })).toBe("Established professional");
  expect(stageLine({ label: "Pro · established", band: "established" })).toBe("Pro · established");
  expect(stageLine({ label: "Elite-level pro", band: "elite" })).toBe("Elite-level pro");
  // a word that merely contains the band is not the band
  expect(stageLine({ label: "Pre-elitesquad", band: "elite" })).toBe("Pre-elitesquad · Elite");
});
