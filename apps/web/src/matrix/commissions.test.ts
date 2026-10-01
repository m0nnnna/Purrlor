import { describe, expect, it, vi } from 'vitest';
import {
  COMMISSION_CONSENT_EVENT,
  COMMISSION_LIMITS,
  COMMISSION_PRICES_EVENT,
  COMMISSION_QUEUE_EVENT,
  COMMISSION_STATUS_EVENT,
  commissionsFromState,
  DEFAULT_STAGES,
  parseCommissionPrices,
  parseCommissionQueue,
  parseCommissionState,
  hasConsented,
  readConsents,
  requestMessageBody,
  sendCommissionRequest,
  slotClientName,
} from './commissions';

const MXC = 'mxc://purr.example.org/abcDEF123';

describe('parseCommissionState', () => {
  it('reads a status and its note, and nothing else', () => {
    expect(parseCommissionState({ status: 'open', note: ' 2 slots ', updated_ts: 5, html: '<b>' })).toEqual({ status: 'open', note: '2 slots' });
    expect(parseCommissionState({ status: 'waitlist' })).toEqual({ status: 'waitlist' });
  });

  it('is nothing for an unknown status', () => {
    expect(parseCommissionState({ status: 'very open' })).toBeUndefined();
    expect(parseCommissionState('open')).toBeUndefined();
    expect(parseCommissionState(null)).toBeUndefined();
    expect(parseCommissionState({})).toBeUndefined();
  });
});

describe('parseCommissionPrices', () => {
  it('keeps types with a name and a price, with clamped slots, and an example only if it is an mxc URL', () => {
    const types = parseCommissionPrices({
      types: [
        { id: 'a', name: 'Sketch', price: '$15', description: 'Pencil', example: MXC, slots: { open: 9, total: 5 } },
        { id: 'b', name: 'Ref sheet', price: 'from $60', example: 'https://evil.example/x.png', slots: { open: 2, total: 0 } },
        { id: 'c', name: 'No price' },
        { name: '', price: '$1' },
        'junk',
      ],
    });
    expect(types).toEqual([
      { id: 'a', name: 'Sketch', price: '$15', description: 'Pencil', example: MXC, slots: { open: 5, total: 5 } },
      { id: 'b', name: 'Ref sheet', price: 'from $60' },
    ]);
  });

  it('gives types with the same ID their own, and caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 'same', name: `T${i}`, price: '$1' }));
    const types = parseCommissionPrices({ types: many });
    expect(types).toHaveLength(COMMISSION_LIMITS.types);
    expect(new Set(types.map((type) => type.id)).size).toBe(types.length);
  });

  it('is empty for anything that is not a price sheet', () => {
    expect(parseCommissionPrices(undefined)).toEqual([]);
    expect(parseCommissionPrices({ types: 'lots' })).toEqual([]);
  });
});

describe('parseCommissionQueue', () => {
  it('keeps stages in order, and slots with a title, their stage clamped and a client only if it is a Matrix ID', () => {
    const queue = parseCommissionQueue({
      stages: ['Waiting', ' Sketch ', '', 'Done'],
      slots: [
        { id: 'one', title: 'Sketch for @nibbles', stage: 1, client: '@nibbles:purr.example' },
        { id: 'two', title: 'Flats', stage: 99, client: '<script>' },
        { id: 'three', title: '', stage: 0 },
        { id: 'four', title: 'Negative', stage: -3 },
      ],
    });
    expect(queue.stages).toEqual(['Waiting', 'Sketch', 'Done']);
    expect(queue.slots).toEqual([
      { id: 'one', title: 'Sketch for @nibbles', stage: 1, client: '@nibbles:purr.example' },
      { id: 'two', title: 'Flats', stage: 2 },
      { id: 'four', title: 'Negative', stage: 0 },
    ]);
  });

  it('falls back to the usual stages', () => {
    expect(parseCommissionQueue(undefined)).toEqual({ stages: DEFAULT_STAGES, slots: [] });
    expect(parseCommissionQueue({ stages: [], slots: [{ title: 'x', stage: 3 }] })).toEqual({
      stages: DEFAULT_STAGES,
      slots: [{ id: 's0', title: 'x', stage: 3 }],
    });
  });

  it('caps slots', () => {
    const slots = Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, title: `Slot ${i}`, stage: 0 }));
    expect(parseCommissionQueue({ slots }).slots).toHaveLength(COMMISSION_LIMITS.slots);
  });
});

describe('commissionsFromState', () => {
  it('reads the three events out of a room’s state', () => {
    const result = commissionsFromState([
      { type: COMMISSION_STATUS_EVENT, state_key: '', content: { status: 'closed' } },
      { type: COMMISSION_PRICES_EVENT, state_key: '', content: { types: [{ id: 'a', name: 'Sketch', price: '$5' }] } },
      { type: COMMISSION_QUEUE_EVENT, state_key: 'someone-else', content: { slots: [{ title: 'ignored' }] } },
    ]);
    expect(result.state).toEqual({ status: 'closed' });
    expect(result.types).toHaveLength(1);
    expect(result.queue.slots).toEqual([]);
  });
});

describe('who agreed to be named', () => {
  const artist = '@artist:s';
  const client = '@client:s';
  const slot = { id: 'one', title: 'Sketch', stage: 0, client };

  const consent = (sender: string, agree: boolean, title = 'Sketch') => ({ type: COMMISSION_CONSENT_EVENT, sender, content: { slot_id: 'one', title, agree } });

  it('counts a client’s own agreement, and the latest word wins', () => {
    const newestFirst = [consent(client, false), consent(client, true)];
    expect(hasConsented(readConsents(newestFirst), slot, client)).toBe(false);
    expect(hasConsented(readConsents([...newestFirst].reverse()), slot, client)).toBe(true);
  });

  it('never counts the artist (or anyone else) agreeing for the client', () => {
    const consents = readConsents([consent(artist, true)]);
    expect(slotClientName(slot, consents, { userId: '@visitor:s', isArtist: false })).toEqual({ name: 'Client', named: false, mine: false });
  });

  it('asks again when the artist retitles the slot', () => {
    const consents = readConsents([consent(client, true)]);
    expect(slotClientName({ ...slot, title: 'Something else entirely' }, consents, { userId: '@visitor:s', isArtist: false }).name).toBe('Client');
    // An agreement with no title (from before titles were recorded) doesn't count either.
    const untitled = readConsents([{ type: COMMISSION_CONSENT_EVENT, sender: client, content: { slot_id: 'one', agree: true } }]);
    expect(hasConsented(untitled, slot, client)).toBe(false);
  });

  it('shows the name once agreed, and keeps it from everyone but the artist and the client until then', () => {
    const none = new Map<string, Set<string>>();
    expect(slotClientName(slot, none, { userId: '@visitor:s', isArtist: false }).name).toBe('Client');
    expect(slotClientName(slot, none, { isArtist: false }).name).toBe('Client');
    expect(slotClientName(slot, none, { userId: artist, isArtist: true })).toEqual({ name: client, named: false, mine: false });
    expect(slotClientName(slot, none, { userId: client, isArtist: false })).toEqual({ name: client, named: false, mine: true });
    const agreed = readConsents([consent(client, true)]);
    expect(slotClientName(slot, agreed, { userId: '@visitor:s', isArtist: false })).toEqual({ name: client, named: true, mine: false });
  });

  it('shows a slot with no client as Client', () => {
    expect(slotClientName({ id: 'x', title: 't', stage: 0 }, new Map(), { isArtist: true }).name).toBe('Client');
  });
});

describe('requests', () => {
  it('writes the filled-in form as plain lines', () => {
    expect(requestMessageBody({ typeName: 'Sketch ($15)', description: ' a cat ', references: 'https://x.example', budget: '$20' })).toBe(
      'Commission request\nType: Sketch ($15)\nBudget: $20\nDescription: a cat\nReferences: https://x.example'
    );
    expect(requestMessageBody({ description: 'just this' })).toBe('Commission request\nDescription: just this');
  });

  it('goes to the artist in an existing DM, or a new encrypted one', async () => {
    const sendMessage = vi.fn(async () => ({}));
    const createRoom = vi.fn(async () => ({ room_id: '!new:s' }));
    const mx = {
      getUserId: () => '@me:s',
      getRooms: () => [],
      getAccountData: () => undefined,
      setAccountData: async () => ({}),
      createRoom,
      sendMessage,
    };
    const roomId = await sendCommissionRequest(mx as never, '@artist:s', { description: 'a cat' });
    expect(roomId).toBe('!new:s');
    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({ is_direct: true, invite: ['@artist:s'] }));
    expect(sendMessage).toHaveBeenCalledWith('!new:s', expect.objectContaining({ body: expect.stringContaining('Description: a cat') }));
  });

  it('refuses an empty or over-long description without opening a DM', async () => {
    const createRoom = vi.fn();
    const mx = { getUserId: () => '@me:s', getRooms: () => [], createRoom, sendMessage: vi.fn() };
    await expect(sendCommissionRequest(mx as never, '@artist:s', { description: '   ' })).rejects.toThrow();
    await expect(sendCommissionRequest(mx as never, '@artist:s', { description: 'x'.repeat(COMMISSION_LIMITS.request + 1) })).rejects.toThrow();
    expect(createRoom).not.toHaveBeenCalled();
  });
});
