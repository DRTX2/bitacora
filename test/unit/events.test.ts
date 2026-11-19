import { describe, expect, it } from 'vitest';
import { InvalidEvent, parseEvent } from '../../src/domain/events.ts';

const envelope = (type: string, data: object, timestamp = '2026-11-17T05:32:33.000Z') => JSON.stringify({ type, timestamp, data });

describe('parseEvent', () => {
  it('reads a Nimbus incident relayed by Hookrelay', () => {
    const e = parseEvent(envelope('incident.opened', { event: 'opened', incidentId: 'inc-1', summary: 'Queue backlog is aging', detector: 'consumer_stalled', severity: 'critical', pipelineName: 'Orders', extra: true }));
    expect(e).toEqual({ kind: 'incident', event: 'opened', incidentId: 'inc-1', at: '2026-11-17T05:32:33.000Z', summary: 'Queue backlog is aging', detector: 'consumer_stalled', severity: 'critical', pipelineName: 'Orders' });
  });

  it('uses the time the incident transition happened, not when it was delivered', () => {
    const e = parseEvent(envelope('incident.opened', { event: 'opened', incidentId: 'inc-1', occurredAt: '2026-11-17T05:32:30.100Z' }));
    expect(e).toMatchObject({ at: '2026-11-17T05:32:30.100Z' });
  });

  it('normalizes timestamps so they sort correctly as text', () => {
    const go = parseEvent(envelope('incident.opened', { event: 'opened', incidentId: 'a', occurredAt: '2026-11-17T05:32:30.1Z' }));
    const micro = parseEvent(envelope('incident.recovered', { event: 'recovered', incidentId: 'a', occurredAt: '2026-11-17T05:32:30.123456Z' }));
    expect([go.kind === 'incident' && go.at, micro.kind === 'incident' && micro.at]).toEqual(['2026-11-17T05:32:30.100Z', '2026-11-17T05:32:30.123Z']);
  });

  it('reads a Flagship flag change and prefers its own timestamp', () => {
    const e = parseEvent(envelope('flag.updated', { type: 'flag.updated', flagKey: 'orders-v2', env: 'production', version: 4, action: 'killed by nimbus incident inc-1: x', actor: 'nimbus (automation)', at: '2026-11-17T05:32:33.600Z' }));
    expect(e).toMatchObject({ kind: 'flag', flagKey: 'orders-v2', env: 'production', at: '2026-11-17T05:32:33.600Z' });
  });

  it('reads an escalation with the reason automation gave up', () => {
    const e = parseEvent(envelope('incident.escalated', { event: 'escalated', incidentId: 'inc-1', reason: 'POST flagship: 503', occurredAt: '2026-11-17T05:34:00.000Z' }));
    expect(e).toMatchObject({ kind: 'incident', event: 'escalated', incidentId: 'inc-1', reason: 'POST flagship: 503', at: '2026-11-17T05:34:00.000Z' });
  });

  it('acknowledges event types it does not use', () => {
    expect(parseEvent(envelope('order.created', { id: 1 }))).toEqual({ kind: 'ignored', type: 'order.created' });
  });

  it('rejects malformed bodies', () => {
    expect(() => parseEvent('not json')).toThrow(InvalidEvent);
    expect(() => parseEvent(JSON.stringify({ type: 'incident.opened' }))).toThrow(InvalidEvent);
    expect(() => parseEvent(envelope('incident.opened', { event: 'exploded', incidentId: 'x' }))).toThrow(InvalidEvent);
  });
});
