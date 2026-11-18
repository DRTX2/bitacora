import { z } from 'zod';
import { createStore, type Store } from '../infra/store.ts';
import { authorized, json, log, rawBody, type Event, type Result } from './http.ts';

const NewSource = z.object({ name: z.string().trim().min(1).max(100) });
const Secret = z.object({ secret: z.string().regex(/^whsec_[A-Za-z0-9+/]{20,}={0,2}$/, 'expected a whsec_ signing secret') });

function body<T>(schema: z.ZodType<T>, e: Event): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(rawBody(e) || '{}'));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Connecting a webhook provider takes two calls, because each side issues one half:
 *   POST /sources              -> Bitácora issues the webhook URL
 *   PUT  /sources/{id}/secret  -> stores the signing secret Hookrelay issued for that URL
 */
export function admin(store: Store) {
  return async (e: Event): Promise<Result> => {
    if (!authorized(e)) return json(401, { error: 'missing or invalid token' });
    const sourceId = e.pathParameters?.sourceId;

    if (!sourceId) {
      const input = body(NewSource, e);
      if (!input) return json(400, { error: 'name is required' });
      const id = await store.createSource(input.name);
      const base = process.env.PUBLIC_BASE_URL ?? `https://${e.requestContext.domainName}`;
      log({ msg: 'source created', sourceId: id });
      return json(201, { id, webhookUrl: `${base}/webhooks/hookrelay/${id}` });
    }

    const input = body(Secret, e);
    if (!input) return json(400, { error: 'expected a whsec_ signing secret' });
    if (!(await store.setSourceSecret(sourceId, input.secret))) return json(404, { error: 'unknown source' });
    log({ msg: 'source secret set', sourceId });
    return { statusCode: 204 };
  };
}

export const handler = admin(createStore());
