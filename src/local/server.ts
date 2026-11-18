import { createServer } from 'node:http';
import type { Event, Result } from '../handlers/http.ts';
import { admin } from '../handlers/admin.ts';
import { ingest } from '../handlers/ingest.ts';
import { query } from '../handlers/query.ts';
import { createStore } from '../infra/store.ts';

/**
 * Local runtime: the same Lambda handlers behind a plain HTTP server, fed the API Gateway v2 event
 * shape they get in AWS. Routes mirror the HTTP API in infra/terraform/api.tf.
 */
const store = createStore();
const handlers = { ingest: ingest(store), query: query(store), admin: admin(store) };
const routes: [method: string, pattern: RegExp, handler: keyof typeof handlers, params: string[]][] = [
  ['POST', /^\/webhooks\/hookrelay\/([^/]+)$/, 'ingest', ['sourceId']],
  ['POST', /^\/sources$/, 'admin', []],
  ['PUT', /^\/sources\/([^/]+)\/secret$/, 'admin', ['sourceId']],
  ['GET', /^\/incidents$/, 'query', []],
  ['GET', /^\/incidents\/([^/]+)$/, 'query', ['incidentId']],
  ['GET', /^\/incidents\/([^/]+)\/postmortem$/, 'query', ['incidentId']],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname === '/health') return res.writeHead(200).end('ok');
  const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
  if (!route) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const match = route[1].exec(url.pathname)!;
  const event = {
    rawPath: url.pathname,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])),
    body: Buffer.concat(chunks).toString('utf8'),
    isBase64Encoded: false,
    pathParameters: Object.fromEntries(route[3].map((name, i) => [name, decodeURIComponent(match[i + 1]!)])),
    queryStringParameters: Object.fromEntries(url.searchParams),
    requestContext: { domainName: req.headers.host ?? 'localhost', http: { method: req.method, path: url.pathname } },
  } as unknown as Event;

  try {
    const result = (await handlers[route[2]](event)) as Result;
    res.writeHead(result.statusCode ?? 200, result.headers as Record<string, string>).end(result.body ?? '');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal"}');
  }
});

// DynamoDB Local may still be starting (compose starts both together): retry for up to 30 s.
for (let attempt = 1; ; attempt++) {
  try {
    await store.ensureTable();
    break;
  } catch (err) {
    if (attempt === 30) throw err;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const port = Number(process.env.PORT ?? 8090);
server.listen(port, () => console.log(`bitacora listening on :${port}`));
