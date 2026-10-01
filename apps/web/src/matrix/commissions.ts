import { Direction, MsgType, Method, type MatrixClient } from 'matrix-js-sdk';
import { createDirectMessage, findExistingDirectMessageRoomId } from './directMessages';
import { feedJoinVia } from './feed';
import { readLine, readMxc } from './profilePage';

/**
 * **Commissions** for artists, drawn by a `commissions` block on a profile page (profilePage.ts).
 * The three parts are state events in the artist's profile room, separate from the page so
 * flipping the status or moving a slot along doesn't rewrite the whole page (and its 64 KB):
 *
 * - `xyz.nekous.commission_status` `{ status: "open" | "waitlist" | "closed", note? }`
 * - `xyz.nekous.commission_prices` `{ types: [{ id, name, price, description?, example?, slots? }] }`
 * - `xyz.nekous.commission_queue` `{ stages: ["Waiting", "Sketch", …], slots: [{ id, title, stage, client? }] }`
 *
 * Only the artist can write them (their profile room's state), and every reader checks them with
 * the parsers here, which keep only what they recognise, like the page's own parser. **A client's
 * name** shows only if they agree: the artist names a client (`client`, a user ID), and the client
 * agrees with a `xyz.nekous.commission_consent` event of their own in the profile room, which the
 * artist can't write for them. Without one the slot says "Client". **Requests** are an encrypted
 * DM to the artist. Purrlor takes no payments: the artist links their own Ko-fi or PayPal.
 */
export const COMMISSION_STATUS_EVENT = 'xyz.nekous.commission_status';
export const COMMISSION_PRICES_EVENT = 'xyz.nekous.commission_prices';
export const COMMISSION_QUEUE_EVENT = 'xyz.nekous.commission_queue';
export const COMMISSION_CONSENT_EVENT = 'xyz.nekous.commission_consent';

export const COMMISSION_STATUSES = ['open', 'waitlist', 'closed'] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export const COMMISSION_STATUS_LABELS: Record<CommissionStatus, string> = { open: 'Open', waitlist: 'Waitlist', closed: 'Closed' };

export const COMMISSION_LIMITS = {
  types: 12,
  slots: 40,
  stages: 8,
  name: 60,
  price: 24,
  description: 300,
  note: 200,
  slotTitle: 100,
  stage: 20,
  slotCount: 99,
  request: 2000,
} as const;

export const DEFAULT_STAGES = ['Waiting', 'Sketch', 'Colour', 'Done'];

export type CommissionState = { status: CommissionStatus; note?: string };
export type CommissionType = {
  id: string;
  name: string;
  /** As the artist writes it: "$25", "from £10", "2 for 1". Not a number: Purrlor takes no payments. */
  price: string;
  description?: string;
  example?: string;
  /** "2 of 5 open". */
  slots?: { open: number; total: number };
};
export type QueueSlot = { id: string; title: string; /** Index into `stages`. */ stage: number; client?: string };
export type CommissionQueue = { stages: string[]; slots: QueueSlot[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ID = /^[A-Za-z0-9_-]{1,16}$/;
const USER_ID = /^@[a-z0-9._=\-/+]{1,200}:[A-Za-z0-9.\-:[\]]{1,200}$/;

function readCount(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : undefined;
}

export function parseCommissionState(raw: unknown): CommissionState | undefined {
  if (!isRecord(raw) || !COMMISSION_STATUSES.includes(raw.status as CommissionStatus)) return undefined;
  const note = readLine(raw.note, COMMISSION_LIMITS.note);
  return { status: raw.status as CommissionStatus, ...(note && { note }) };
}

export function parseCommissionPrices(raw: unknown): CommissionType[] {
  if (!isRecord(raw) || !Array.isArray(raw.types)) return [];
  const seen = new Set<string>();
  const types: CommissionType[] = [];
  for (const [index, item] of raw.types.entries()) {
    if (types.length >= COMMISSION_LIMITS.types) break;
    if (!isRecord(item)) continue;
    const name = readLine(item.name, COMMISSION_LIMITS.name);
    const price = readLine(item.price, COMMISSION_LIMITS.price);
    if (!name || !price) continue;
    let id = typeof item.id === 'string' && ID.test(item.id) ? item.id : `t${index}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const description = readLine(item.description, COMMISSION_LIMITS.description);
    const example = readMxc(item.example);
    const total = isRecord(item.slots) ? readCount(item.slots.total, COMMISSION_LIMITS.slotCount) : undefined;
    const open = isRecord(item.slots) ? readCount(item.slots.open, COMMISSION_LIMITS.slotCount) : undefined;
    types.push({
      id,
      name,
      price,
      ...(description && { description }),
      ...(example && { example }),
      ...(total !== undefined && open !== undefined && total > 0 && { slots: { total, open: Math.min(open, total) } }),
    });
  }
  return types;
}

export function parseCommissionQueue(raw: unknown): CommissionQueue {
  const empty: CommissionQueue = { stages: DEFAULT_STAGES, slots: [] };
  if (!isRecord(raw)) return empty;
  const stages = (Array.isArray(raw.stages) ? raw.stages : [])
    .map((stage) => readLine(stage, COMMISSION_LIMITS.stage))
    .filter((stage): stage is string => !!stage)
    .slice(0, COMMISSION_LIMITS.stages);
  const useStages = stages.length > 0 ? stages : DEFAULT_STAGES;
  const seen = new Set<string>();
  const slots: QueueSlot[] = [];
  for (const [index, item] of (Array.isArray(raw.slots) ? raw.slots : []).entries()) {
    if (slots.length >= COMMISSION_LIMITS.slots) break;
    if (!isRecord(item)) continue;
    const title = readLine(item.title, COMMISSION_LIMITS.slotTitle);
    if (!title) continue;
    let id = typeof item.id === 'string' && ID.test(item.id) ? item.id : `s${index}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const stage = typeof item.stage === 'number' && Number.isFinite(item.stage) ? Math.min(useStages.length - 1, Math.max(0, Math.round(item.stage))) : 0;
    const client = typeof item.client === 'string' && item.client.length <= 255 && USER_ID.test(item.client) ? item.client : undefined;
    slots.push({ id, title, stage, ...(client && { client }) });
  }
  return { stages: useStages, slots };
}

// --- Reading and writing --------------------------------------------------------------------------

export type Commissions = { state?: CommissionState; types: CommissionType[]; queue: CommissionQueue };

type RawState = { type?: string; state_key?: string; content?: unknown };

export function commissionsFromState(events: RawState[]): Commissions {
  const content = (type: string) => events.find((event) => event.type === type && event.state_key === '')?.content;
  return {
    state: parseCommissionState(content(COMMISSION_STATUS_EVENT)),
    types: parseCommissionPrices(content(COMMISSION_PRICES_EVENT)),
    queue: parseCommissionQueue(content(COMMISSION_QUEUE_EVENT)),
  };
}

/** A profile room's commissions: from synced state when this client is in it, else one read of its state. */
export async function readCommissions(mx: MatrixClient, roomId: string): Promise<Commissions> {
  const room = mx.getRoom(roomId);
  if (room?.getMyMembership() === 'join') {
    const get = (type: string) => room.currentState.getStateEvents(type, '')?.getContent();
    return {
      state: parseCommissionState(get(COMMISSION_STATUS_EVENT)),
      types: parseCommissionPrices(get(COMMISSION_PRICES_EVENT)),
      queue: parseCommissionQueue(get(COMMISSION_QUEUE_EVENT)),
    };
  }
  try {
    return commissionsFromState((await mx.roomState(roomId)) as RawState[]);
  } catch {
    return { types: [], queue: parseCommissionQueue(undefined) };
  }
}

export async function setCommissionStatus(mx: MatrixClient, roomId: string, state: CommissionState): Promise<void> {
  const clean = parseCommissionState(state);
  if (!clean) throw new Error('That isn’t a status.');
  await mx.sendStateEvent(roomId, COMMISSION_STATUS_EVENT as any, { ...clean, updated_ts: Date.now() } as any, '');
}

export async function setCommissionPrices(mx: MatrixClient, roomId: string, types: CommissionType[]): Promise<void> {
  const clean = parseCommissionPrices({ types });
  await mx.sendStateEvent(roomId, COMMISSION_PRICES_EVENT as any, { types: clean } as any, '');
}

export async function setCommissionQueue(mx: MatrixClient, roomId: string, queue: CommissionQueue): Promise<void> {
  const clean = parseCommissionQueue(queue);
  await mx.sendStateEvent(roomId, COMMISSION_QUEUE_EVENT as any, clean as any, '');
}

// --- Client consent -------------------------------------------------------------------------------

type RawEvent = { type?: string; sender?: string; content?: { slot_id?: unknown; title?: unknown; agree?: unknown } };

/**
 * What a consent is to: one slot as it's titled now. A client agrees to be named on "Sketch for
 * @me"; if the artist later retitles the slot, or reuses its ID for another piece, the old
 * agreement doesn't carry over, and the client is asked again.
 */
export function consentKey(slotId: string, title: string): string {
  return `${slotId}\n${title}`;
}

/**
 * Who has agreed to be named, as `consentKey → user IDs`, from consent events newest first (so a
 * person's latest word on a slot wins). A consent counts only from the sender it names: the
 * artist can't agree for a client.
 */
export function readConsents(eventsNewestFirst: RawEvent[]): Map<string, Set<string>> {
  const decided = new Set<string>();
  const agreed = new Map<string, Set<string>>();
  for (const event of eventsNewestFirst) {
    const slot = event.content?.slot_id;
    const title = event.content?.title;
    if (event.type !== COMMISSION_CONSENT_EVENT || typeof slot !== 'string' || typeof title !== 'string' || !event.sender) continue;
    const key = consentKey(slot, title);
    const decision = `${event.sender}\n${key}`;
    if (decided.has(decision)) continue;
    decided.add(decision);
    if (event.content?.agree === true) agreed.set(key, (agreed.get(key) ?? new Set()).add(event.sender));
  }
  return agreed;
}

/** Whether `userId` agreed to be named on this slot as it's titled now. */
export function hasConsented(consents: Map<string, Set<string>>, slot: QueueSlot, userId: string): boolean {
  return consents.get(consentKey(slot.id, slot.title))?.has(userId) ?? false;
}

/** What a slot's client is called to this viewer: their ID if they agreed (or it's you, or you're the artist), else "Client". */
export function slotClientName(
  slot: QueueSlot,
  consents: Map<string, Set<string>>,
  viewer: { userId?: string; isArtist: boolean }
): { name: string; named: boolean; mine: boolean } {
  const client = slot.client;
  if (!client) return { name: 'Client', named: false, mine: false };
  const mine = !!viewer.userId && viewer.userId === client;
  if (hasConsented(consents, slot, client)) return { name: client, named: true, mine };
  // The artist knows who they put there, and you know it's you: neither is shown to anyone else.
  return { name: viewer.isArtist || mine ? client : 'Client', named: false, mine };
}

export async function fetchConsents(mx: MatrixClient, roomId: string): Promise<Map<string, Set<string>>> {
  try {
    const res = await mx.http.authedRequest<{ chunk?: RawEvent[] }>(Method.Get, `/rooms/${encodeURIComponent(roomId)}/messages`, {
      dir: Direction.Backward,
      limit: '100',
      filter: JSON.stringify({ types: [COMMISSION_CONSENT_EVENT] }),
    });
    return readConsents(res.chunk ?? []);
  } catch {
    return new Map();
  }
}

/** Agree (or stop agreeing) to be named on a queue slot, as titled now. Joins the artist's profile room if needed. */
export async function setCommissionConsent(mx: MatrixClient, roomId: string, ownerId: string, slot: QueueSlot, agree: boolean): Promise<void> {
  if (mx.getRoom(roomId)?.getMyMembership() !== 'join') {
    await mx.joinRoom(roomId, { viaServers: feedJoinVia(roomId, ownerId) });
  }
  await mx.sendEvent(roomId, COMMISSION_CONSENT_EVENT as any, { slot_id: slot.id, title: slot.title, agree } as any);
}

// --- Requests -------------------------------------------------------------------------------------

export type CommissionRequest = { typeName?: string; description: string; references?: string; budget?: string };

/** The message an artist receives: the filled-in form, as plain lines. */
export function requestMessageBody(request: CommissionRequest): string {
  return [
    'Commission request',
    request.typeName ? `Type: ${request.typeName}` : undefined,
    request.budget?.trim() ? `Budget: ${request.budget.trim()}` : undefined,
    `Description: ${request.description.trim()}`,
    request.references?.trim() ? `References: ${request.references.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Sends a request to the artist in an end-to-end encrypted DM, started if you don't have one.
 * Purrlor takes no payments: the artist replies there and links their own Ko-fi or PayPal.
 */
export async function sendCommissionRequest(mx: MatrixClient, artistId: string, request: CommissionRequest): Promise<string> {
  const description = request.description.trim();
  if (!description) throw new Error('Describe what you’d like.');
  if (description.length > COMMISSION_LIMITS.request) throw new Error(`Keep the description under ${COMMISSION_LIMITS.request} characters.`);
  const roomId = findExistingDirectMessageRoomId(mx, artistId) ?? (await createDirectMessage(mx, artistId));
  await mx.sendMessage(roomId, { msgtype: MsgType.Text, body: requestMessageBody({ ...request, description }) });
  return roomId;
}
