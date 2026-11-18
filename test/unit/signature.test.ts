import { describe, expect, it } from 'vitest';
import { sign, verify } from '../../src/domain/signature.ts';

// Official test vector from the Standard Webhooks spec (also used by Hookrelay's signer tests).
const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const ts = 1614265330;
const body = '{"test": 2432232314}';
const at = ts * 1000;
const headers = (signature: string, timestamp = ts) => ({ 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature });

describe('Standard Webhooks signature', () => {
  it('matches the spec test vector', () => {
    expect(sign(secret, id, ts, body)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('accepts a valid signature, including one of several during key rotation', () => {
    expect(verify(secret, headers(sign(secret, id, ts, body)), body, at)).toEqual({ ok: true, id });
    expect(verify(secret, headers(`v1,b2xkLXNlY3JldA== ${sign(secret, id, ts, body)}`), body, at).ok).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and missing headers', () => {
    expect(verify(secret, headers(sign(secret, id, ts, body)), '{"test": 1}', at)).toEqual({ ok: false, reason: 'bad signature' });
    expect(verify('whsec_b3RoZXItc2VjcmV0LXRoYXQtaXMtbG9uZw==', headers(sign(secret, id, ts, body)), body, at).ok).toBe(false);
    expect(verify(secret, { 'webhook-id': id }, body, at)).toEqual({ ok: false, reason: 'missing headers' });
  });

  it('rejects replays outside the 5 minute window', () => {
    const signature = sign(secret, id, ts, body);
    expect(verify(secret, headers(signature), body, at + 299_000).ok).toBe(true);
    expect(verify(secret, headers(signature), body, at + 301_000)).toEqual({ ok: false, reason: 'stale timestamp' });
  });
});
