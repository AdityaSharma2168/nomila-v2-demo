import { loadFont } from "@remotion/google-fonts/Outfit";

// The app's typeface (DESIGN.md: Outfit-only scale). Loaded once per bundle; render waits for it.
export const { fontFamily } = loadFont("normal", { weights: ["600", "800", "900"], subsets: ["latin"] });
