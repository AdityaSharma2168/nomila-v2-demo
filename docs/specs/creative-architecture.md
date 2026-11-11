# Nomila Creative Generation & Model Intelligence Architecture

> **Provenance.** Mia's architecture doc, committed verbatim on 2026-09-22 as the spec for Studio PR 3
> (brand profiles + reference decomposition) and what follows it. The text arrived as a paste without
> markup, so headings, code fences, lists and the §11 table were restored here; no wording was changed.
> The parenthesised source names — "(OpenRouter)", "(Google DeepMind)" and the rest — are the doc's own
> citation markers. The paste carried no URLs for them.

## 1. Executive Summary

Nomila should not be designed as a prompt generator or as a thin wrapper around image/video APIs.

The objective is to build a model-agnostic creative intelligence and execution layer that can translate a human or AI-generated creative idea into predictable, high-quality image and video outputs.

The system should:

- Understand the user’s creative objective.
- Understand the athlete/person, product, environment, and reference assets.
- Translate the creative objective into a structured Creative Specification.
- Decompose video campaigns into structured Shot Specifications.
- Consult a Creative Capability Library describing what can be reliably achieved.
- Consult a Model Capability Registry describing what each approved model/provider can do.
- Select the appropriate generation model.
- Compile the ShotSpec into a model-specific prompt and API payload.
- Generate the asset through OpenRouter / approved provider APIs.
- Evaluate the output against the original creative specification.
- Automatically revise/regenerate when appropriate.
- Record the entire process as empirical data.
- Use that data to continuously improve model selection, prompts, capability ratings and generation quality.

OpenRouter is well suited to the model-access layer because it provides a unified API across hundreds of models and exposes model metadata through its API. It also supports fallbacks and model/provider selection. (OpenRouter)

## 2. Core Design Principle

Do not make the prompt the source of truth.

The architecture should be:

```
USER / AGENT
     ↓
CREATIVE INTENT
     ↓
CREATIVE SPEC
     ↓
SHOT SPEC
     ↓
CAPABILITY PLANNER
     ↓
MODEL SELECTION
     ↓
MODEL-SPECIFIC PROMPT COMPILER
     ↓
OPENROUTER / PROVIDER
     ↓
GENERATION
     ↓
QUALITY EVALUATION
     ↓
ITERATION
```

The Creative Spec and Shot Spec are canonical.

The prompt is generated from them.

This means that if Nomila changes from Model A to Model B, the underlying creative intent doesn’t change. Only the compiler changes.

This is important because model capabilities and prompt behavior will continuously change.

Google’s current Veo guidance, for example, explicitly identifies shot framing, camera motion, style, lighting, character descriptions and audio as useful prompt dimensions. (Google DeepMind)

## 3. High-Level Architecture

```
                         ┌─────────────────────┐
                         │ USER / CREATIVE     │
                         │ AGENT               │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ CREATIVE DIRECTOR   │
                         │                     │
                         │ Intent extraction   │
                         │ Campaign planning   │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ CREATIVE SPEC       │
                         │                     │
                         │ Objective           │
                         │ Audience            │
                         │ Brand               │
                         │ Subject             │
                         │ Product             │
                         │ Aesthetic           │
                         │ References          │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ ASSET INTELLIGENCE  │
                         │                     │
                         │ Athlete             │
                         │ Product             │
                         │ Reference           │
                         │ Image/video         │
                         └──────────┬──────────┘
                                    │
                                    ▼
                 ┌──────────────────────────────────────┐
                 │ CREATIVE CAPABILITY LIBRARY          │
                 │                                      │
                 │ Camera / lighting / motion / style   │
                 │ composition / environments / actions │
                 └──────────────────┬───────────────────┘
                                    │
                                    ▼
                 ┌──────────────────────────────────────┐
                 │ MODEL CAPABILITY REGISTRY            │
                 │                                      │
                 │ Gemini / Veo / other approved models │
                 └──────────────────┬───────────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ SHOT PLANNER        │
                         │                     │
                         │ Shot 1              │
                         │ Shot 2              │
                         │ Shot 3              │
                         │ ...                 │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ PROMPT COMPILER     │
                         │                     │
                         │ model-specific      │
                         │ prompt + parameters │
                         └──────────┬──────────┘
                                    │
                                    ▼
                              OPENROUTER
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ GENERATION MODEL    │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ CREATIVE QA         │
                         │                     │
                         │ Identity            │
                         │ Product             │
                         │ Composition         │
                         │ Motion              │
                         │ Cinematography      │
                         │ Prompt adherence    │
                         └──────────┬──────────┘
                                    │
                            ┌───────┴────────┐
                            ▼                ▼
                          PASS           REVISE
                                             │
                                             └──→ generation
```

## 4. Layer 1 — Creative Director

The Creative Director is an LLM-based reasoning layer.

Its job is not to write the final generation prompt.

Its job is to answer:

> What are we actually trying to create?

For example:

User:

> “I want an Adidas-style campaign showing me getting ready before a big game. Make it cinematic and premium.”

The Creative Director should identify:

```json
{
  "objective": "premium sports campaign",
  "subject": "athlete",
  "brand": "Adidas",
  "story": "pre-game preparation",
  "tone": ["cinematic", "premium", "focused"],
  "format": "social_video",
  "platform": "Instagram",
  "identity_priority": "maximum"
}
```

### Recommendation

Keep this layer model-independent.

It can use a strong multimodal frontier model through OpenRouter.

It should have tools rather than an enormous prompt.

For example:

```
get_athlete_profile()
get_asset_metadata()
analyze_reference()
search_capabilities()
get_model_capabilities()
validate_shot()
```

Anthropic’s agent research supports the general approach of using modular agentic workflows, tools and evaluators while avoiding unnecessary complexity. (Anthropic Resources)

## 5. Layer 2 — Creative Specification

The Creative Specification is the canonical representation of the campaign.

Example:

```json
{
  "campaign_id": "camp_123",
  "objective": {
    "type": "brand_campaign",
    "goal": "product_awareness"
  },

  "brand": {
    "name": "Adidas",
    "brand_attributes": [
      "premium",
      "athletic",
      "confident"
    ]
  },

  "subject": {
    "athlete_id": "athlete_456",
    "identity_priority": "maximum"
  },

  "product": {
    "product_id": "product_789",
    "fidelity": "maximum"
  },

  "creative_direction": {
    "tone": "cinematic",
    "style": "premium_sports",
    "energy": "controlled"
  },

  "references": [
    {
      "asset_id": "ref_001",
      "role": "visual_style"
    }
  ],

  "output": {
    "type": "video",
    "aspect_ratio": "9:16",
    "platform": "instagram"
  }
}
```

This should be stored in your database.

Every revision should create a new version.

## 6. Layer 3 — Asset Intelligence

Every uploaded asset should be classified.

Do not simply pass “10 images” to the generation model.

Build an asset registry.

Example:

```json
{
  "asset_id": "asset_123",
  "type": "image",

  "role": [
    "identity_reference"
  ],

  "subject": {
    "person": true,
    "face": true,
    "full_body": true
  },

  "quality": {
    "resolution": "high",
    "face_visibility": "excellent"
  }
}
```

Another:

```json
{
  "asset_id": "asset_456",

  "role": [
    "product_reference"
  ],

  "product": {
    "category": "football_boot",
    "brand": "Adidas"
  }
}
```

Another:

```json
{
  "asset_id": "asset_789",

  "role": [
    "style_reference"
  ]
}
```

This prevents the system from confusing:

- identity reference

with

- style reference

with

- product reference

with

- composition reference.

## 7. Reference Decomposition

When a user says:

> “I want something like this.”

The system should not simply forward the reference image.

Instead, run a Reference Analysis step.

Extract:

```
REFERENCE
│
├── Composition
├── Camera
├── Lens / perspective
├── Lighting
├── Color
├── Environment
├── Subject placement
├── Wardrobe
├── Motion
├── Editing rhythm
├── Typography
└── Emotional tone
```

Then create:

```json
{
  "reference_intent": {
    "camera": "...",
    "lighting": "...",
    "composition": "...",
    "color": "...",
    "mood": "..."
  }
}
```

The new generation should inherit the creative attributes, not copy the original content.

Google’s image guidance similarly emphasizes explicit visual description and reference images for maintaining subjects and building consistent multi-image stories. (Google DeepMind)

## 8. Layer 4 — Creative Capability Library

This is one of the most strategically important Nomila components.

The agent needs a controlled vocabulary of things it can request.

### Camera

- wide
- medium-wide
- medium
- close-up
- extreme close-up
- macro
- POV
- over-the-shoulder
- low angle
- high angle
- overhead

### Camera movement

- static
- push-in
- pull-out
- dolly
- tracking
- orbit
- crane
- pan
- tilt
- handheld
- whip pan

### Lighting

- natural
- golden hour
- studio
- hard light
- soft light
- rim light
- backlight
- neon
- stadium
- low-key
- high-key

### Composition

- centered
- rule of thirds
- symmetrical
- negative space
- foreground framing
- layered depth
- shallow depth of field

### Motion

- walking
- running
- turning
- jumping
- celebrating
- interacting with product
- slow motion
- speed ramp

### Environment

- stadium
- locker room
- training facility
- street
- studio
- hotel
- airport
- beach
- city

### Commercial styles

- sports campaign
- fashion editorial
- luxury
- UGC
- documentary
- cinematic
- product hero
- social advertisement

These should be represented as structured objects, not simply strings.

## 9. Capability Objects

Example:

```json
{
  "capability_id": "camera_slow_push",

  "category": "camera_movement",

  "description":
    "Camera gradually moves toward the subject.",

  "modalities": [
    "video"
  ],

  "models": [
    "veo",
    "model_x"
  ],

  "reliability": 0.93,

  "best_for": [
    "hero",
    "product",
    "fashion"
  ],

  "known_failure_modes": [
    "multiple moving subjects"
  ]
}
```

The important field is:

```
reliability
```

Initially this is expert-estimated.

Eventually it becomes empirical.

## 10. Layer 5 — Model Capability Registry

Maintain an internal registry for every approved generation model.

Example:

```json
{
  "model_id": "veo_x",

  "provider": "google",

  "modality": [
    "video"
  ],

  "supports": {
    "text_to_video": true,
    "image_to_video": true,
    "reference_images": true,
    "audio": true
  },

  "reference_limits": {
    "max_images": 3
  },

  "strengths": [
    "cinematography",
    "camera_motion",
    "character_reference",
    "product_reference"
  ],

  "known_weaknesses": [
    "..."
  ]
}
```

This information should be supplemented by actual Nomila testing.

OpenRouter exposes model metadata and filtering through its Models API, but Nomila should maintain its own higher-level capability registry because generic model metadata does not tell you whether a model is reliably good at a particular creative task. (OpenRouter)

For example, Google’s current Veo documentation explicitly supports reference images for people, characters and products, and Veo 3.1 supports up to three reference images for guiding generated video. (Google DeepMind)

## 11. Model Capability Matrix

Eventually build a matrix like:

| Capability | Model A | Model B | Model C |
|---|---|---|---|
| Athlete identity | 95 | 87 | 92 |
| Product fidelity | 93 | 89 | 84 |
| Human motion | 91 | 96 | 82 |
| Camera motion | 94 | 91 | 80 |
| Sports action | 95 | 88 | 85 |
| Hands | 89 | 82 | 90 |
| Image editing | 96 | 90 | 84 |
| Reference images | 95 | 88 | 91 |

Do not assume these values.

Create them through testing.

This becomes one of Nomila’s proprietary datasets.

## 12. Layer 6 — Shot Planner

For video, the ShotSpec becomes the most important execution object.

Example:

```json
{
  "shot_id": "S03",

  "purpose": "athlete_hero",

  "duration": 5,

  "subject": {
    "athlete_id": "athlete_456",
    "identity_reference": [
      "asset_001",
      "asset_002"
    ]
  },

  "action": {
    "primary": "walking"
  },

  "camera": {
    "shot": "medium_wide",
    "angle": "low",
    "movement": "slow_orbit",
    "direction": "left_to_right"
  },

  "environment": {
    "location": "stadium_tunnel",
    "time": "night"
  },

  "lighting": {
    "style": "cinematic",
    "key": "stadium_practical"
  },

  "composition": {
    "subject_position": "center"
  },

  "product": {
    "product_reference": "asset_003",
    "visibility": "medium"
  },

  "constraints": [
    "preserve_identity",
    "preserve_product_geometry"
  ]
}
```

The agent can now create sophisticated campaigns without directly writing generation prompts.

## 13. Capability Validation

Before generation, run:

```
ShotSpec
   ↓
Capability Validator
   ↓
Can selected model reliably execute this?
```

Example:

```
Identity preservation       HIGH
Product reference           HIGH
Walking                      HIGH
Low-angle                    HIGH
Orbit                        MEDIUM
Product interaction          LOW
```

The system can then:

**Option A**

Execute.

**Option B**

Simplify the shot.

**Option C**

Split it into two shots.

This is extremely important.

The AI should not be allowed to create beautiful but technically unrealistic shot lists.

## 14. Prompt Compiler

Only after all of the above do we generate the actual prompt.

```
CreativeSpec
+
ShotSpec
+
AssetAnalysis
+
ModelCapabilities
+
ModelPromptStrategy
+
CampaignContinuity
          ↓
      PROMPT
```

The compiler should have a model-specific adapter:

```
prompt_compilers/
│
├── veo/
│   ├── video_compiler
│   └── reference_strategy
│
├── gemini_image/
│   ├── image_compiler
│   └── editing_strategy
│
└── model_x/
    └── ...
```

Google’s Veo documentation provides an excellent example of why this layer should be model-specific: its recommended prompt dimensions explicitly include framing, camera movement, style, lighting, character descriptions and sound. (Google DeepMind)

Likewise, Google’s Gemini image guidance recommends specifying the desired format/aspect ratio and using clear reference images and named subjects for consistency. (Google DeepMind)

## 15. LoRA / Athlete Identity

### Short answer

Yes — eventually I would build an athlete-specific identity adapter, but I would NOT make “one LoRA per athlete” the foundation of the architecture.

This distinction is important.

A LoRA is model-specific.

Therefore:

```
Athlete
   ↓
Veo LoRA        ← only if Veo supports/permits this workflow
Gemini adapter  ← only if supported
FLUX LoRA       ← possible
SDXL LoRA       ← possible
```

You cannot create one universal “Mia LoRA” and expect every model to consume it.

LoRA is an adaptation mechanism attached to a particular model architecture/checkpoint. Hugging Face’s Diffusers documentation describes LoRA as a lightweight set of trained weights that can be loaded into supported diffusion models. (Hugging Face)

## 16. I would build an Athlete Identity System instead

Think:

```
ATHLETE IDENTITY PROFILE
        │
        ├── Reference images
        ├── Face embeddings
        ├── Body/appearance metadata
        ├── Hair
        ├── Skin
        ├── Typical expressions
        ├── Height/proportions
        ├── Wardrobe references
        │
        ├── Model-specific identity adapters
        │       ├── FLUX LoRA
        │       ├── SDXL LoRA
        │       └── other supported adapters
        │
        └── Identity evaluation suite
```

This gives you a much more future-proof architecture.

## 17. Athlete Identity Levels

I would create four levels.

### Level 0 — No identity model

Just prompt.

```
"female soccer athlete"
```

Lowest reliability.

### Level 1 — Reference Pack

Multiple high-quality athlete images.

Use when supported by the generation model.

This should be your default starting point.

### Level 2 — Identity Adapter

Use an appropriate identity-preserving technique such as an identity adapter/reference mechanism.

InstantID, for example, is specifically designed for identity-preserving generation without tuning and supports identity conditioning from reference images. (GitHub)

PuLID is another research direction specifically targeting ID customization while preserving the behavior of the base model. (GitHub)

### Level 3 — Model-specific Athlete LoRA

For models you control and where LoRA is technically appropriate.

This provides another mechanism for improving repeatability.

## 18. When should Nomila train a LoRA?

I would NOT automatically train one for every athlete.

Instead:

```
Athlete signs up
      ↓
Build reference identity profile
      ↓
Generate benchmark images
      ↓
Measure identity consistency
      ↓
If score < threshold
      ↓
Try stronger reference/identity technique
      ↓
If still < threshold
      ↓
Consider model-specific LoRA
```

For example:

```
Identity Score

Reference-only              87
Identity adapter             93
LoRA                         97
```

Only train the LoRA when the improvement justifies the infrastructure cost.

## 19. LoRA Should Be Treated as an Execution Asset

Example database:

```json
{
  "athlete_id": "athlete_123",

  "identity_assets": {
    "reference_pack": "...",
    "face_embedding": "..."
  },

  "adapters": [
    {
      "type": "lora",
      "base_model": "model_x",
      "version": "v3",
      "training_dataset": "dataset_123",
      "quality_score": 0.96
    }
  ]
}
```

This is much better than putting LoRA logic into the Creative Director.

The Creative Director says:

> Preserve athlete identity.

The Model Router decides:

> This model supports the athlete’s identity adapter.

The execution layer attaches it.

## 20. Athlete LoRA Training Dataset

If you eventually train athlete-specific LoRAs, create a standardized onboarding dataset.

For example:

```
20–40 high-quality images

Front
3/4 left
3/4 right
Profile
Full body
Half body
Close-up
Different expressions
Different lighting
Different hairstyles if relevant
Training/sport environment
Casual environment
```

The exact optimal dataset should be experimentally determined for each base model.

Hugging Face provides official DreamBooth and LoRA training workflows and notes that LoRA substantially reduces trainable parameters and produces relatively small adapter weights. (Hugging Face)

## 21. Critical: Identity Evaluation

Do not simply ask an LLM:

> “Does this look like the athlete?”

Build quantitative evaluation.

For each athlete:

```
Identity Benchmark
──────────────────────────

Reference 01
Reference 02
Reference 03
Reference 04
Reference 05

       ↓

Generate standardized test images

       ↓

Identity similarity measurement

       ↓

Score
```

Potential metrics:

- Face similarity
- Visual identity similarity
- Pose consistency
- Hair consistency
- Body consistency
- Skin/appearance consistency

You can combine automated metrics with multimodal LLM judging and human evaluation.

The point is to have:

```
identity_score = 0.94
```

rather than:

> “It looks pretty good.”

## 22. Layer 7 — Creative QA / Critic

Every generation should be evaluated.

For image:

- Identity
- Product fidelity
- Composition
- Lighting
- Aesthetic
- Prompt adherence
- Anatomy
- Text/logo accuracy

For video:

- Identity
- Temporal consistency
- Motion realism
- Camera movement
- Shot adherence
- Product consistency
- Lighting continuity
- Background continuity
- Audio

Example:

```json
{
  "identity": 0.96,
  "product_fidelity": 0.93,
  "composition": 0.91,
  "cinematography": 0.95,
  "motion": 0.87,
  "prompt_adherence": 0.92,
  "overall": 0.92
}
```

## 23. The Generation Loop

The first version should be:

```
Generate
   ↓
Evaluate
   ↓
If PASS → deliver

If FAIL:
   ↓
Identify failure
   ↓
Modify ShotSpec / prompt
   ↓
Regenerate
```

Do not blindly regenerate.

The critic needs to identify the failure.

Example:

```
FAILURE:

Identity = 0.94 ✓
Product = 0.96 ✓
Camera = 0.91 ✓
Motion = 0.64 ✗

Cause:
Athlete's hands become distorted during product interaction.

Correction:
Remove simultaneous hand/product interaction.
Move product interaction to separate shot.
```

This is much more powerful than simply saying:

> “Try again.”

## 24. Empirical Learning System

This is where Nomila can become increasingly differentiated.

For every generation, log:

```json
{
  "campaign_id": "...",
  "shot_id": "...",

  "creative_spec_version": 4,
  "shot_spec_version": 7,

  "model": "...",
  "model_version": "...",

  "prompt_version": 12,

  "assets": [...],

  "parameters": {...},

  "output": "...",

  "automated_scores": {...},

  "user_rating": 5,

  "accepted": true,

  "regeneration_count": 1,

  "failure_reason": null
}
```

This becomes your Creative Generation Dataset.

## 25. Build an Evaluation Dataset

Do not rely exclusively on production traffic.

Create a permanent benchmark set.

For example:

```
100 athlete image tasks
100 athlete video tasks
100 product advertisements
100 image-edit tasks
100 image-to-video tasks
100 reference-style tasks
```

Each task should have:

- Input assets
- Creative brief
- Expected capabilities
- Expected constraints
- Target model
- Evaluation criteria

Then every time you change:

- model
- prompt compiler
- capability definition
- LoRA
- routing algorithm

run the benchmark.

## 26. Model A/B Testing

Example:

```
Task: Athlete portrait

Model A
100 generations
Identity: 94
Composition: 91
User acceptance: 82%

Model B
100 generations
Identity: 96
Composition: 94
User acceptance: 89%
```

Now you have empirical evidence.

Instead of:

> “Model B seems better.”

you know:

> “Model B produces 8.5% higher acceptance on this class of task.”

## 27. Prompt A/B Testing

Do the same thing with prompt strategies.

```
V12 Prompt Compiler
vs
V13 Prompt Compiler
```

Measure:

- Identity
- Prompt adherence
- Aesthetic quality
- User acceptance
- Regeneration rate
- Cost
- Latency

MLflow provides a useful reference architecture here: version prompt templates, create evaluation datasets, run models against them and score outputs systematically. (MLflow AI Platform)

## 28. Recommendation: Create a “Creative Benchmark Suite”

This should become an actual engineering artifact.

```
creative-benchmarks/

athlete/
    portrait/
    full-body/
    action/

product/
    product-hero/
    product-interaction/
    product-detail/

video/
    walking/
    running/
    sports-action/
    camera-motion/

editing/
    background/
    lighting/
    wardrobe/

reference/
    style-transfer/
    composition/
    cinematography/
```

Each test gets a unique ID.

## 29. Capability Reliability Should Become Empirical

Initially:

```
orbit_camera = 0.85
```

because your team estimates it.

After 1,000 generations:

```
orbit_camera = 0.914
```

based on actual results.

Eventually:

```
capability_reliability(
    capability="orbit",
    model="veo",
    subject="athlete",
    environment="stadium"
)
=
0.94
```

This is much more useful than a generic model benchmark.

## 30. Contextual Capability Scoring

This is an important future feature.

> “Can Veo do orbit shots?”

is too broad.

Instead:

```
Can Model X do:

orbit
+
athlete
+
stadium
+
night
+
product
+
identity preservation
+
5 seconds
?
```

The capability score becomes contextual.

Eventually the model router can learn:

```
P(success | model, capability, subject, environment, references, prompt)
```

That is essentially your proprietary creative execution intelligence.

## 31. Model Router

The router should optimize multiple variables.

Example:

```
Model Score =

30% expected quality
20% identity reliability
15% product fidelity
10% capability fit
10% cost
10% latency
5% historical user preference
```

The weights should be configurable.

For a premium campaign:

```
quality_weight = HIGH
cost_weight = LOW
```

For high-volume social:

```
quality_weight = HIGH
cost_weight = MEDIUM
latency_weight = HIGH
```

## 32. OpenRouter’s Role

OpenRouter should primarily be your model/provider access and routing layer.

Nomila should remain responsible for:

- Creative intelligence
- Model capability knowledge
- Shot planning
- Prompt compilation
- Asset intelligence
- Identity management
- Quality evaluation
- Empirical model scoring

OpenRouter gives you the unified API and access to a large model catalog; Nomila adds the domain-specific intelligence above it. (OpenRouter)

## 33. Recommended Backend Services

I would eventually separate the architecture into services/modules:

```
creative-engine/
│
├── creative-director/
│
├── campaign-planner/
│
├── shot-planner/
│
├── asset-intelligence/
│
├── reference-analyzer/
│
├── capability-library/
│
├── model-registry/
│
├── model-router/
│
├── prompt-compiler/
│
├── identity-engine/
│
├── generation-engine/
│
├── quality-engine/
│
├── evaluation-engine/
│
└── learning-engine/
```

You do not need to deploy all of these as separate microservices initially.

They can start as modules in one service.

## 34. Suggested Database Objects

At minimum:

- CreativeProject
- CreativeSpec
- Campaign
- Shot
- ShotSpec
- Asset
- AssetAnalysis
- ReferenceAnalysis
- Capability
- Model
- ModelCapability
- PromptTemplate
- PromptVersion
- Generation
- Evaluation
- IdentityProfile
- IdentityAdapter
- Benchmark
- BenchmarkResult
- UserFeedback

Relationships:

```
CreativeProject
      │
      ├── CreativeSpec
      │
      ├── Campaign
      │      │
      │      ├── Shot
      │      │      │
      │      │      ├── ShotSpec
      │      │      ├── Generation
      │      │      └── Evaluation
      │      │
      │      └── ...
      │
      └── Assets
```

## 35. Recommended First Version

Do NOT build everything at once.

### Phase 1 — Creative Planning

Build:

```
User
 ↓
Creative Director
 ↓
Creative Spec
 ↓
ShotSpec
```

No sophisticated LoRA yet.

### Phase 2 — Capability Layer

Build:

```
Capability Library
+
Model Registry
+
Model Router
```

Start with a small number of approved models.

### Phase 3 — Prompt Compiler

Build:

```
ShotSpec
 ↓
Model-specific compiler
 ↓
OpenRouter
```

### Phase 4 — Asset Intelligence

Add:

- Athlete reference pack
- Product references
- Style references
- Reference decomposition

### Phase 5 — Evaluation

Add:

```
Generation
 ↓
Critic
 ↓
Score
 ↓
Regenerate
```

### Phase 6 — Identity

Add:

```
Identity profile
 ↓
Reference-based identity
 ↓
Identity scoring
 ↓
Model-specific adapters where justified
```

### Phase 7 — Learning

Add:

```
Every generation
 ↓
Evaluation
 ↓
User feedback
 ↓
Benchmark dataset
 ↓
Model/prompt/capability optimization
```

## 36. Where I Would NOT Start

I would not start by:

- training LoRAs for every athlete
- supporting 30 models
- building a giant prompt library
- building autonomous multi-agent orchestration
- automatically changing models on every generation
- fine-tuning your Creative Director

First prove:

> Can we take 100 creative briefs and reliably turn them into high-quality, correctly specified shots?

Then prove:

> Can we execute those shots consistently?

Then:

> Can we measure why they fail?

Then:

> Can we improve automatically?

That sequence keeps the engineering complexity justified by measured performance, which is consistent with the recommendations in Anthropic’s agent architecture guidance. (Anthropic)

## 37. Initial Reference Library

### Agent architecture

**Anthropic — Building Effective AI Agents**

Useful for workflow patterns, tool use, evaluator/optimizer patterns and deciding when agent complexity is justified. (Anthropic)

Anthropic — Building Effective Agents

### OpenRouter

**OpenRouter documentation**

Use for unified model access, model discovery, API integration and provider/model routing. (OpenRouter)

OpenRouter Quickstart
OpenRouter Models API documentation

### Video prompting

**Google DeepMind — Veo Prompt Guide**

Particularly useful for building your video capability vocabulary: shot framing, motion, style, lighting, character descriptions and sound. (Google DeepMind)

Google DeepMind Veo Prompt Guide

### Video references

**Google — Veo 3.1**

Useful for understanding reference-image-based generation and the concept of supplying character/product/scene “ingredients.” (Google DeepMind)

Google Veo 3.1
Veo 3.1 Gemini API documentation

### Image prompting

**Google DeepMind — Gemini image prompting**

Useful for image composition, aspect ratio, reference images and maintaining subject consistency. (Google DeepMind)

Google Gemini Image Prompt Guide

### Image prompting

**OpenAI Academy — Image Generation**

Useful as a general reference for decomposing image prompts into purpose, subject, action, environment, visual style and constraints. (OpenAI)

OpenAI Academy — Creating Images

### LoRA

**Hugging Face Diffusers — LoRA**

Primary engineering reference for training and deploying LoRA adapters. (Hugging Face)

Hugging Face Diffusers LoRA Documentation

### DreamBooth / LoRA

Useful for understanding subject-specific adaptation and the relationship between DreamBooth and LoRA. (Hugging Face)

Hugging Face DreamBooth Documentation

### Identity preservation

**InstantID**

A particularly relevant research/codebase for identity-preserving image generation without per-subject training. This is important because it demonstrates why an athlete identity system does not necessarily need to begin with a LoRA. (GitHub)

InstantID GitHub

### Identity customization

**PuLID**

Another useful research/code reference for identity customization and preserving identity while maintaining model behavior. (GitHub)

PuLID GitHub

### Evaluation

**MLflow Prompt Evaluation**

Useful reference for versioning prompts, creating evaluation datasets and comparing prompt/model versions systematically. (MLflow AI Platform)

MLflow Prompt Evaluation

### Evaluation infrastructure

**NVIDIA NeMo Evaluator**

Useful reference for reproducible evaluation, custom benchmarks, scorers, statistical comparison and quality gates. (NVIDIA Documentation)

NVIDIA NeMo Evaluator
NVIDIA NeMo Evaluator GitHub

## 38. Final Architecture Recommendation

The architecture I recommend for Nomila is:

```
                        HUMAN / MILA
                              │
                              ▼
                    ┌──────────────────┐
                    │ CREATIVE DIRECTOR│
                    └────────┬─────────┘
                             ↓
                    ┌──────────────────┐
                    │ CREATIVE SPEC    │
                    └────────┬─────────┘
                             ↓
          ┌──────────────────────────────────┐
          │       ASSET INTELLIGENCE         │
          │                                  │
          │ Athlete / Product / References  │
          └────────────────┬─────────────────┘
                           ↓
          ┌──────────────────────────────────┐
          │     CREATIVE CAPABILITY LIBRARY  │
          └────────────────┬─────────────────┘
                           ↓
          ┌──────────────────────────────────┐
          │       MODEL CAPABILITY REGISTRY  │
          └────────────────┬─────────────────┘
                           ↓
                    ┌──────────────┐
                    │ SHOT PLANNER │
                    └──────┬───────┘
                           ↓
                    ┌──────────────┐
                    │ CAPABILITY   │
                    │ VALIDATOR    │
                    └──────┬───────┘
                           ↓
                    ┌──────────────┐
                    │ MODEL ROUTER │
                    └──────┬───────┘
                           ↓
                  ┌─────────────────┐
                  │ PROMPT COMPILER │
                  └────────┬────────┘
                           ↓
                       OPENROUTER
                           ↓
               ┌───────────┴───────────┐
               │                       │
            IMAGE                    VIDEO
               │                       │
               └───────────┬───────────┘
                           ↓
                    ┌──────────────┐
                    │ CREATIVE QA  │
                    └──────┬───────┘
                           ↓
                    PASS / ITERATE
                           ↓
                 ┌───────────────────┐
                 │ LEARNING SYSTEM   │
                 │                   │
                 │ Results           │
                 │ User feedback     │
                 │ Benchmarks        │
                 │ Model scores      │
                 │ Prompt scores     │
                 │ Identity scores   │
                 └───────────────────┘
```

### The strategic thesis

The long-term moat is not the prompt library.

It is the combination of:

**Creative Capability Graph + Model Capability Graph + Athlete Identity System + Generation Dataset + Evaluation System.**

The prompt library is simply the compiler layer that translates those things into instructions a particular model understands.

And I would treat the athlete LoRA as one possible identity execution mechanism inside that larger Identity System, not as the identity architecture itself.

That gives Nomila the ability to switch from one frontier model to another without rebuilding the creative system, while simultaneously allowing the system to learn which model, prompt strategy, reference strategy and identity method actually produces the best result for each type of creative task.
