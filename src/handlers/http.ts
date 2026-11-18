import { timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export type Event = APIGatewayProxyEventV2;
export type Result = APIGatewayProxyStructuredResultV2;

export const json = (statusCode: number, body: unknown): Result => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const text = (statusCode: number, body: string, contentType = 'text/plain; charset=utf-8'): Result => ({
  statusCode,
  headers: { 'content-type': contentType },
  body,
});

/** The exact bytes that were signed: API Gateway may base64-encode the body. */
export const rawBody = (e: Event) => (e.isBase64Encoded && e.body ? Buffer.from(e.body, 'base64').toString('utf8') : (e.body ?? ''));

/** Bearer token for the read and admin APIs (ingest is authenticated by the webhook signature instead). */
export function authorized(e: Event, token = process.env.BITACORA_TOKEN): boolean {
  const header = e.headers?.authorization ?? '';
  if (!token || !header.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** One JSON line per request: CloudWatch Logs Insights can query it as-is. */
export const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
