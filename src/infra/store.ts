import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { classifyFlag, type Incident, type TimelineEntry } from '../domain/incident.ts';
import type { FlagEvent, IncidentEvent } from '../domain/events.ts';

/*
 * Single table. Every write is idempotent (keys include the webhook id, timestamps use
 * if_not_exists), so Hookrelay's at-least-once retries can never duplicate or reorder state.
 *
 *   pk                    sk                        what
 *   SOURCE#<id>           META                      webhook source: name, signing secret
 *   DELIVERY#<webhookId>  META                      seen-before marker (TTL 7 days)
 *   INCIDENT#<id>         META                      incident + response timestamps   (GSI1: INCIDENTS / openedAt)
 *   INCIDENT#<id>         EVENT#<at>#<webhookId>    timeline entry
 *   FLAG#<key>#<env>      EVENT#<at>#<webhookId>    every change of the flag (links follow-ups to their kill)
 */
const DELIVERY_TTL_SECONDS = 7 * 24 * 3600;

type FlagChange = { at: string; actor: string; action: string; role: 'mitigation' | 'restore' | 'manual'; webhookId: string };

// DynamoDB string sets come back as a Set; the API returns a sorted array.
const flagList = (flags: unknown) => (flags instanceof Set ? [...(flags as Set<string>)].sort() : []);

export function createStore(table = process.env.TABLE_NAME ?? 'bitacora', endpoint = process.env.DYNAMODB_ENDPOINT) {
  const raw = new DynamoDBClient(endpoint ? { endpoint, region: process.env.AWS_REGION ?? 'us-east-1' } : {});
  const db = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });

  const event = (incidentId: string, webhookId: string, entry: TimelineEntry) =>
    db.send(new PutCommand({ TableName: table, Item: { pk: `INCIDENT#${incidentId}`, sk: `EVENT#${entry.at}#${webhookId}`, ...entry } }));

  const incidentMeta = async (incidentId: string) =>
    (await db.send(new GetCommand({ TableName: table, Key: { pk: `INCIDENT#${incidentId}`, sk: 'META' } }))).Item as (Incident & Record<string, unknown>) | undefined;

  /** Apply a restore or a manual change to the incident whose kill it follows. Idempotent. */
  const follow = async (incidentId: string, flag: string, h: FlagChange): Promise<string | null> => {
    if (h.role === 'restore') {
      await db.send(new UpdateCommand({
        TableName: table, Key: { pk: `INCIDENT#${incidentId}`, sk: 'META' },
        UpdateExpression: 'SET restoredAt = if_not_exists(restoredAt, :at)',
        ExpressionAttributeValues: { ':at': h.at },
      }));
      await event(incidentId, h.webhookId, { at: h.at, type: 'flag.restored', actor: h.actor, text: `${flag} restored to its pre-incident configuration` });
      return incidentId;
    }
    // A person changed the killed flag before it was restored: it explains a skipped restore.
    const incident = await incidentMeta(incidentId);
    if (!incident || (incident.restoredAt && incident.restoredAt <= h.at)) return null;
    await event(incidentId, h.webhookId, { at: h.at, type: 'flag.manual', actor: h.actor, text: `${flag}: ${h.action}` });
    return incidentId;
  };

  return {
    async createSource(name: string) {
      const id = randomUUID();
      await db.send(new PutCommand({ TableName: table, Item: { pk: `SOURCE#${id}`, sk: 'META', name, createdAt: new Date().toISOString() } }));
      return id;
    },

    /** Returns false when the source doesn't exist. */
    async setSourceSecret(id: string, secret: string) {
      try {
        await db.send(new UpdateCommand({
          TableName: table, Key: { pk: `SOURCE#${id}`, sk: 'META' },
          UpdateExpression: 'SET secret = :s, secretUpdatedAt = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':s': secret, ':now': new Date().toISOString() },
        }));
        return true;
      } catch (e) {
        if ((e as Error).name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    },

    async sourceSecret(id: string) {
      const item = (await db.send(new GetCommand({ TableName: table, Key: { pk: `SOURCE#${id}`, sk: 'META' } }))).Item;
      return item ? { found: true as const, secret: item.secret as string | undefined } : { found: false as const };
    },

    async seenDelivery(webhookId: string) {
      return Boolean((await db.send(new GetCommand({ TableName: table, Key: { pk: `DELIVERY#${webhookId}`, sk: 'META' } }))).Item);
    },

    // Marked after processing, not before: a crash in between means a retry reprocesses (harmless), never a loss.
    async markDelivery(webhookId: string) {
      await db.send(new PutCommand({ TableName: table, Item: { pk: `DELIVERY#${webhookId}`, sk: 'META', ttl: Math.floor(Date.now() / 1000) + DELIVERY_TTL_SECONDS } }));
    },

    async recordIncident(e: IncidentEvent, webhookId: string) {
      const opened = e.event === 'opened';
      await db.send(new UpdateCommand({
        TableName: table, Key: { pk: `INCIDENT#${e.incidentId}`, sk: 'META' },
        UpdateExpression: opened
          ? 'SET incidentId = :id, openedAt = if_not_exists(openedAt, :at), gsi1pk = :g, gsi1sk = if_not_exists(gsi1sk, :at), summary = if_not_exists(summary, :summary), detector = if_not_exists(detector, :detector), severity = if_not_exists(severity, :severity), pipelineName = if_not_exists(pipelineName, :pipeline)'
          : e.event === 'escalated' ? 'SET incidentId = :id, escalatedAt = if_not_exists(escalatedAt, :at)' : 'SET incidentId = :id, recoveredAt = if_not_exists(recoveredAt, :at)',
        ExpressionAttributeValues: opened
          ? { ':id': e.incidentId, ':at': e.at, ':g': 'INCIDENTS', ':summary': e.summary ?? null, ':detector': e.detector ?? null, ':severity': e.severity ?? null, ':pipeline': e.pipelineName ?? null }
          : { ':id': e.incidentId, ':at': e.at },
      }));
      await event(e.incidentId, webhookId, {
        at: e.at, type: `incident.${e.event}`, actor: 'nimbus',
        text: opened ? `Incident opened: ${e.summary ?? e.detector ?? 'pipeline degraded'}`
          : e.event === 'escalated' ? `Automatic mitigation failed: escalated to on-call${e.reason ? ` (${e.reason.slice(0, 200)})` : ''}`
          : 'Pipeline healthy again: incident recovered',
      });
      return e.incidentId;
    },

    /**
     * Returns the incident the flag change belongs to, or null if it isn't (or isn't yet) linked to one.
     * Every change is kept in the flag's own history, so a restore or manual change that arrives before
     * the kill it follows (deliveries come in any order after a DLQ replay) is linked when the kill shows up.
     */
    async recordFlag(e: FlagEvent, webhookId: string): Promise<string | null> {
      const flag = `${e.flagKey}@${e.env}`;
      const historyPk = `FLAG#${e.flagKey}#${e.env}`;
      const sk = `EVENT#${e.at}#${webhookId}`;
      const role = classifyFlag(e);
      const change: FlagChange = { at: e.at, actor: e.actor, action: e.action, role: role.role, webhookId };
      await db.send(new PutCommand({
        TableName: table,
        Item: { pk: historyPk, sk, ...change, ...(role.role === 'mitigation' ? { incidentId: role.incidentId } : {}) },
      }));

      if (role.role === 'mitigation') {
        await db.send(new UpdateCommand({
          TableName: table, Key: { pk: `INCIDENT#${role.incidentId}`, sk: 'META' },
          UpdateExpression: 'SET incidentId = :id, mitigatedAt = if_not_exists(mitigatedAt, :at) ADD flags :f',
          ExpressionAttributeValues: { ':id': role.incidentId, ':at': e.at, ':f': new Set([flag]) },
        }));
        await event(role.incidentId, webhookId, { at: e.at, type: 'flag.killed', actor: e.actor, text: `${flag} turned off (kill switch)` });
        // Adopt follow-ups that arrived first: later changes of this flag, up to the next kill.
        const { Items: later = [] } = await db.send(new QueryCommand({
          TableName: table, KeyConditionExpression: 'pk = :pk AND sk > :sk',
          ExpressionAttributeValues: { ':pk': historyPk, ':sk': sk },
        }));
        for (const h of later as FlagChange[]) {
          if (h.role === 'mitigation') break;
          await follow(role.incidentId, flag, h);
        }
        return role.incidentId;
      }

      // Which kill does this follow? The latest one at or before this change, if it has arrived.
      const { Items: earlier = [] } = await db.send(new QueryCommand({
        TableName: table, KeyConditionExpression: 'pk = :pk AND sk < :sk',
        ExpressionAttributeValues: { ':pk': historyPk, ':sk': sk }, ScanIndexForward: false,
      }));
      const kill = earlier.find((h) => h.role === 'mitigation');
      return kill ? follow(kill.incidentId as string, flag, change) : null;
    },

    async getIncident(incidentId: string) {
      const meta = await incidentMeta(incidentId);
      if (!meta) return undefined;
      const { Items = [] } = await db.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `INCIDENT#${incidentId}`, ':prefix': 'EVENT#' },
      }));
      const { pk, sk, gsi1pk, gsi1sk, flags, ...incident } = meta;
      const timeline = Items.map(({ at, type, actor, text }) => ({ at, type, actor, text }) as TimelineEntry);
      return { incident: { ...incident, flags: flagList(flags) } as Incident, timeline };
    },

    async listIncidents(limit: number) {
      const { Items = [] } = await db.send(new QueryCommand({
        TableName: table, IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :g', ExpressionAttributeValues: { ':g': 'INCIDENTS' },
        ScanIndexForward: false, Limit: limit,
      }));
      return Items.map(({ pk, sk, gsi1pk, gsi1sk, flags, ...incident }) => ({ ...incident, flags: flagList(flags) }) as Incident);
    },

    /** Local development and tests only. In AWS the table comes from Terraform. */
    async ensureTable() {
      try {
        await raw.send(new CreateTableCommand({
          TableName: table, BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' },
            { AttributeName: 'gsi1pk', AttributeType: 'S' }, { AttributeName: 'gsi1sk', AttributeType: 'S' },
          ],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
          GlobalSecondaryIndexes: [{
            IndexName: 'gsi1', Projection: { ProjectionType: 'ALL' },
            KeySchema: [{ AttributeName: 'gsi1pk', KeyType: 'HASH' }, { AttributeName: 'gsi1sk', KeyType: 'RANGE' }],
          }],
        }));
      } catch (e) {
        if (!(e instanceof ResourceInUseException)) throw e;
      }
    },
  };
}

export type Store = ReturnType<typeof createStore>;
