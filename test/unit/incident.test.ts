import { describe, expect, it } from 'vitest';
import type { FlagEvent } from '../../src/domain/events.ts';
import { classifyFlag, formatDuration, metrics, renderPostmortem, type Incident } from '../../src/domain/incident.ts';

const flag = (action: string, actor: string): FlagEvent => ({ kind: 'flag', type: 'flag.updated', flagKey: 'orders-v2', env: 'production', action, actor, at: '2026-11-17T05:32:34.000Z' });

describe('classifyFlag', () => {
  it('links an automation kill to its incident', () => {
    expect(classifyFlag(flag('killed by nimbus incident 5101-ab: Queue backlog', 'nimbus (automation)'))).toEqual({ role: 'mitigation', incidentId: '5101-ab' });
  });
  it('recognises the automatic restore', () => {
    expect(classifyFlag(flag('rolled back to #3', 'nimbus (automation)'))).toEqual({ role: 'restore' });
  });
  it('treats everything else, including a person pasting the kill text, as manual', () => {
    expect(classifyFlag(flag('killed by nimbus incident 5101-ab', 'ana'))).toEqual({ role: 'manual' });
    expect(classifyFlag(flag('turned off', 'ana'))).toEqual({ role: 'manual' });
  });
});

const incident: Incident = {
  incidentId: 'inc-1', summary: 'Queue backlog is aging', detector: 'consumer_stalled', severity: 'critical', pipelineName: 'Orders',
  openedAt: '2026-11-17T05:32:33.000Z', mitigatedAt: '2026-11-17T05:32:33.615Z', recoveredAt: '2026-11-17T05:42:33.000Z', restoredAt: '2026-11-17T05:42:34.200Z',
  flags: ['orders-v2@production'],
};

describe('metrics and postmortem', () => {
  it('computes response times', () => {
    expect(metrics(incident)).toEqual({ status: 'recovered', timeToMitigateMs: 615, timeToRecoverMs: 600_000, timeToRestoreMs: 1200 });
    expect(metrics({ incidentId: 'x', openedAt: incident.openedAt })).toMatchObject({ status: 'open', timeToMitigateMs: undefined });
  });

  it('says a human had to act when automation could not mitigate', () => {
    const escalated = { incidentId: 'inc-2', openedAt: incident.openedAt, escalatedAt: '2026-11-17T05:34:03.000Z', flags: [] };
    expect(renderPostmortem(escalated, [])).toContain('Automatic mitigation failed and the incident was escalated to on-call 1 min 30 s after it opened');
  });

  it('formats durations for people', () => {
    expect([formatDuration(615), formatDuration(1200), formatDuration(600_000), formatDuration(undefined)]).toEqual(['615 ms', '1.2 s', '10 min 0 s', '—']);
  });

  it('drafts a postmortem from the facts, flagging a manual change and an unrestored flag', () => {
    const md = renderPostmortem({ ...incident, restoredAt: undefined }, [
      { at: incident.openedAt!, type: 'incident.opened', actor: 'nimbus', text: 'Incident opened: Queue backlog is aging' },
      { at: '2026-11-17T05:35:00.000Z', type: 'flag.manual', actor: 'ana', text: 'orders-v2@production: turned on | testing' },
    ]);
    expect(md).toContain('# Postmortem: Queue backlog is aging');
    expect(md).toContain('| Opened → mitigated (flag off) | 615 ms |');
    expect(md).toContain('turned on \\| testing'); // table-safe
    expect(md).toContain('ana changed the flag during the incident');
    expect(md).toContain('The flag is still off after recovery');
  });
});
