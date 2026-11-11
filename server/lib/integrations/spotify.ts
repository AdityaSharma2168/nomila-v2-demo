/**
 * Spotify direct integration — Spotify OAuth 2.0 Authorization Code flow.
 * Access token: 1hr. Refresh token: indefinite.
 *
 * NOTE: Stores identity/lifestyle data only (top artists, tracks, playlists).
 * Not used in social scoring — stored in sources.spotify_profile.
 *
 * SETUP: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be created in
 * GCP Secret Manager before deploying (they are not there yet).
 */

import { db } from "../../db";
import { connectedAccounts } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { createLogger } from "../../logger";
import { apiBaseUrl } from "../baseUrls";
import { signOAuthState } from "../oauthState";
import { openTokenFields, sealTokenFields } from "../tokenCrypto";
import { activateConnection, MissingAccountIdError } from "./activateConnection";
import type { ActivatedConnection } from "./types";

const logger = createLogger("integrations/spotify");

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET?.trim();
const API_BASE      = apiBaseUrl();
const REDIRECT      = `${API_BASE}/api/v1/auth/callback/spotify`;
const ACCOUNTS_URL  = "https://accounts.spotify.com";
const SPOTIFY_API   = "https://api.spotify.com/v1";

const SCOPES = [
  "user-top-read",
  "user-library-read",
  "playlist-read-private",
].join(" ");

async function spotifyGet<T>(path: string, token: string): Promise<T> {
  const res  = await fetch(`${SPOTIFY_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json() as any;
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `Spotify API ${res.status}`);
  return json as T;
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
}

// clientPlatform "web" (signed into state) sends a web connect back to the web app; the connect route passes it for
// Spotify only when the client asks (webReturn — the dev web build), so today's clients keep today's return page.
export function getAuthUrl(athleteId: string, _alias?: string, _loginHint?: string, clientPlatform?: string): string {
  if (!CLIENT_ID) throw new Error("SPOTIFY_CLIENT_ID not set");
  const url = new URL(`${ACCOUNTS_URL}/authorize`);
  url.searchParams.set("client_id",     CLIENT_ID);
  url.searchParams.set("redirect_uri",  REDIRECT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         SCOPES);
  url.searchParams.set("state",         signOAuthState(athleteId, undefined, clientPlatform));
  return url.toString();
}

export async function handleCallback(code: string, athleteId: string): Promise<ActivatedConnection> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Spotify credentials not configured");

  const res = await fetch(`${ACCOUNTS_URL}/api/token`, {
    method:  "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }).toString(),
  });
  const data = await res.json() as any;
  if (!res.ok || data.error) throw new Error(`Spotify token exchange failed: ${data.error_description ?? data.error}`);

  // spotifyGet throws on a failed fetch; the Spotify user id is the connection's identity.
  const profile = await spotifyGet<{ id?: string; display_name?: string; email?: string }>(
    "/me",
    data.access_token,
  );
  if (!profile?.id) {
    logger.error({ athleteId }, "Spotify connect: /me returned no id");
    throw new MissingAccountIdError("spotify");
  }

  const activated = await activateConnection({
    athleteId,
    platform:         "spotify",
    platformUserId:   profile.id,
    platformUsername: profile.display_name ?? profile.email ?? null,
    accessToken:      data.access_token,
    refreshToken:     data.refresh_token ?? null,
    tokenExpiresAt:   data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    scopes:           data.scope ?? SCOPES,
  });

  logger.info({ athleteId, spotifyId: profile.id, connectionId: activated.connectionId, reactivated: activated.reactivated }, "Spotify connected");
  return activated;
}

export async function refreshTokenIfNeeded(connectionId: string): Promise<string> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Spotify credentials not configured");

  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) throw new Error("Spotify token not found");

  if (row.token_expires_at && (row.token_expires_at.getTime() - Date.now()) > 5 * 60_000) {
    return row.access_token;
  }
  if (!row.refresh_token) throw new Error("No Spotify refresh token — user must reconnect");

  const res = await fetch(`${ACCOUNTS_URL}/api/token`, {
    method:  "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token }).toString(),
  });
  const data = await res.json() as any;
  if (!res.ok || data.error) throw new Error(`Spotify token refresh failed: ${data.error}`);

  await db.update(connectedAccounts).set(await sealTokenFields({
    access_token:     data.access_token,
    token_expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : row.token_expires_at,
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
  })).where(eq(connectedAccounts.id, connectionId));

  logger.info({ connectionId }, "Spotify token refreshed");
  return data.access_token;
}

export interface SpotifyProfile {
  top_artists: Array<{ name: string; genres: string[]; popularity: number }>;
  top_tracks:  Array<{ name: string; artist: string; popularity: number }>;
  playlists:   Array<{ name: string; description: string; track_count: number }>;
  genres:      string[];
  fetched_at:  string;
}

export async function fetchForSpotifyProfile(connectionId: string): Promise<{
  spotifyProfile: SpotifyProfile;
  toolsCalled: string[];
} | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return null;

  const token = await refreshTokenIfNeeded(connectionId);
  const toolsCalled: string[] = [];

  const [artistsRes, tracksRes, playlistsRes] = await Promise.allSettled([
    spotifyGet<{ items: any[] }>("/me/top/artists?limit=10&time_range=medium_term", token),
    spotifyGet<{ items: any[] }>("/me/top/tracks?limit=10&time_range=medium_term",  token),
    spotifyGet<{ items: any[] }>("/me/playlists?limit=10",                          token),
  ]);

  if (artistsRes.status   === "fulfilled") toolsCalled.push("spotify_top_artists");
  if (tracksRes.status    === "fulfilled") toolsCalled.push("spotify_top_tracks");
  if (playlistsRes.status === "fulfilled") toolsCalled.push("spotify_playlists");

  const artists   = artistsRes.status   === "fulfilled" ? (artistsRes.value?.items   ?? []) : [];
  const tracks    = tracksRes.status    === "fulfilled" ? (tracksRes.value?.items    ?? []) : [];
  const playlists = playlistsRes.status === "fulfilled" ? (playlistsRes.value?.items ?? []) : [];

  const genreSet = new Set<string>();
  for (const a of artists) for (const g of (a.genres ?? []) as string[]) genreSet.add(g);

  return {
    toolsCalled,
    spotifyProfile: {
      top_artists: artists.slice(0, 10).map((a: any) => ({
        name:       a.name ?? "",
        genres:     a.genres ?? [],
        popularity: a.popularity ?? 0,
      })),
      top_tracks: tracks.slice(0, 10).map((t: any) => ({
        name:       t.name ?? "",
        artist:     t.artists?.[0]?.name ?? "",
        popularity: t.popularity ?? 0,
      })),
      playlists: playlists.slice(0, 10).map((p: any) => ({
        name:        p.name ?? "",
        description: p.description ?? "",
        track_count: p.tracks?.total ?? 0,
      })),
      genres:     Array.from(genreSet),
      fetched_at: new Date().toISOString(),
    },
  };
}
