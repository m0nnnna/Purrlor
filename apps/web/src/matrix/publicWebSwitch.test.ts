import { describe, expect, it } from 'vitest';
import { parsePublicWebEnabled } from './publicWebSwitch';

describe('parsePublicWebEnabled', () => {
  it('is on only for a clear yes', () => {
    expect(parsePublicWebEnabled({ enabled: true })).toBe(true);
    expect(parsePublicWebEnabled({ enabled: 'true' })).toBe(false);
    expect(parsePublicWebEnabled({ enabled: 1 })).toBe(false);
    expect(parsePublicWebEnabled({})).toBe(false);
    expect(parsePublicWebEnabled(undefined)).toBe(false);
    expect(parsePublicWebEnabled('yes')).toBe(false);
  });
});
