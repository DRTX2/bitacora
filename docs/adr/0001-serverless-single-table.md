# ADR-0001: Serverless on AWS with a single DynamoDB table

**Status:** accepted · 2026-11-17

## Context
Bitácora receives a handful of webhooks per incident and is read when someone reviews one. Traffic is near zero most of the time, with short bursts. The other Atalaya products run as containers on ECS Fargate with PostgreSQL.

## Decision
- API Gateway HTTP API → Lambda (Node 22, arm64) → DynamoDB on-demand.
- One table with generic keys (`pk`, `sk`) and one GSI (`gsi1pk = INCIDENTS`, `gsi1sk = openedAt`) for the newest-first list.
- Access patterns drive the keys: incident metadata and its timeline share a partition (`INCIDENT#<id>`), so reading an incident is one `GetItem` plus one `Query`.

## Consequences
- Cost follows usage: no idle containers or databases for a service that's quiet between incidents.
- No servers or database engines to patch; point-in-time recovery and encryption are table settings.
- New access patterns need a new index or key design up front (no ad-hoc SQL). Acceptable for a ledger with three read paths.
- It also shows a different deployment model next to the ECS products, on purpose: the right shape depends on the traffic.
