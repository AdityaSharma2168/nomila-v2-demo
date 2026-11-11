# docs/architecture

Canonical architecture records for nomila-v2. The target architecture is the Nomila Product &
Intelligence Architecture Blueprint V1 / Commercial Intelligence Beta.1 specification (held
outside the repo); this directory holds the decisions and build records that implement it.

- `adr/` — architecture decision records. ADR-001 to ADR-014 are in the Blueprint; records
  from ADR-015 onward are here.
- `phase-a/` — build records per Phase A step (Identity → Research → Canonical Profile →
  Social Intelligence → Marketability → Rates → Commercial Intelligence).

Audits and design proposals are working references, not canonical documents, and are not
committed here.

- [Cross-system principles](intelligence-architecture-principles.md) — P-1 grounding is task-dependent, not a global model setting (Research / Fact Mode ON; Reasoning / Creative Mode OFF by default; mixed workflows separate the stages; routing selects model + execution mode)
