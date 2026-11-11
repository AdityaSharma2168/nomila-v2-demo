/**
 * studio/buildInfo — which build this server is, said once at startup (PR 4, C1).
 *
 * An acceptance run once measured a server left on an old commit and reported the old commit's bug
 * as the new one's. Nothing in the log said which build answered. This is the line that does:
 *
 *   Cloud Run   K_REVISION — the revision Cloud Run sets on every instance (no deploy change needed)
 *   locally     `git rev-parse --short HEAD` in the process's working directory
 *   neither     null — said as unknown, never guessed
 *
 * Pure over an injected env and runner so a test can hold the order. The runner is synchronous and
 * runs once, at the Studio router's module load.
 */
import { execFileSync } from "node:child_process";

export interface BuildRevision {
  revision: string | null;
  source: "k_revision" | "git" | "unknown";
}

/** `git rev-parse --short HEAD`, or null when there is no git (the container) or it fails. */
export const gitShortSha = (): string | null => {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
};

/**
 * Cloud Run's revision first — a container has no .git, and a revision names the deploy exactly —
 * then the local checkout's short SHA, then unknown.
 * ⚠️ MUTATION (buildInfo.test): ignore K_REVISION — "Cloud Run's revision wins" reds by name.
 */
export function buildRevision(
  env: Readonly<Record<string, string | undefined>> = process.env,
  git: () => string | null = gitShortSha,
): BuildRevision {
  const k = env.K_REVISION?.trim();
  if (k) return { revision: k, source: "k_revision" };
  const sha = git();
  if (sha) return { revision: sha, source: "git" };
  return { revision: null, source: "unknown" };
}
