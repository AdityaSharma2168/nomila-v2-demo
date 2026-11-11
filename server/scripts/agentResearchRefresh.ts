/**
 * agentResearchRefresh.ts — start the agent research refresh for ONE athlete (an operator's run). The same request the
 * admin door makes (POST /api/v1/admin/agent/research-refresh/:athleteId): it only ENQUEUES the agent_research_refresh
 * workflow run; the service's every-minute workflow tick runs it. Refuses unless AGENT_RESEARCH_REFRESH is "true" where
 * it runs, and refuses an athlete with a refresh or an agent onboarding already running, or past today's refresh cap.
 *
 *   npx tsx server/scripts/agentResearchRefresh.ts --athlete <uuid>
 *
 * Owner rule (12 Oct 2026): approved for ONE named athlete at a time; the cohort runs only through the cron, behind
 * AGENT_RESEARCH_REFRESH_COHORT. Nothing here picks athletes.
 */
import "../agent/researchRefresh/workflow"; // registers the agent_research_refresh process (without it: "Unknown workflow process")
import { requestResearchRefresh } from "../agent/researchRefresh/sweep";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const at = process.argv.indexOf("--athlete");
  const athleteId = at >= 0 ? process.argv[at + 1] : "";
  if (!UUID.test(athleteId ?? "")) {
    console.error("usage: npx tsx server/scripts/agentResearchRefresh.ts --athlete <uuid>");
    process.exit(2);
  }
  const r = await requestResearchRefresh(athleteId, { trigger: "manual", reason: "operator run (script)", kick: false, createdBy: "script" });
  console.log(JSON.stringify(r));
  process.exit(r.started ? 0 : 1);
}

main().catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });
