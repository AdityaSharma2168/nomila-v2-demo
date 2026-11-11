import { registerRootComponent } from "expo";
// Side-effect import: registers LiveKit's native globals before anything renders.
// Resolves to an empty module on web — see lib/voiceGlobals.ts.
import "./lib/voiceGlobals";
import App from "./App";

registerRootComponent(App);
