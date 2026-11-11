/**
 * connect.mountOrder.test — "Set up payouts" (POST /api/v1/me/connect/onboard) must reach the payouts router.
 *
 * connectionsRouter owns POST /connect/:platform (social OAuth). Mounted first, it read "onboard" as a platform and
 * answered 400 "Unsupported platform: onboard", so the payouts route never ran and the app said "couldn't reach Stripe".
 * Both routers share the /api/v1/me prefix, so the order they are mounted in server/index.ts decides who answers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const index = readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");

test("the payouts router is mounted before the social connections router", () => {
  const payouts = index.indexOf('app.use("/api/v1/me", connectRouter);');
  const social = index.indexOf('app.use("/api/v1/me", connectionsRouter);');
  expect(payouts).toBeGreaterThan(-1);
  expect(social).toBeGreaterThan(-1);
  expect(payouts).toBeLessThan(social);
});
