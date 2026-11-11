/**
 * webLinking.test — the dev web build's URLs (EXPO_PUBLIC_WEB_V2): each path lands on its screen, a deal link opens
 * that deal ABOVE the Opportunities list (so Back works from a shared link), "/" and the OAuth return "/?connected="
 * map to nothing (the app's own first-tab rule decides), and with the switch off there is no linking at all.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WEB_LINKING, WEB_LINKING_CONFIG, webLinkingFor } from "./webLinking";

/**
 * React Navigation's OWN path parser and printer (the ones NavigationContainer runs), not a re-implementation. They ship
 * only as ES modules, which this Jest runtime cannot require, so one plain `node` child runs every case at once.
 */
const PATHS = [
  "/home", "/me", "/me/rates", "/settings", "/strategy", "/mila", "/opportunities", "/opportunities/financials",
  "/studio", "/brand", "/brand/rates", "/opportunities/deal-123", "/", "/?connected=tiktok", "/?connected_error=gmail",
];
const DEAL_STATE = { routes: [{ name: "Tabs", state: { routes: [{ name: "Opportunities", state: { routes: [{ name: "OpportunitiesList" }, { name: "DealDetail", params: { dealId: "d-9" } }], index: 1 } }] } }] };
let parsed: Record<string, any> = {};
let printed = "";
beforeAll(() => {
  const lib = path.join(path.dirname(require.resolve("@react-navigation/core/package.json")), "lib", "module");
  const url = (f: string) => JSON.stringify(pathToFileURL(path.join(lib, f)).href);
  const script = `
    const { getStateFromPath } = await import(${url("getStateFromPath.js")});
    const { getPathFromState } = await import(${url("getPathFromState.js")});
    const { config, paths, state } = JSON.parse(process.argv[1]);
    const parsed = Object.fromEntries(paths.map((p) => [p, getStateFromPath(p, config) ?? null]));
    process.stdout.write(JSON.stringify({ parsed, printed: getPathFromState(state, config) }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ config: WEB_LINKING_CONFIG, paths: PATHS, state: DEAL_STATE })], { encoding: "utf8" });
  ({ parsed, printed } = JSON.parse(out));
});
const getStateFromPath = (p: string, _config?: unknown) => parsed[p] ?? undefined;

/** The route names from the root down to the focused leaf, plus the leaf's params. */
function leaf(path: string): { names: string[]; params?: Record<string, unknown> } {
  let state: any = getStateFromPath(path, WEB_LINKING_CONFIG as any);
  const names: string[] = [];
  let params: Record<string, unknown> | undefined;
  while (state) {
    const r = state.routes[state.index ?? state.routes.length - 1];
    names.push(r.name);
    params = r.params;
    state = r.state;
  }
  return { names, params };
}

describe("web URLs → screens", () => {
  it.each([
    ["/home", ["Tabs", "Home", "Landing"]],
    ["/me", ["Tabs", "Home", "Me"]],
    ["/me/rates", ["Tabs", "Home", "YourRates"]],
    ["/settings", ["Tabs", "Home", "Settings"]],
    ["/strategy", ["Tabs", "Strategy", "StrategyRoot"]],
    ["/mila", ["Tabs", "SearchAsk"]],
    ["/opportunities", ["Tabs", "Opportunities", "OpportunitiesList"]],
    ["/opportunities/financials", ["Tabs", "Opportunities", "Financials"]],
    ["/studio", ["Tabs", "Studio", "StudioHome"]],
    ["/brand", ["Brand", "BrandOverview"]],
  ])("%s", (path, names) => {
    expect(leaf(path).names).toEqual(names);
  });

  it("/opportunities/:id opens that deal, above the list so Back lands on Opportunities", () => {
    const { names, params } = leaf("/opportunities/deal-123");
    expect(names).toEqual(["Tabs", "Opportunities", "DealDetail"]);
    expect(params).toEqual({ dealId: "deal-123" });
    const state: any = getStateFromPath("/opportunities/deal-123", WEB_LINKING_CONFIG as any);
    const op = state.routes[0].state.routes[0];
    expect(op.state.routes.map((r: any) => r.name)).toEqual(["OpportunitiesList", "DealDetail"]);
  });

  it("a deal's screen writes its own shareable URL back", () => {
    expect(printed).toBe("/opportunities/d-9");
  });

  it("'/' and the OAuth return '/?connected=' map to nothing: the app's own first-tab rule (→ Settings) still decides", () => {
    expect(getStateFromPath("/", WEB_LINKING_CONFIG as any)).toBeUndefined();
    expect(getStateFromPath("/?connected=tiktok", WEB_LINKING_CONFIG as any)).toBeUndefined();
    expect(getStateFromPath("/?connected_error=gmail", WEB_LINKING_CONFIG as any)).toBeUndefined();
  });
});

describe("the WEB_V2 gate", () => {
  it("off (native, production web): no linking — the NavigationContainer is exactly as before", () => {
    expect(webLinkingFor(false)).toBeUndefined();
  });
  it("on (dev web): the linking above", () => {
    expect(webLinkingFor(true)).toBe(WEB_LINKING);
  });
});
