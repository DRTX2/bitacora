import { createHmac, timingSafeEqual } from 'node:crypto';

// Standard Webhooks (https://www.standardwebhooks.com), as Hookrelay signs: HMAC-SHA256 over
// "<webhook-id>.<webhook-timestamp>.<raw body>", key = base64 part of "whsec_...",
// header = space-separated "v1,<base64 sig>" entries (several allow key rotation).
const PREFIX = 'whsec_';
export const TOLERANCE_SECONDS = 300;

export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export type SignatureCheck = { ok: true; id: string } | { ok: false; reason: 'missing headers' | 'stale timestamp' | 'bad signature' };

export function verify(
  secret: string,
  headers: Record<string, string | undefined>,
  body: string,
  now = Date.now(),
): SignatureCheck {
  const id = headers['webhook-id'];
  const timestamp = Number(headers['webhook-timestamp']);
  const signatures = headers['webhook-signature'];
  if (!id || !signatures || !Number.isFinite(timestamp)) return { ok: false, reason: 'missing headers' };
  // Replay protection: a captured request stops working after the tolerance window.
  if (Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return { ok: false, reason: 'stale timestamp' };
  const expected = Buffer.from(sign(secret, id, timestamp, body));
  const match = signatures.split(' ').some((candidate) => {
    const got = Buffer.from(candidate);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return match ? { ok: true, id } : { ok: false, reason: 'bad signature' };
}
