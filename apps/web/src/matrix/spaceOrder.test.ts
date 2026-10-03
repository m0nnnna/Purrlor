import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { moveSpace, orderBetween, ordersFor, sortSpaces, spreadOrders, SPACE_ORDER_EVENT } from './spaceOrder';

function space(roomId: string, name: string, order?: unknown): Room {
  return {
    roomId,
    name,
    getAccountData: (type: string) => (type === SPACE_ORDER_EVENT && order !== undefined ? { getContent: () => ({ order }) } : undefined),
  } as unknown as Room;
}

const between = (a: string | undefined, b: string | undefined) => {
  const found = orderBetween(a, b);
  expect(found).toBeDefined();
  if (a !== undefined) expect(found! > a).toBe(true);
  if (b !== undefined) expect(found! < b).toBe(true);
  expect(found).toMatch(/^[\x20-\x7e]{1,50}$/);
  return found!;
};

describe('orderBetween', () => {
  it('finds a string strictly between two, or before or after one', () => {
    between('a', 'c');
    between('a', 'b');
    between('a', 'a!');
    between('abc', 'abd');
    between(undefined, 'b');
    between('z', undefined);
    between(undefined, undefined);
    between('~~~', undefined);
  });

  it('keeps finding room when the same gap is split again and again', () => {
    let low = 'a';
    const high = 'b';
    for (let i = 0; i < 40; i++) low = between(low, high);
  });

  it('says so when there is none', () => {
    expect(orderBetween(undefined, ' ')).toBeUndefined();
    expect(orderBetween('b', 'a')).toBeUndefined();
    expect(orderBetween('a', 'a')).toBeUndefined();
  });
});

describe('spreadOrders', () => {
  it('gives strictly increasing, valid strings', () => {
    const orders = spreadOrders(200);
    expect(new Set(orders).size).toBe(200);
    for (let i = 1; i < orders.length; i++) expect(orders[i] > orders[i - 1]).toBe(true);
    for (const order of orders) expect(order).toMatch(/^[\x20-\x7e]{2}$/);
  });
});

describe('sortSpaces', () => {
  it('puts ordered Spaces first by their order, the rest by name, ignoring bad orders', () => {
    const sorted = sortSpaces([
      space('!b', 'Bees'),
      space('!z', 'Zoo', 'b'),
      space('!a', 'Ants'),
      space('!y', 'Yaks', 'a'),
      space('!x', 'Xylo', 42),
      space('!w', 'Wasps', 'é'),
    ]);
    expect(sorted.map((room) => room.name)).toEqual(['Yaks', 'Zoo', 'Ants', 'Bees', 'Wasps', 'Xylo']);
  });
});

describe('ordersFor', () => {
  it('writes only the moved one when it fits between its neighbours', () => {
    const writes = ordersFor([{ id: 'a', order: 'b' }, { id: 'moved', order: 'z' }, { id: 'c', order: 'c' }], 'moved');
    expect([...writes.keys()]).toEqual(['moved']);
    const order = writes.get('moved')!;
    expect(order > 'b' && order < 'c').toBe(true);
  });

  it('orders everyone the first time', () => {
    const writes = ordersFor([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'b');
    expect([...writes.keys()]).toEqual(['a', 'b', 'c']);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => writes.get(id)!);
    expect(a < b && b < c).toBe(true);
  });
});

describe('moveSpace', () => {
  it('saves the new order in room account data', async () => {
    const setRoomAccountData = vi.fn().mockResolvedValue({});
    const mx = { setRoomAccountData } as unknown as MatrixClient;
    const spaces = [space('!a', 'A', 'b'), space('!b', 'B', 'c'), space('!c', 'C', 'd')];
    await moveSpace(mx, spaces, '!c', 0);
    expect(setRoomAccountData).toHaveBeenCalledTimes(1);
    const [roomId, type, content] = setRoomAccountData.mock.calls[0];
    expect([roomId, type]).toEqual(['!c', SPACE_ORDER_EVENT]);
    expect(content.order < 'b').toBe(true);

    setRoomAccountData.mockClear();
    await moveSpace(mx, spaces, '!a', 1);
    expect(setRoomAccountData).not.toHaveBeenCalled();
  });
});
