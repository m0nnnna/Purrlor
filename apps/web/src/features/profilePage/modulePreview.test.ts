import { describe, expect, it } from 'vitest';
import type { MusicAlbum } from '../../matrix/profilePage';
import { latestAlbum } from './ModulePreview';

const album = (id: string, year?: number): MusicAlbum => ({ id, ...(year && { year }), tracks: [] });

describe('latestAlbum', () => {
  it('picks the latest year, wherever the album sits on the shelf', () => {
    expect(latestAlbum([album('new', 2025), album('old', 2019)])?.id).toBe('new');
  });

  it('picks the last added when albums have no year, or share one', () => {
    expect(latestAlbum([album('a'), album('b')])?.id).toBe('b');
    expect(latestAlbum([album('a', 2024), album('b', 2024)])?.id).toBe('b');
  });

  it('has nothing to pick from no albums', () => {
    expect(latestAlbum([])).toBeUndefined();
  });
});
