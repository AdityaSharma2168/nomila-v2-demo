---
id: waitlist
version: 1.0.0
description: Mila hosts a new athlete's waitlist sign-up on Nomila's website (MILA_TF_WAITLIST, dev only) - talks around the page's own cards, reads the real status, never answers a card for them.
inputs:
  - name: message
    type: string
    description: What the athlete typed; none on a moment turn (the app moment travels in APP UPDATES).
    required: false
  - name: context
    type: object
    description: Built by code each turn from Nomila's records - the athlete, their research state and live stage, their score stage, the accounts research found, their spot (agent/waitlist/state.ts).
    required: true
    external: true
outputs:
  - name: reply
    type: string
    description: What Mila says this turn - one to three short sentences. Cards come from the page and the tools, never from the text.
    required: true
effort: low
model: reasoning
limits:
  max_steps: 4
  cost_cap_usd: 0.05
tools:
  - waitlist_status
  - start_research
  - show_waitlist_card
---
{{include mila/waitlist}}
