/**
 * webLinking — URLs for the web app (EXPO_PUBLIC_WEB_V2: dev web, and the production web app since stage 1, owner
 * 25 Oct 2026). With it a refresh, the back button and a shared link land on the same screen: /opportunities/<deal id>
 * opens that deal, /mila opens Ask Mila, /settings opens Settings. Native builds pass NO linking (webLinkingFor returns
 * undefined).
 *
 * The paths follow the layout (Home · Strategy · Mila · Opportunities · Studio, Me and Settings inside Home, the
 * Brand stack above the tabs).
 *
 * "/" deliberately maps to nothing: the app then opens on the tab it would have chosen without URLs (a first entry's
 * door, an agent onboarding exit, or the web OAuth return `/?connected=<platform>` → Settings), never a forced Home.
 */
import type { LinkingOptions } from "@react-navigation/native";

// Typed loosely on purpose: the tabs' param list declares Home/Studio/… as plain screens (not nested navigators), so the
// strict type would refuse their nested `screens` (and initialRouteName). The config is a plain object, cast once below;
// webLinking.test checks every path against React Navigation's own parser instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Linking = LinkingOptions<any>;

export const WEB_LINKING_CONFIG = {
  screens: {
    Tabs: {
      screens: {
        Home: {
          path: "home",
          initialRouteName: "Landing",
          screens: {
            Landing: "",
            Me: { path: "me", exact: true },
            YourRates: { path: "me/rates", exact: true },
            Settings: { path: "settings", exact: true },
            DeleteAccount: { path: "settings/delete", exact: true },
          },
        },
        Strategy: {
          path: "strategy",
          initialRouteName: "StrategyRoot",
          screens: { StrategyRoot: "" },
        },
        SearchAsk: "mila",
        Opportunities: {
          path: "opportunities",
          initialRouteName: "OpportunitiesList",
          screens: {
            OpportunitiesList: "",
            Financials: "financials",
            AllDeals: "all",
            DealDetail: ":dealId",
          },
        },
        Studio: {
          path: "studio",
          initialRouteName: "StudioHome",
          screens: { StudioHome: "" },
        },
      },
    },
    Brand: {
      path: "brand",
      initialRouteName: "BrandOverview",
      screens: { BrandOverview: "" },
    },
  },
};

export const WEB_LINKING: Linking = {
  // Web resolves paths against the page's own origin; the prefix only matters to native, which never gets this.
  prefixes: ["co.nomila.app://"],
  config: WEB_LINKING_CONFIG as Linking["config"],
};

/** The linking the NavigationContainer gets: only with the dev web switch on in a browser; otherwise none (today). */
export function webLinkingFor(on: boolean): Linking | undefined {
  return on ? WEB_LINKING : undefined;
}
