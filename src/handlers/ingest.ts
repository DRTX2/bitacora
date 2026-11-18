import { InvalidEvent, parseEvent } from '../domain/events.ts';
import { verify } from '../domain/signature.ts';
import { createStore, type Store } from '../infra/store.ts';
import { json, log, rawBody, type Event, type Result } from './http.ts';

/**
 * POST /webhooks/hookrelay/{sourceId}
 * Verify the Standard Webhooks signature, skip deliveries already processed, record the event.
 * Status codes are chosen for Hookrelay's retry policy: 2xx stops retries, anything else retries.
 */
export function ingest(store: Store, now = () => Date.now()) {
  return async (e: Event): Promise<Result> => {
    const sourceId = e.pathParameters?.sourceId ?? '';
    const source = await store.sourceSecret(sourceId);
    if (!source.found) return json(404, { error: 'unknown source' });
    // Created but not connected yet (secret not set): 409 makes Hookrelay retry instead of dropping the event.
    if (!source.secret) return json(409, { error: 'source has no signing secret yet' });

    const body = rawBody(e);
    const check = verify(source.secret, e.headers ?? {}, body, now());
    if (!check.ok) {
      log({ msg: 'rejected webhook', sourceId, reason: check.reason });
      return json(401, { error: check.reason });
    }
    if (await store.seenDelivery(check.id)) return json(200, { duplicate: true });

    let event;
    try {
      event = parseEvent(body);
    } catch (err) {
      if (err instanceof InvalidEvent) return json(400, { error: err.message });
      throw err;
    }

    const incidentId =
      event.kind === 'incident' ? await store.recordIncident(event, check.id)
      : event.kind === 'flag' ? await store.recordFlag(event, check.id)
      : null;
    await store.markDelivery(check.id);
    log({ msg: 'recorded webhook', sourceId, webhookId: check.id, kind: event.kind, incidentId });
    return json(200, { incidentId });
  };
}

export const handler = ingest(createStore());
