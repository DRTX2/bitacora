import { z } from 'zod';

// Hookrelay delivers { type, timestamp, data }. `data` is the publisher's payload:
//  - incident.*  comes from Nimbus through Hookrelay's signed inbound endpoint
//  - flag.*      comes from Flagship's optional Hookrelay notifier
const Envelope = z.object({ type: z.string().min(1).max(100), timestamp: z.iso.datetime({ offset: true }), data: z.record(z.string(), z.unknown()) });

const Incident = z.looseObject({
  incidentId: z.string().min(1).max(100),
  event: z.enum(['opened', 'recovered']),
  summary: z.string().max(500).optional(),
  detector: z.string().max(100).optional(),
  severity: z.string().max(50).optional(),
  pipelineName: z.string().max(200).optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});

const Flag = z.looseObject({
  flagKey: z.string().min(1).max(200),
  env: z.string().max(100).optional(),
  version: z.number().int().optional(),
  action: z.string().max(1000),
  actor: z.string().max(200),
  at: z.iso.datetime({ offset: true }).optional(),
});

export type IncidentEvent = {
  kind: 'incident';
  event: 'opened' | 'recovered';
  incidentId: string;
  at: string;
  summary?: string;
  detector?: string;
  severity?: string;
  pipelineName?: string;
};
export type FlagEvent = { kind: 'flag'; type: string; flagKey: string; env: string; version?: number; action: string; actor: string; at: string };
export type DomainEvent = IncidentEvent | FlagEvent | { kind: 'ignored'; type: string };

export class InvalidEvent extends Error {}

// Timestamps become sort keys (timeline order, newest-first listing), which DynamoDB compares as
// text. Publishers differ in precision (Go trims trailing zeros, JS always writes 3 decimals), so
// "…30.1Z" would sort after "…30.123456Z". One fixed-width format fixes the order.
const normalize = (iso: string) => new Date(iso).toISOString();

export function parseEvent(rawBody: string): DomainEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new InvalidEvent('body is not JSON');
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) throw new InvalidEvent('not a Hookrelay envelope');
  const { type, timestamp, data } = envelope.data;

  if (type === 'incident.opened' || type === 'incident.recovered') {
    const parsed = Incident.safeParse(data);
    if (!parsed.success) throw new InvalidEvent(`invalid ${type} payload`);
    const d = parsed.data;
    // occurredAt (set by Nimbus) is when the transition happened; the envelope timestamp is when the
    // workflow step delivered it, which can be later than the flag kill that step sequence triggered.
    return { kind: 'incident', event: d.event, incidentId: d.incidentId, at: normalize(d.occurredAt ?? timestamp), summary: d.summary, detector: d.detector, severity: d.severity, pipelineName: d.pipelineName };
  }
  if (type.startsWith('flag.')) {
    const parsed = Flag.safeParse(data);
    if (!parsed.success) throw new InvalidEvent(`invalid ${type} payload`);
    const d = parsed.data;
    return { kind: 'flag', type, flagKey: d.flagKey, env: d.env ?? 'all', version: d.version, action: d.action, actor: d.actor, at: normalize(d.at ?? timestamp) };
  }
  // Subscribed to more than we use is fine: acknowledge so Hookrelay doesn't retry it.
  return { kind: 'ignored', type };
}
