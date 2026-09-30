import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { sendEncryptedToDevice } from './reports';

// The real module is WebAssembly; the test only needs something to hand the fake OlmMachine.
vi.mock('@matrix-org/matrix-sdk-crypto-wasm', () => ({
  UserId: class {
    constructor(public id: string) {}
  },
}));

function client({ devices, withInternals = true }: { devices: Record<string, string[]>; withInternals?: boolean }) {
  const updateTrackedUsers = vi.fn(async (_users: unknown[]) => {});
  const doProcessOutgoingRequests = vi.fn(async () => {});
  const crypto = {
    getUserDeviceInfo: vi.fn(async () => new Map(Object.entries(devices).map(([userId, ids]) => [userId, new Map(ids.map((id) => [id, {}]))]))),
    encryptToDeviceMessages: vi.fn(async (_type: string, targets: { userId: string; deviceId: string }[]) => ({
      eventType: 'm.room.encrypted',
      batch: targets.map((t) => ({ ...t, payload: { ciphertext: 'x' } })),
    })),
    ...(withInternals && { getOlmMachineOrThrow: () => ({ updateTrackedUsers }), outgoingRequestsManager: { doProcessOutgoingRequests } }),
  };
  const queueToDevice = vi.fn(async (_batch: unknown) => {});
  const sendToDevice = vi.fn(async (_type: string, _map: Map<string, unknown>) => ({}));
  const mx = { getCrypto: () => crypto, queueToDevice, sendToDevice } as unknown as MatrixClient;
  return { mx, crypto, queueToDevice, sendToDevice, updateTrackedUsers, doProcessOutgoingRequests };
}

describe('sendEncryptedToDevice', () => {
  it('tracks the moderators, then encrypts to every device of each', async () => {
    const c = client({ devices: { '@mod1': ['A', 'B'], '@mod2': ['C'] } });
    const result = await sendEncryptedToDevice(c.mx, ['@mod1', '@mod2'], 'xyz.nekous.report', { reason: 'spam' });

    expect(c.updateTrackedUsers.mock.calls[0][0]).toEqual([{ id: '@mod1' }, { id: '@mod2' }]);
    expect(c.doProcessOutgoingRequests).toHaveBeenCalled();
    expect(c.crypto.encryptToDeviceMessages).toHaveBeenCalledWith(
      'xyz.nekous.report',
      [
        { userId: '@mod1', deviceId: 'A' },
        { userId: '@mod1', deviceId: 'B' },
        { userId: '@mod2', deviceId: 'C' },
      ],
      { reason: 'spam' }
    );
    expect(c.queueToDevice).toHaveBeenCalledTimes(1);
    expect(c.sendToDevice).not.toHaveBeenCalled();
    expect(result).toEqual({ encrypted: ['@mod1', '@mod2'], plain: [] });
  });

  it('sends plain only to a moderator with no device it could encrypt for', async () => {
    const c = client({ devices: { '@mod1': ['A'] } });
    const result = await sendEncryptedToDevice(c.mx, ['@mod1', '@nokeys'], 'xyz.nekous.report', {});
    expect(result).toEqual({ encrypted: ['@mod1'], plain: ['@nokeys'] });
    expect([...(c.sendToDevice.mock.calls[0][1] as Map<string, unknown>).keys()]).toEqual(['@nokeys']);
  });

  it('falls back to plain for everyone when the SDK’s crypto isn’t the one it knows', async () => {
    const c = client({ devices: { '@mod1': ['A'] }, withInternals: false });
    const result = await sendEncryptedToDevice(c.mx, ['@mod1'], 'xyz.nekous.report', {});
    expect(result).toEqual({ encrypted: [], plain: ['@mod1'] });
    expect(c.queueToDevice).not.toHaveBeenCalled();
  });
});
