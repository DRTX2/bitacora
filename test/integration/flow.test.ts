import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Event } from '../../src/handlers/http.ts';
import { admin } from '../../src/handlers/admin.ts';
import { ingest } from '../../src/handlers/ingest.ts';
import { query } from '../../src/handlers/query.ts';
import { sign } from '../../src/domain/signature.ts';
import { createStore } from '../../src/infra/store.ts';

// Real DynamoDB (DynamoDB Local from compose.yaml): `docker compose up -d dynamodb`, then npm run test:integration.
const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8002';
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
process.env.BITACORA_TOKEN = 'test-token';
process.env.PUBLIC_BASE_URL = 'http://bitacora.test';

const store = createStore(`bitacora-test-${Date.now()}`, endpoint);
const handlers = { ingest: ingest(store), query: query(store), admin: admin(store) };
const SECRET = 'whsec_' + Buffer.from('bitacora-integration-test-secret').toString('base64');
const auth = { authorization: 'Bearer test-token' };

const event = (method: string, rawPath: string, opts: { body?: string; headers?: Record<string, string>; pathParameters?: Record<string, string> } = {}) =>
  ({ rawPath, headers: opts.headers ?? {}, body: opts.body, isBase64Encoded: false, pathParameters: opts.pathParameters, requestContext: { domainName: 'x', http: { method, path: rawPath } } }) as unknown as Event;

let sourceId = '';
/** What Hookrelay sends: the same message id on every retry, signed per attempt. */
function deliver(type: string, timestamp: string, data: object, id = `msg_${randomUUID()}`) {
  const body = JSON.stringify({ type, timestamp, data });
  const ts = Math.floor(Date.now() / 1000);
  return {
    id,
    send: (secret = SECRET) =>
      handlers.ingest(event('POST', `/webhooks/hookrelay/${sourceId}`, {
        body, pathParameters: { sourceId },
        headers: { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, id, ts, body) },
      })),
  };
}
const get = async (path: string, incidentId?: string) => handlers.query(event('GET', path, { headers: auth, pathParameters: incidentId ? { incidentId } : undefined }));

beforeAll(async () => {
  await store.ensureTable();
  const created = await handlers.admin(event('POST', '/sources', { headers: auth, body: JSON.stringify({ name: 'hookrelay (atalaya)' }) }));
  expect(created.statusCode).toBe(201);
  const source = JSON.parse(created.body!);
  sourceId = source.id;
  expect(source.webhookUrl).toBe(`http://bitacora.test/webhooks/hookrelay/${sourceId}`);
});

describe('connecting a source', () => {
  it('asks Hookrelay to retry until the signing secret is stored (409), then accepts', async () => {
    const early = deliver('incident.opened', '2026-11-17T05:00:00.000Z', { event: 'opened', incidentId: 'early' });
    expect((await early.send()).statusCode).toBe(409);
    const stored = await handlers.admin(event('PUT', `/sources/${sourceId}/secret`, { headers: auth, pathParameters: { sourceId }, body: JSON.stringify({ secret: SECRET }) }));
    expect(stored.statusCode).toBe(204);
    expect((await early.send()).statusCode).toBe(200);
  });

  it('rejects unknown sources, bad signatures, non-whsec secrets and missing tokens', async () => {
    const forged = deliver('incident.opened', '2026-11-17T05:00:00.000Z', { event: 'opened', incidentId: 'forged' });
    expect((await forged.send('whsec_' + Buffer.from('attacker-guessed-secret').toString('base64'))).statusCode).toBe(401);
    expect((await get('/incidents/forged', 'forged')).statusCode).toBe(404);
    const unknown = await handlers.ingest(event('POST', '/webhooks/hookrelay/nope', { body: '{}', pathParameters: { sourceId: 'nope' } }));
    expect(unknown.statusCode).toBe(404);
    const weak = await handlers.admin(event('PUT', `/sources/${sourceId}/secret`, { headers: auth, pathParameters: { sourceId }, body: JSON.stringify({ secret: 'hunter2' }) }));
    expect(weak.statusCode).toBe(400);
    expect((await handlers.query(event('GET', '/incidents'))).statusCode).toBe(401);
  });
});

describe('the Atalaya incident, as Hookrelay delivers it', () => {
  const id = 'f6e6caf6-6c5c-4e46-b56c-0337618f95a0';
  const opened = deliver('incident.opened', '2026-11-17T05:32:33.000Z', { event: 'opened', incidentId: id, summary: 'Queue backlog is aging while the Lambda consumer has no invocations', detector: 'consumer_stalled', severity: 'critical', pipelineName: 'Orders async pipeline' });
  const killed = deliver('flag.updated', '2026-11-17T05:32:33.700Z', { flagKey: 'orders-v2', env: 'production', version: 4, action: `killed by nimbus incident ${id}: Queue backlog`, actor: 'nimbus (automation)', at: '2026-11-17T05:32:33.615Z' });
  const recovered = deliver('incident.recovered', '2026-11-17T05:42:33.000Z', { event: 'recovered', incidentId: id });
  const restored = deliver('flag.updated', '2026-11-17T05:42:34.300Z', { flagKey: 'orders-v2', env: 'production', version: 5, action: 'rolled back to #3', actor: 'nimbus (automation)', at: '2026-11-17T05:42:34.200Z' });

  it('builds the same timeline whatever the arrival order, and ignores redeliveries', async () => {
    // The kill arrives before the incident it belongs to (different publishers, independent retries).
    for (const d of [killed, opened, recovered, restored]) expect((await d.send()).statusCode).toBe(200);
    expect(JSON.parse((await opened.send()).body!)).toEqual({ duplicate: true });

    const res = await get(`/incidents/${id}`, id);
    expect(res.statusCode).toBe(200);
    const { incident, metrics, timeline } = JSON.parse(res.body!);
    expect(incident).toMatchObject({ incidentId: id, pipelineName: 'Orders async pipeline', flags: ['orders-v2@production'] });
    expect(metrics).toEqual({ status: 'recovered', timeToMitigateMs: 615, timeToRecoverMs: 600_000, timeToRestoreMs: 1200 });
    expect(timeline.map((t: { type: string }) => t.type)).toEqual(['incident.opened', 'flag.killed', 'incident.recovered', 'flag.restored']);
  });

  it('lists incidents newest first with their metrics', async () => {
    const { items } = JSON.parse((await get('/incidents')).body!);
    expect(items[0]).toMatchObject({ incidentId: id, status: 'recovered', timeToMitigateMs: 615 });
  });

  it('renders the postmortem as Markdown', async () => {
    const res = await get(`/incidents/${id}/postmortem`, id);
    expect(res.headers?.['content-type']).toContain('text/markdown');
    expect(res.body).toContain('| Opened → mitigated (flag off) | 615 ms |');
    expect(res.body).toContain('Automation turned off orders-v2@production 615 ms after the incident opened.');
  });
});

describe('a person steps in during an incident', () => {
  it('records the manual change, and the postmortem explains why the flag was not restored', async () => {
    const id = 'aa11bb22-0000-4000-8000-000000000001';
    await deliver('incident.opened', '2026-11-17T06:00:00.000Z', { event: 'opened', incidentId: id, detector: 'dlq_growing', pipelineName: 'Payments' }).send();
    await deliver('flag.updated', '2026-11-17T06:00:01.000Z', { flagKey: 'pay-v3', env: 'production', action: `killed by nimbus incident ${id}: DLQ`, actor: 'nimbus (automation)' }).send();
    await deliver('flag.updated', '2026-11-17T06:03:00.000Z', { flagKey: 'pay-v3', env: 'production', action: 'turned on', actor: 'ana@acme.com' }).send();
    await deliver('flag.updated', '2026-11-17T06:04:00.000Z', { flagKey: 'unrelated', env: 'production', action: 'turned on', actor: 'ana@acme.com' }).send();
    await deliver('incident.recovered', '2026-11-17T06:10:00.000Z', { event: 'recovered', incidentId: id }).send();

    const { timeline } = JSON.parse((await get(`/incidents/${id}`, id)).body!);
    expect(timeline.map((t: { type: string }) => t.type)).toEqual(['incident.opened', 'flag.killed', 'flag.manual', 'incident.recovered']);
    const md = (await get(`/incidents/${id}/postmortem`, id)).body!;
    expect(md).toContain('ana@acme.com changed the flag during the incident');
    expect(md).toContain('The flag is still off after recovery');
  });
});
