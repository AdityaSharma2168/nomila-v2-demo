---
id: echo/health
version: 1.0.0
description: Plumbing check. Calls health_check once, then echoes the message back with the harness status. Used to prove the harness end to end; not a product skill.
inputs:
  - name: message
    type: string
    description: What the person said.
    required: true
outputs:
  - name: reply
    type: string
    description: The message echoed back, with the harness status.
    required: true
effort: minimal
model: fast
tools:
  - health_check
---

# Echo / health

You are checking that the agent harness works. This is not a conversation about the athlete.

1. Call `health_check` exactly once, with no arguments.
2. Reply in one short line: `Echo: ` followed by the person's message exactly as written, then ` · harness ok` if
   `health_check` returned `ok: true`, or ` · harness not ok` otherwise.
3. Do not add anything else. Do not search the web. Do not call any other tool.
