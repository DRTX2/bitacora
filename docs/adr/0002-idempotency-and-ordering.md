# ADR-0002: Idempotent, order-independent ingestion

**Status:** accepted · 2026-11-17

## Context
Two publishers feed one incident: Nimbus (`incident.*`, through Hookrelay's inbound endpoint) and Flagship (`flag.*`). Hookrelay delivers at least once and retries each endpoint independently, so:
- the same delivery can arrive more than once (same `webhook-id`);
- a flag kill can arrive before the incident it belongs to;
- the Nimbus workflow notifies Hookrelay *after* it kills the flag, so delivery time is not event time.

## Decision
1. **Writes are idempotent by construction.** Timeline items are keyed `EVENT#<at>#<webhook-id>`; incident timestamps use `SET x = if_not_exists(x, :at)`. Replaying any delivery leaves the same state.
2. **A delivery is marked as seen after it's processed.** The marker only short-circuits obvious duplicates. If the function dies between processing and marking, the retry reprocesses safely.
3. **Event time comes from the source.** Incidents use Nimbus' `occurredAt` (added to Nimbus for this; it's additive and optional for other consumers). Flag events use Flagship's `at`. The envelope timestamp is only a fallback.
4. **Timestamps are normalized** to fixed-width ISO-8601 (`toISOString()`), because they are sort keys compared as text: Go writes `…30.1Z`, JavaScript `…30.100Z`, and the first would sort after `…30.123Z`.
5. **Correlation needs both the audit text and the automation actor**, so a person can't link a change to an incident by typing the text.

## Consequences
- The integration test delivers events out of order and twice and asserts the same timeline.
- The end-to-end Atalaya demo caught decision 3: using delivery time made "opened" land after "mitigated" (a negative time to mitigate).
