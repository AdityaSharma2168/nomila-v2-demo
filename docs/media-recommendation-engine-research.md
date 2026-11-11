# Nomila Media-Analysis & Recommendation Engine — Architecture & Strategy Report

> Research deliverable (external deep-research pass). Scope: a self-refreshing engine that (1) gives
> athlete-creators expert-level growth insights and (2) emits structured generation briefs to the Studio
> content engine. Grounded in what Nomila already has: per-asset **vision analysis + image/video
> embeddings**, per-post/account **analytics**, and **Instagram Business Discovery** access to a peer corpus.

## The framing finding (read first)
The academic ceiling on virality prediction is real and low: the best models explain **under 50% of the
variance** in cascade size even with full user/content/history data (Martin, Hofman, Sharma, Anderson &
Watts 2016, arXiv:1602.01013), and controlled experiments show social influence makes success
**intrinsically unpredictable** independent of quality (Salganik, Dodds & Watts, *Science* 2006). This
dictates the design: **do not build a "will this go viral" score.** Build a system that (a) surfaces the
controllable, diagnosable gaps between an athlete and proven peer behavior, (b) expresses honest
confidence, and (c) treats every recommendation as an explore/exploit bet, not a prediction.

Computability tiers used below: **T1** = analytics we already ingest · **T2** = our existing vision
analysis + embeddings · **T3** = new extraction (caption/transcript NLP, OCR, audio-ID, shot-detection,
thumbnail analysis).

## Part 1 — Expert-signal framework (three lenses)

### Lens A — Branding strategist (positioning, cohesion, differentiation, fit)
- **Content-pillar coverage & stability** — % of posts on a small set of recurring themes (T2+T3).
- **Visual cohesion** — intra-account embedding variance + color palette similarity (T2 now).
- **Differentiation vs peers** — embedding distance from the peer/competitor centroid (T2 now, uses discovery).
- **Audience–brand fit** — actual demographics vs intended target (T1 now).
- **Aesthetic-quality consistency** — mean + std-dev of aesthetic score across the grid (T2 now).
- **Semantic brand-fit of an asset** — CLIP text-image cosine vs brand keywords (T2 now).
- **Comment/mention sentiment trend** (T3). **Cross-platform identity match** — thumbnail/art embedding similarity (T2 now).

### Lens B — Audience-growth lead (algorithmic reach & follower growth) — mostly **T1**, the beachhead
- **Sends/shares-per-reach (IG)** — a top-3 Reels signal, strongest for non-follower reach (T1).
- **Watch time / avg watch (IG Reels)** — Mosseri's #1 Reels signal (T1).
- **Save rate ÷ reach** — carousels earn the highest save rate (T1).
- **Completion rate (TikTok)** — strongest FYP signal, ~40–50% of weight; bar ~70% (T1).
- **Replay/re-watch rate (TikTok)** (T1 count / T3 explain).
- **CTR × Average View Duration (YouTube)** — the two promotion signals; clickbait (high CTR/low AVD) demoted (T1).
- **Early-engagement velocity (first 30–60 min)** — decides escalation (T1 but needs time-resolved capture).
- **Posting cadence & consistency variance** — 3–5/wk IG ≈ +12% reach/post; consistency beats volume (T1).
- **Format mix vs realized ER** (T1+T2). **Trending-audio usage & sound velocity** (T3).

### Lens C — Creative media lead (individual-post craft) — most **T3-heavy**
- **3-second intro retention** — first 3s decide distribution, target >70% (T1 + T3 to explain).
- **Hook type** (curiosity/question/challenge/tease) (T3, first-frames transcript + on-screen text).
- **On-screen text presence/coverage/contrast** — 60%+ view sound-off (T3, OCR).
- **Caption/subtitle transcript** (T3, ASR). **Thumbnail: face + emotion + contrast** — ~38% higher CTR (T3, feeds T1 CTR loop).
- **Pacing / cut-rate variance** — the lever is variation, not constant tempo (T3, shot-boundary).
- **CTA presence + type + placement** (T3). **Image composition score** — CLIP CCQA, extends vision stack (T2).

**Read:** Lens B is the beachhead (nearly all T1, platform-official-anchored, shippable now). Lens A is a
near-free win (embeddings already stored → cohesion = variance, differentiation = centroid distance). Lens C
is where the real new engineering lives (a video-understanding extraction pipeline) — phase it second.

## Part 2 — Trend detection (mining the peer corpus, kept fresh)
Consensus blueprint (closest published implementation: **BERTrend**, arXiv:2411.05930):
1. **Windowed corpus, not a static list** — poll peers via Business Discovery on a rolling 2–7 day window and re-embed. (Discovery returns public recent media + engagement + captions, but **no demographics, no history** — reconstruct time-series by repeated polling.)
2. **Cluster recent high-performers** — embeddings → UMAP → HDBSCAN, label with class-based TF-IDF.
3. **Link clusters across windows** by centroid cosine (τ ≈ 0.7); **freeze each cluster's anchor embedding** so meaning doesn't drift.
4. **Recency-decayed popularity** — `p' = p_prev + |D_new|` when seen; when unseen decay `p' = p_prev · e^(−λ·Δt²)` (Gaussian decay punishing staleness quadratically) — the math of "self-refreshing."
5. **Emergence via rolling percentiles + slope** — P10–P50 with positive slope = **weak signal, rising** (the money zone); catch before saturation.
6. **Per-cluster engagement lift as a z-score** vs the cluster's own rolling baseline; then the key query: *clusters over-performing among peers AND under-used by this athlete* (a set difference).
7. **Explicit drift detector** — ADWIN / Page-Hinkley; a sustained >2σ cosine drop triggers re-baseline/re-embed.

Commercial validation: TikTok Creative Center (7/30/120-day velocity, rising-vs-peaked ~3–5 day lead),
Brandwatch Signals (anomaly vs learned baseline), Metricool (weekly trending-audio refresh). All converge:
**relative acceleration against an adaptive baseline, windowed and decayed — never absolute counts, never a
hardcoded list.**

## Part 3 — Recommended self-refreshing architecture
Core principle: freshness comes from moving knowledge **out of frozen weights/hardcoded rules into (a) a
live retrieval corpus and (b) a continuously-updated outcome log.** Industrial pattern = **frozen LLM + live
retrieval (RAG)** (YouTube PLUM, Google SGE).

```
 athlete analytics (T1) ─┐
 media vision+embed (T2) ─┤→ RETRIEVAL LAYER (fresh knowledge: own top/bottom posts, peer/trend
 discovery peer corpus ──┘   clusters decayed, rising-weak formats under-used, signal library)
        → retrieve top-K → LLM-AS-ANALYST (reasons, does NOT memorize)
        → structured JSON: ranked insights + generation briefs, each w/ evidence + calibrated confidence
        → INSIGHT LAYER (to athlete, RICE/ICE-ranked)  +  GENERATION-BRIEF LAYER (to Studio, fixed schema)
        → OUTCOME LOG (recommendation → post → realized metrics) → bandit allocation + calibration + drift trigger
```

**Four "stay-adaptive" mechanisms (vs hardcoded rules):**
1. **RAG over a live corpus** — feed the LLM current analytics + peer/trend clusters + own top posts at inference; when platforms shift, update the retrieved signal library, not code. Off-the-shelf LLMs beat trained models in **cold-start** (pretrained knowledge substitutes for missing history) — key for low-follower athletes. Guardrails: ground every claim in retrieved data, constrain to JSON schema, **gate on uncertainty (allow abstain)**.
2. **Embedding nearest-neighbors to high performers** — answers "what are top peers doing that I'm not," stays current as the corpus updates (two-tower / ANN; Pinterest's conditional two-tower steers toward a goal attribute).
3. **Hierarchical partial-pooling** for the athlete's own model — shrink each athlete's estimate toward the population mean weighted by sample size; stabilizes advice for sparse creators, principled cold-start.
4. **Bandit feedback loop** — recommendation → post → outcome; Netflix artwork bandit is the canonical case (largest uplift where prior data was thin). Requires logging recommendation + outcome + propensity.

**Refresh trigger is drift, not a cron** (ADWIN/Page-Hinkley).

**Three traps to design against:** feedback-loop popularity homogenization (mitigate: bandit explore arm +
enforced content-mix); confidently-wrong/poisoned RAG (corpus integrity + uncertainty gating + calibration);
Goodhart's Law (optimize a small basket — saves + sends + watch time + retention — not one metric).

## Part 4 — Recommendation-engine design (what good output looks like)
**(i) Insights to the athlete** — prescriptive, ranked, evidence-attached, calibrated:
- Rank by **RICE** `(Reach×Impact×Confidence)÷Effort` (or lighter **ICE**); confidence higher when backed by own data, lower on peer/trend inference.
- Frame as one **next-best-action** conditioned on the athlete's chosen goal (reach vs engagement vs followers).
- **Evidence beside every recommendation** as a one-line local explanation ("your Reels retention beats peer median, but save rate is bottom-quartile — lean into carousels").
- **Calibrated confidence from a small vocabulary** (LLMs are overconfident) — Sherman Kent "Words of Estimative Probability." Own-data first, degrade to peer/global trends when thin (Sprout ViralPost pattern).

**(ii) Generation briefs to Studio** — fill a **fixed schema with enums, one core message, flowing from a data insight:**
- Canonical creative-brief fields (~7): objective (SMART), audience, key message + guidelines, deliverable/format, tone (adjectives + palette), references, success metric, **CTA (load-bearing)**.
- Exactly one **Single-Minded Proposition** that flows from the observed insight.
- Map winning findings → specific directives (hook format with highest thumb-stop, CTA that converted, format that outperformed).
- Downstream **generator-appropriate prompt object** (6-part image formula; Midjourney 20–60 words, DALL·E full sentences); Prompt→Generate→Validate→Repair→Parse with schema-constrained decoding.
- **Plan as a portfolio** — content-mix ratio (80/20 or Rule of Thirds), balance pillars, bandit explore/exploit allocation.

Illustrative brief object:
```json
{
  "objective": "Raise Reels sends-per-reach from 1.1% to 2%+ over 30 days",
  "goal_metric": "sends_per_reach",
  "audience": "18–24 F, US, existing follower base",
  "smp": "Show the unglamorous 5am part of training nobody posts",
  "pillar": "behind-the-scenes-grind",
  "format": "reel_9x16", "target_duration_s": 12,
  "hook": {"type": "challenge-assumption", "first_frame_text": "You think this is fun?"},
  "onscreen_text": true, "cta": {"type": "save", "placement": "end"},
  "tone_adjectives": ["raw", "gritty", "intimate"],
  "reference_cluster_id": "peer_cluster_47",
  "evidence": "peer_cluster_47 (BTS-grind) shows +2.3σ engagement lift among peers and you have 0 posts in it",
  "confidence": "likely (own-data thin; peer-trend backed)"
}
```

## Part 5 — Grounding in Nomila's existing stack
**Buildable now** (media vision + embeddings + analytics + discovery):
1. **Entire Growth lens (B)** — every top signal is a ratio over analytics we ingest. Ship first; zero new extraction.
2. **Brand cohesion & differentiation (A)** — cohesion = intra-account embedding variance; differentiation = centroid distance to discovery peers; aesthetic consistency = std-dev of the 0–1 score.
3. **Peer-benchmark percentiles** — place any athlete's ER/save/format-mix against a curated peer cohort.
4. **Trend clustering v1** — embed recent peer posts, HDBSCAN cluster, rank by decayed lift, diff vs the athlete's usage.
5. **LLM-as-analyst v1** — RAG the above into structured-JSON insights with RICE + confidence. No training.

**Smallest new pieces:** time-resolved engagement capture (early velocity); peer-corpus scheduler + decay
store; a video-understanding extraction service for Lens C (ASR/OCR/shot-detection/thumbnail) — the biggest
build, phase after A/B; outcome log + calibration/bandit loop.

## Part 6 — Phased build recommendation
- **Phase 0 — Signal library + peer benchmarking.** Codify platform-official signals as a *retrievable* library (not code rules); ship peer-percentile benchmarking. Tag benchmarks with source + date, keep in the refreshable corpus.
- **Phase 1 — Insight layer (LLM-as-analyst over RAG).** Lens B (T1) + Lens A (T2) → ranked, evidence-attached, confidence-gated insights via structured JSON. Own-data-first w/ peer fallback. MVP, zero new extraction.
- **Phase 2 — Fresh trend engine.** BERTrend-style windowed clustering + Gaussian decay + percentile emergence + drift trigger. Budget polling infra for the no-history discovery limits.
- **Phase 3 — Creative lens (C extraction) + generation briefs.** Stand up video-understanding (start with 3s-hook transcript + on-screen-text OCR). LLM emits specific briefs into Studio's fixed schema.
- **Phase 4 — Closed feedback loop.** Outcome log → hierarchical per-athlete model + Thompson-sampling bandit across brief variants; drift-triggered refresh. Enforce explore arm + content-mix + multi-metric objective. Comes last (needs posting volume).

**Non-negotiable discipline:** never present a virality *prediction*; present a diagnosed *gap* + a *bet* with
honest confidence. Credibility depends on calibrated humility given the <50%-variance ceiling.

## Part 7 — Cited reading list
**Predictability ceiling & virality:** Martin et al. *The Predictability of Popularity* (WWW 2016, arXiv:1602.01013) · Salganik, Dodds & Watts (Science 2006) · Cheng et al. *Can Cascades Be Predicted?* (WWW 2014, arXiv:1403.4608).
**What predicts engagement:** Bakhshi et al. *Faces Engage Us* (CHI 2014) · Berger & Milkman *What Makes Content Viral* (JMR 2012) · Mazloom et al. *Multimodal Popularity Prediction* (ACM MM 2016) · Ling et al. *TikTok Virality* (WebSci 2022 — creator profile alone AUC 0.86).
**Trend detection:** BERTrend (arXiv:2411.05930) · Kleinberg *Bursty and Hierarchical Structure in Streams* · TikTok Creative Center.
**Self-refreshing architectures:** *LLMs in RecSys* survey (aman.ai/recsys/llm-in-recsys) · Netflix *Artwork Personalization* · Chen et al. *Bias & Debias in RecSys* (arXiv:2007.13019) · OpenAI Structured Outputs.
**Output & briefs:** Braze *Next Best Action* · ProductPlan *RICE* · Sprout ViralPost · Sherman Kent *Words of Estimative Probability*.
**Platform anchors:** YouTube Help (CTR×AVD) · Later on Mosseri/IG · Buffer TikTok cadence (11M posts) · Socialinsider IG benchmarks (15M posts).
**Pitfalls:** Hootsuite *Vanity Metrics* · Goodhart's Law in engagement optimization (arXiv:2510.02840).

### Bottom line
Build a **RAG-based LLM-analyst over a live, decaying peer/trend corpus + the athlete's own analytics and
embeddings**, ranked with RICE and gated by calibrated confidence, feeding **schema-constrained generation
briefs** into Studio and closing the loop with a **drift-triggered bandit**. Ship the Growth lens and
peer-benchmarking *now* on existing data; the only large new build is the Lens-C video-extraction service
(Phase 3). Sell **diagnosed gaps and honest bets, never virality predictions.**

*Sourcing caveat: platform-signal weightings and effect sizes in Parts 1–2 come largely from agency/tool
blogs summarizing platform statements — directionally reliable, not published constants. The peer-reviewed
anchors (predictability ceiling, faces/emotion, poster-effect dominance, BERTrend) are load-bearing.*
