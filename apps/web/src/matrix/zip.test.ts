import { describe, expect, it } from 'vitest';
import { blobBytes, buildZip, crc32 } from './zip';

/** Reads a stored ZIP back through its central directory, as an unzip tool would. */
async function readZip(blob: Blob): Promise<Map<string, string>> {
  const bytes = await blobBytes(blob);
  const view = new DataView(bytes.buffer);
  const endAt = bytes.length - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06054b50);
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(localAt, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localAt + 26, true);
    const data = bytes.subarray(localAt + 30 + localNameLength, localAt + 30 + localNameLength + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, new TextDecoder().decode(data));
    at += 46 + nameLength;
  }
  return files;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('buildZip', () => {
  it('holds every file, with UTF-8 names, readable back through the central directory', async () => {
    const zip = await buildZip([
      { name: 'README.txt', data: 'hello' },
      { name: 'messages/café ☕.json', data: new TextEncoder().encode('{"a":1}') },
      { name: 'media/empty.bin', data: new Blob([]) },
    ]);
    expect(zip.type).toBe('application/zip');
    const files = await readZip(zip);
    expect([...files.keys()]).toEqual(['README.txt', 'messages/café ☕.json', 'media/empty.bin']);
    expect(files.get('README.txt')).toBe('hello');
    expect(files.get('messages/café ☕.json')).toBe('{"a":1}');
    expect(files.get('media/empty.bin')).toBe('');
  });

  it('makes an empty archive from no files', async () => {
    const zip = await buildZip([]);
    expect(zip.size).toBe(22);
  });
});
