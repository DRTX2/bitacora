import type { FlagEvent } from './events.ts';

/** Flagship's audit text when Nimbus kills a flag: "killed by nimbus incident <id>: <summary>". */
const KILL = /^killed by nimbus incident ([0-9A-Za-z-]{1,100})/;
export const AUTOMATION_ACTOR = 'nimbus (automation)';

export type FlagRole =
  | { role: 'mitigation'; incidentId: string } // automation turned the flag off for this incident
  | { role: 'restore' } //                       automation restored it (Flagship only does this if nobody touched it)
  | { role: 'manual' }; //                       anyone else changed it; matters if it happens during an incident

export function classifyFlag(e: FlagEvent): FlagRole {
  const kill = KILL.exec(e.action);
  if (kill?.[1] && e.actor === AUTOMATION_ACTOR) return { role: 'mitigation', incidentId: kill[1] };
  if (e.actor === AUTOMATION_ACTOR && e.action.startsWith('rolled back')) return { role: 'restore' };
  return { role: 'manual' };
}

export type Incident = {
  incidentId: string;
  summary?: string;
  detector?: string;
  severity?: string;
  pipelineName?: string;
  openedAt?: string;
  mitigatedAt?: string;
  recoveredAt?: string;
  restoredAt?: string;
  flags?: string[];
};

export type TimelineEntry = { at: string; type: string; actor: string; text: string };

export type Metrics = {
  status: 'open' | 'mitigated' | 'recovered';
  timeToMitigateMs?: number; //  opened  -> flag killed
  timeToRecoverMs?: number; //   opened  -> pipeline healthy again
  timeToRestoreMs?: number; //   recovered -> flag back on
};

const diff = (from?: string, to?: string) => (from && to ? Date.parse(to) - Date.parse(from) : undefined);

export function metrics(i: Incident): Metrics {
  return {
    status: i.recoveredAt ? 'recovered' : i.mitigatedAt ? 'mitigated' : 'open',
    timeToMitigateMs: diff(i.openedAt, i.mitigatedAt),
    timeToRecoverMs: diff(i.openedAt, i.recoveredAt),
    timeToRestoreMs: diff(i.recoveredAt, i.restoredAt),
  };
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

const utc = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC');

/** Deterministic postmortem draft: facts from the timeline, judgement left to the team. */
export function renderPostmortem(i: Incident, timeline: TimelineEntry[]): string {
  const m = metrics(i);
  const manual = timeline.filter((t) => t.type === 'flag.manual');
  const lines = [
    `# Postmortem: ${i.summary ?? `incident ${i.incidentId}`}`,
    '',
    `- **Incident:** ${i.incidentId}`,
    `- **Pipeline:** ${i.pipelineName ?? 'unknown'}`,
    `- **Detector:** ${i.detector ?? 'unknown'} · **Severity:** ${i.severity ?? 'unknown'}`,
    `- **Status:** ${m.status}`,
    `- **Impact window:** ${i.openedAt ? utc(i.openedAt) : '?'} → ${i.recoveredAt ? utc(i.recoveredAt) : 'ongoing'}`,
    '',
    '## Response',
    '',
    '| Step | Time |',
    '|---|---|',
    `| Opened → mitigated (flag off) | ${formatDuration(m.timeToMitigateMs)} |`,
    `| Opened → recovered | ${formatDuration(m.timeToRecoverMs)} |`,
    `| Recovered → flag restored | ${formatDuration(m.timeToRestoreMs)} |`,
    '',
    '## Timeline',
    '',
    '| Time | Event | Actor |',
    '|---|---|---|',
    ...timeline.map((t) => `| ${utc(t.at)} | ${t.text.replaceAll('|', '\\|')} | ${t.actor} |`),
    '',
    '## Observations',
    '',
  ];
  if (i.mitigatedAt) lines.push(`- Automation turned off ${(i.flags ?? []).join(', ') || 'the flag'} ${formatDuration(m.timeToMitigateMs)} after the incident opened.`);
  else lines.push('- No automatic mitigation was recorded. Check the response workflow.');
  for (const t of manual) lines.push(`- ${t.actor} changed the flag during the incident (${utc(t.at)}), so automation did not restore it.`);
  if (i.recoveredAt && i.mitigatedAt && !i.restoredAt) lines.push('- The flag is still off after recovery: confirm it is safe before turning it back on.');
  lines.push(
    '',
    '## Follow-ups',
    '',
    `- [ ] Root cause of \`${i.detector ?? 'the failure'}\` on ${i.pipelineName ?? 'the pipeline'}`,
    '- [ ] Were detection thresholds right? (degraded windows before opening)',
    '- [ ] Should anything else be behind a kill switch?',
    '',
  );
  return lines.join('\n');
}
