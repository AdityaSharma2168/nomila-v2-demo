/**
 * verify/fixtures.ts — rendered-deck HTML for the offline verifier eval (server/agent/evals/offline/verifier.cases.ts),
 * shaped like nomiDeck's output (cards as `<section class="… k-<kind> …">`, anchors for doors). It lives here, not
 * under agent/, because agent/ code builds no closing tags (lib/externalContent.test.ts: any `</word>` there is a
 * prompt wrapper). Every name and link is made up.
 */
const page = (cards: string, links = "") =>
  `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit"></head><body>${cards}${links}</body></html>`;

export const DECK_HTML = {
  pitchGood: page(
    `<section class="scr g-ink k-cover v-A"><h1>Alex Rivera</h1><p>Track · State</p></section><section class="scr k-record">12K followers</section>`,
    `<a class="btn" href="/p/alex/partner">Partner with Alex</a><a href="co.nomila.app://opportunities">Requests</a>`,
  ),
  pitchTemplateResidue: page(`<section class="scr k-cover"><h1>Alex Rivera</h1><p>Hi [Brand Name], my rate is [amount].</p></section>`),
  publicPageNoCoverForeignLink: page(
    `<section class="pc-hero"><section class="scr k-statement">Fast, then faster.</section></section>`,
    `<a href="https://bit.ly/x">More</a>`,
  ),
  /** A pitch deck as a real one links out: her socials (connected + researched), her school roster, our doors. */
  pitchWithHerLinks: page(
    `<section class="scr g-ink k-cover v-A"><h1>Alex Rivera</h1><p>Track · State · Class of 2027</p></section>`
      + `<section class="scr k-record"><p>48K on Instagram · 12K on TikTok</p><a href="https://www.instagram.com/alex.rivera/">@alex.rivera</a>`
      + `<a href="https://www.tiktok.com/@alexruns">@alexruns</a><a href="https://youtube.com/@AlexRiveraRuns">YouTube</a></section>`
      + `<section class="scr k-statement"><p>State 400m champion [Live] on the roster page.</p><a href="https://gostatesports.example/sports/track/roster/alex-rivera/1234">Roster</a></section>`,
    `<a class="btn" href="/p/alex/partner">Partner with Alex</a><a href="https://nomila.co/p/alex">nomila.co/p/alex</a><a href="https://x.com/alexrivera_">X</a>`,
  ),
  /** The same deck with a shortener and a stranger's site among its links. */
  pitchWithForeignLinks: page(
    `<section class="scr g-ink k-cover v-A"><h1>Alex Rivera</h1></section><a href="https://www.instagram.com/alex.rivera/">@alex.rivera</a>`,
    `<a href="https://bit.ly/3xYz">Media kit</a><a href="https://cheap-followers.example/alex">Stats</a>`,
  ),
} as const;
