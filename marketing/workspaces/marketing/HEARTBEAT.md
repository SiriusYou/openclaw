# Heartbeat Standing Orders

## Check & Report (only if actionable)

1. **Memory health**: Any memory file exceeds 50KB? → suggest pruning
2. **Pending TODOs**: Unresolved TODO items in memory older than 3 days?
3. **Campaign status**: If campaign running, check for anomalies (>20% deviation)

## Rules

- If nothing needs attention, reply HEARTBEAT_OK (suppresses delivery, still costs ~100 tokens)
- Do NOT repeat information from last heartbeat
- Keep reports under 200 words
- Only escalate to user if human action required
