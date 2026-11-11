/**
 * flag.ts — PUBLIC_CARD gates the public athlete page (/p/:handle) and everything under it. Read at call time (not at
 * import) so a test can flip it. Exactly "true" is on; anything else is off, and every /p route falls through to 404.
 *
 * The fixture pages (/p/_dev/fixtures/:name) are DEV ONLY: they also need a non-production NODE_ENV, which no deployed
 * service has (the image sets NODE_ENV=production), so they exist only on a laptop or in tests. They let the renderer
 * be exercised over made-up athletes (fixtures.ts) without a published snapshot in the database.
 *
 * The cloud-run yaml entries for PUBLIC_CARD belong to the snapshot PR; this file only reads the variable.
 */
export const publicCardEnabled = (): boolean => process.env.PUBLIC_CARD === "true";

export const publicCardFixturesEnabled = (): boolean => publicCardEnabled() && process.env.NODE_ENV !== "production";
