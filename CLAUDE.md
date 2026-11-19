# Bitácora

Incident ledger for Atalaya: Hookrelay webhook consumer → timeline, response metrics, postmortem. Lambda handlers in `src/handlers/` (ingest, query, admin), domain logic in `src/domain/` (pure, unit-tested), DynamoDB single table in `src/infra/store.ts`. Decisions: `docs/adr/`.

## Commands
```bash
npm ci
docker compose up -d --wait     # DynamoDB Local (:8002) + local runtime (:8090)
npm run typecheck && npm test && npm run test:integration && npm run build
terraform -chdir=infra/terraform fmt -check -recursive && terraform -chdir=infra/terraform validate
docker compose down
```

## Invariants (tests cover them; keep them true)
- Every write is idempotent and order-independent (keys include the webhook id, timestamps use `if_not_exists`). A delivery is marked as seen after processing, never before.
- Incident time comes from Nimbus' `occurredAt`; all timestamps are normalized with `toISOString()` because they are sort keys compared as text.
- A flag event links to an incident only with both the audit text `killed by nimbus incident <id>` and the actor `nimbus (automation)`.
- Ingest status codes are for Hookrelay's retry policy: 2xx stops retries, 409 = source not connected yet (retry).
- Each Lambda keeps least-privilege IAM; Trivy must stay at zero findings.
