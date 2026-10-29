import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { answer, handleRequest, type BridgeHost } from '../src/main/bridge';
import { linuxAutostartEntry } from '../src/main/autostart';
import { GlobalHotkeys } from '../src/main/hotkeys';
import { keyCodeFor, MOUSE4, MOUSE5, mouseCodeFor } from '../src/main/keycodes';
import { defaults, parseSettings } from '../src/main/settings';
import { displayName, isSameOrigin, normalizeServer, probeServer } from '../src/main/serverAddress';
import { compareVersions, loadPublicKey, parseVersion, signedMessage, verifyFile, verifySignature } from '../src/main/updateSignature';

describe('settings', () => {
  it('starts from the defaults', () => {
    expect(parseSettings(null)).toEqual(defaults);
    expect(parseSettings('not json')).toEqual(defaults);
    expect(parseSettings('[1,2]')).toEqual(defaults);
  });

  it('reads the 1.x app’s file and remembers to explain the new sign-in', () => {
    const legacy = JSON.stringify({
      ServerUrl: 'https://purr.example.com/',
      Bounds: { X: 10, Y: 20, Width: 1200, Height: 800 },
      Maximized: true,
      StartWithWindows: true,
      CloseToTray: false,
      AutoUpdate: false,
      TrayHintShown: true,
    });
    expect(parseSettings(legacy)).toEqual({
      serverUrl: 'https://purr.example.com/',
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
      maximized: true,
      startOnLogin: true,
      closeToTray: false,
      autoUpdate: false,
      trayHintShown: true,
      migrationNoticePending: true,
    });
  });

  it('reads its own file back', () => {
    const saved = { version: 2, ...defaults, serverUrl: 'https://a.example/', closeToTray: false };
    expect(parseSettings(JSON.stringify(saved))).toEqual({ ...defaults, serverUrl: 'https://a.example/', closeToTray: false });
  });
});

describe('server address', () => {
  it('turns what people type into an origin', () => {
    expect(normalizeServer('purr.meowops.net')).toEqual({ ok: true, origin: 'https://purr.meowops.net/' });
    expect(normalizeServer('  https://Purr.Example.com/login?x=1 ')).toEqual({ ok: true, origin: 'https://purr.example.com/' });
    expect(normalizeServer('purr.example.com:8443')).toEqual({ ok: true, origin: 'https://purr.example.com:8443/' });
    expect(normalizeServer('http://localhost:5173')).toEqual({ ok: true, origin: 'http://localhost:5173/' });
  });

  it('refuses what can’t work', () => {
    expect(normalizeServer('')).toMatchObject({ ok: false });
    expect(normalizeServer('http://purr.example.com')).toMatchObject({ ok: false, error: 'The server must use https://.' });
    expect(normalizeServer('https://me:secret@purr.example.com')).toMatchObject({ ok: false });
    expect(normalizeServer('https://')).toMatchObject({ ok: false });
  });

  it('compares origins', () => {
    expect(isSameOrigin('https://purr.example.com/room/1', 'https://purr.example.com/')).toBe(true);
    expect(isSameOrigin('https://purr.example.com.evil.net/', 'https://purr.example.com/')).toBe(false);
    expect(isSameOrigin('http://purr.example.com/', 'https://purr.example.com/')).toBe(false);
    expect(isSameOrigin('about:blank', 'https://purr.example.com/')).toBe(false);
    expect(displayName('https://purr.example.com:8443/')).toBe('purr.example.com:8443');
  });

  it('checks for a Purrlor config', async () => {
    const reply = (status: number, body: string) => async () => new Response(body, { status });
    expect(await probeServer('https://a.example/', reply(200, '{"homeserver":"x"}'))).toBeNull();
    expect(await probeServer('https://a.example/', reply(200, '<html>'))).toMatch(/doesn’t look like Purrlor/);
    expect(await probeServer('https://a.example/', reply(404, ''))).toMatch(/404/);
    expect(await probeServer('https://a.example/', async () => Promise.reject(new Error('ECONNREFUSED')))).toMatch(/ECONNREFUSED/);
  });
});

function fakeHost(): BridgeHost & { calls: string[] } {
  const calls: string[] = [];
  let settings = { startWithWindows: false, closeToTray: true, autoUpdate: true };
  return {
    calls,
    version: '2.0.0',
    platform: 'linux',
    settings: () => settings,
    setSetting: (name, value) => {
      calls.push(`set ${name}=${value}`);
      settings = { ...settings, [name]: value };
    },
    setHotkeys: (b) => b.filter((x) => x.code === 'Nope').map((x) => x.id),
    setBadge: (n) => calls.push(`badge ${n}`),
    watchIdle: (m) => calls.push(`idle ${m}`),
    update: () => ({ state: 'idle', version: null, error: null, releaseUrl: null, automatic: true }),
    checkForUpdates: () => calls.push('check'),
    installUpdate: () => calls.push('install'),
    changeServer: () => calls.push('change'),
  };
}

describe('bridge', () => {
  it('answers getInfo the way the web client expects', () => {
    expect(handleRequest(fakeHost(), 'getInfo', undefined)).toMatchObject({ version: '2.0.0', platform: 'linux', settings: { closeToTray: true } });
  });

  it('changes settings and refuses unknown ones', () => {
    const host = fakeHost();
    expect(handleRequest(host, 'setSetting', { name: 'closeToTray', value: false })).toMatchObject({ closeToTray: false });
    expect(() => handleRequest(host, 'setSetting', { name: 'evil', value: true })).toThrow(/no desktop setting/);
    expect(() => handleRequest(host, 'setSetting', { name: 'closeToTray', value: 'yes' })).toThrow();
  });

  it('passes keybinds through and reports unknown keys', () => {
    expect(handleRequest(fakeHost(), 'setHotkeys', { bindings: [{ id: 'ptt', code: 'KeyV' }, { id: 'mute', code: 'Nope' }] })).toEqual({ unknown: ['mute'] });
    expect(() => handleRequest(fakeHost(), 'setHotkeys', { bindings: [{ code: 'KeyV' }] })).toThrow();
  });

  it('wraps answers, errors and junk', () => {
    const host = fakeHost();
    expect(answer(host, JSON.stringify({ purrlor: 1, id: 7, method: 'setBadge', params: { count: 4 } }), vi.fn())).toEqual({ purrlor: 1, id: 7, result: null });
    expect(host.calls).toContain('badge 4');
    expect(answer(host, JSON.stringify({ purrlor: 1, id: 8, method: 'installUpdate' }), vi.fn())).toEqual({ purrlor: 1, id: 8, error: 'There’s no update downloaded yet.' });
    expect(answer(host, JSON.stringify({ purrlor: 2, id: 9, method: 'getInfo' }), vi.fn())).toBeNull();
    expect(answer(host, '{', vi.fn())).toBeNull();
    const broken = { ...host, watchIdle: () => { throw new Error('boom'); } };
    const onError = vi.fn();
    expect(answer(broken, JSON.stringify({ purrlor: 1, id: 10, method: 'watchIdle', params: { minutes: 5 } }), onError)).toEqual({ purrlor: 1, id: 10, error: 'The desktop app couldn’t do that.' });
    expect(onError).toHaveBeenCalled();
  });
});

describe('keybinds', () => {
  it('maps KeyboardEvent.code to scan codes', () => {
    expect(keyCodeFor('KeyQ')).toBe(0x10);
    expect(keyCodeFor('KeyA')).toBe(0x1e);
    expect(keyCodeFor('KeyM')).toBe(0x32);
    expect(keyCodeFor('Digit1')).toBe(0x02);
    expect(keyCodeFor('Digit0')).toBe(0x0b);
    expect(keyCodeFor('F11')).toBe(0x57);
    expect(keyCodeFor('F24')).toBe(0x6b);
    expect(keyCodeFor('NumpadEnter')).toBe(0x0e1c);
    expect(keyCodeFor('Mouse4')).toBe(MOUSE4);
    expect(keyCodeFor('toString')).toBeNull();
    expect(keyCodeFor('Nope')).toBeNull();
    expect(mouseCodeFor(5)).toBe(MOUSE5);
    expect(mouseCodeFor(1)).toBeNull();
  });

  function setup(available = true) {
    const reports: string[] = [];
    const hook = { on: vi.fn(), removeAllListeners: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const keys = new GlobalHotkeys((id, down) => reports.push(`${id} ${down ? 'down' : 'up'}`), available, () => hook);
    return { keys, hook, reports };
  }

  it('reports bound keys going down and up, once per press', () => {
    const { keys, hook, reports } = setup();
    const none = { ctrl: false, alt: false, shift: false };
    expect(keys.set([{ id: 'ptt', code: 'KeyV', ...none }, { id: 'mute', code: 'KeyM', ctrl: true, alt: false, shift: false }])).toEqual([]);
    expect(hook.start).toHaveBeenCalledTimes(1);
    keys.handle(0x2f, true, { ...none, shift: true }); // V with Shift held still pushes to talk
    keys.handle(0x2f, true, none); // key repeat
    keys.handle(0x2f, false, none);
    keys.handle(0x32, true, none); // M without Ctrl isn't the mute binding
    keys.handle(0x32, true, { ...none, ctrl: true });
    expect(reports).toEqual(['ptt down', 'ptt up', 'mute down']);
    keys.clear(); // let go of anything held, and stop watching
    expect(reports).toEqual(['ptt down', 'ptt up', 'mute down', 'mute up']);
    expect(hook.stop).toHaveBeenCalled();
  });

  it('says every key is unknown where it can’t watch them', () => {
    const { keys, hook } = setup(false);
    expect(keys.set([{ id: 'ptt', code: 'KeyV', ctrl: false, alt: false, shift: false }])).toEqual(['ptt']);
    expect(hook.start).not.toHaveBeenCalled();
  });
});

describe('update signatures', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const key = loadPublicKey(spki)!;
  const hash = 'ab'.repeat(32);

  it('verifies what the release workflow signs, as raw r||s', () => {
    const signature = sign('sha256', signedMessage('2.0.0', hash), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    expect(signature.length).toBe(64); // what .NET's ECDsa.SignData makes, so 1.x apps read it too
    expect(verifySignature(key, '2.0.0', hash, signature)).toBe(true);
    expect(verifySignature(key, '2.0.1', hash, signature)).toBe(false);
    expect(verifySignature(key, '2.0.0', 'cd'.repeat(32), signature)).toBe(false);
  });

  it('checks a file on disk', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'purrlor-test-')), 'update.bin');
    writeFileSync(file, 'new version');
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update('new version').digest('hex');
    const signature = sign('sha256', signedMessage('2.1.0', sha), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    expect(await verifyFile(key, file, '2.1.0', signature)).toBe(true);
    writeFileSync(file, 'tampered');
    expect(await verifyFile(key, file, '2.1.0', signature)).toBe(false);
  });

  it('loads the shipped public key', () => {
    expect(loadPublicKey('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/jEyOY0h+ikyiv7H4+c+uO+djfL9ecSMgnibq3BGqp1gsR5zvW3+D2W/t7jdGTOCac2zdKVn+KrpQyuMYN6X8A==')).not.toBeNull();
    expect(loadPublicKey('junk')).toBeNull();
  });

  it('compares versions', () => {
    expect(parseVersion('desktop-v1.0.0')).toBeNull();
    expect(parseVersion('v1.2')).toEqual([1, 2, 0]);
    expect(compareVersions(parseVersion('1.10.0')!, parseVersion('1.9.9')!)).toBeGreaterThan(0);
  });
});

describe('start on login (Linux)', () => {
  it('writes an autostart entry that starts in the tray', () => {
    const entry = linuxAutostartEntry('/home/me/Apps/Purrlor x86_64.AppImage');
    expect(entry).toContain('Exec="/home/me/Apps/Purrlor x86_64.AppImage" --tray');
    expect(linuxAutostartEntry('/opt/Purrlor/purrlor')).toContain('Exec=/opt/Purrlor/purrlor --tray');
  });
});
