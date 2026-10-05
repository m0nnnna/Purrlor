import { describe, expect, it } from 'vitest';
import { parseFeedBackground } from './feedBackground';

describe('parseFeedBackground', () => {
  it('reads a picture and its dim, kept between 0 and 90', () => {
    expect(parseFeedBackground({ url: 'mxc://purr.example/abc', dim: 30 })).toEqual({ url: 'mxc://purr.example/abc', dim: 30 });
    expect(parseFeedBackground({ url: 'mxc://purr.example/abc', dim: 150 })).toEqual({ url: 'mxc://purr.example/abc', dim: 90 });
    expect(parseFeedBackground({ url: 'mxc://purr.example/abc' })).toEqual({ url: 'mxc://purr.example/abc', dim: 60 });
  });

  it('is nothing for an empty or foreign value', () => {
    expect(parseFeedBackground({})).toBeUndefined();
    expect(parseFeedBackground(undefined)).toBeUndefined();
    expect(parseFeedBackground({ url: 'https://tracker.example/x.png' })).toBeUndefined();
    expect(parseFeedBackground({ url: 'mxc://purr.example/a") , url(x' })).toBeUndefined();
  });
});
