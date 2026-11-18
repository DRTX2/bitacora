import { metrics, renderPostmortem } from '../domain/incident.ts';
import { createStore, type Store } from '../infra/store.ts';
import { authorized, json, text, type Event, type Result } from './http.ts';

/** GET /incidents · GET /incidents/{incidentId} · GET /incidents/{incidentId}/postmortem */
export function query(store: Store) {
  return async (e: Event): Promise<Result> => {
    if (!authorized(e)) return json(401, { error: 'missing or invalid token' });
    const id = e.pathParameters?.incidentId;

    if (!id) {
      const limit = Math.min(100, Math.max(1, Number(e.queryStringParameters?.limit ?? 20) || 20));
      const incidents = await store.listIncidents(limit);
      return json(200, { items: incidents.map((i) => ({ ...i, ...metrics(i) })) });
    }

    const found = await store.getIncident(id);
    if (!found) return json(404, { error: 'unknown incident' });
    if (e.rawPath.endsWith('/postmortem')) return text(200, renderPostmortem(found.incident, found.timeline), 'text/markdown; charset=utf-8');
    return json(200, { incident: found.incident, metrics: metrics(found.incident), timeline: found.timeline });
  };
}

export const handler = query(createStore());
