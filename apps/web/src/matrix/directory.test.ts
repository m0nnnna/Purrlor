import { describe, expect, it, vi } from 'vitest';
import { RoomType, type IPublicRoomsChunkRoom, type MatrixClient } from 'matrix-js-sdk';
import { browsePublicSpaces, isSpaceEntry, joinPublicRoom } from './directory';

function fakeChunkRoom(overrides: Partial<IPublicRoomsChunkRoom> = {}): IPublicRoomsChunkRoom {
  return {
    room_id: '!room:example.org',
    world_readable: true,
    guest_can_join: false,
    num_joined_members: 3,
    ...overrides,
  };
}

describe('isSpaceEntry', () => {
  it('recognizes a public Space by its room_type', () => {
    expect(isSpaceEntry(fakeChunkRoom({ room_type: RoomType.Space }))).toBe(true);
  });

  it('treats a plain room (no room_type) as not a Space', () => {
    expect(isSpaceEntry(fakeChunkRoom())).toBe(false);
  });
});

describe('browsePublicSpaces', () => {
  it('asks the directory for Spaces only when no search term is given', async () => {
    const publicRooms = vi.fn().mockResolvedValue({ chunk: [] });
    const mx = { publicRooms } as unknown as MatrixClient;

    await browsePublicSpaces(mx, {});

    expect(publicRooms).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { room_types: [RoomType.Space] }, since: undefined })
    );
  });

  it("leaves out channels and anything else a server lists anyway, keeping the page's token", async () => {
    const space = fakeChunkRoom({ room_id: '!space:example.org', room_type: RoomType.Space });
    const publicRooms = vi.fn().mockResolvedValue({ chunk: [fakeChunkRoom(), space, fakeChunkRoom({ room_type: 'xyz.nekous.profile' })], next_batch: 'next' });
    const mx = { publicRooms } as unknown as MatrixClient;

    expect(await browsePublicSpaces(mx)).toEqual({ chunk: [space], next_batch: 'next' });
  });

  it('passes a trimmed search term as generic_search_term', async () => {
    const publicRooms = vi.fn().mockResolvedValue({ chunk: [] });
    const mx = { publicRooms } as unknown as MatrixClient;

    await browsePublicSpaces(mx, { searchTerm: '  music  ' });

    expect(publicRooms).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { room_types: [RoomType.Space], generic_search_term: 'music' } })
    );
  });

  it('forwards a pagination token as since', async () => {
    const publicRooms = vi.fn().mockResolvedValue({ chunk: [] });
    const mx = { publicRooms } as unknown as MatrixClient;

    await browsePublicSpaces(mx, { since: 'batch-token' });

    expect(publicRooms).toHaveBeenCalledWith(expect.objectContaining({ since: 'batch-token' }));
  });
});

describe('joinPublicRoom', () => {
  it('joins by room ID or alias and resolves the joined room ID', async () => {
    const joinRoom = vi.fn().mockResolvedValue({ roomId: '!resolved:example.org' });
    const mx = { joinRoom } as unknown as MatrixClient;

    const roomId = await joinPublicRoom(mx, '#public-room:example.org');

    expect(joinRoom).toHaveBeenCalledWith('#public-room:example.org');
    expect(roomId).toBe('!resolved:example.org');
  });
});
