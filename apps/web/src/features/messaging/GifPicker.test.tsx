import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { MatrixClient } from 'matrix-js-sdk';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import { GifPicker } from './GifPicker';

const gif = (id: string) => ({
  id,
  title: `Gif ${id}`,
  preview: { url: `https://static.klipy.com/${id}-preview.gif`, width: 90, height: 68 },
  full: { gif: { url: `https://static.klipy.com/${id}-full.gif`, width: 320, height: 240, size: 1000 } },
});

const areGifsEnabled = vi.fn();
const trendingGifs = vi.fn();
const searchGifs = vi.fn();
const downloadGifAsFile = vi.fn();

vi.mock('../../matrix/gifApi', () => ({
  areGifsEnabled: () => areGifsEnabled(),
  trendingGifs: (...args: unknown[]) => trendingGifs(...args),
  searchGifs: (...args: unknown[]) => searchGifs(...args),
  downloadGifAsFile: (...args: unknown[]) => downloadGifAsFile(...args),
}));

const mx = {} as MatrixClient;

function show(onPickGif = vi.fn()) {
  const utils = render(
    <MatrixClientContext.Provider value={mx}>
      <GifPicker onPickGif={onPickGif} />
    </MatrixClientContext.Provider>
  );
  return { ...utils, onPickGif };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GifPicker', () => {
  it('renders nothing while this deployment has no GIF search configured', async () => {
    areGifsEnabled.mockResolvedValue(false);
    const { container } = show();
    await waitFor(() => expect(areGifsEnabled).toHaveBeenCalled());
    expect(container.querySelector('[data-nu-role="gif-picker-toggle"]')).toBeNull();
  });

  it('shows the toggle once enabled, and hides it before that resolves', async () => {
    let resolveEnabled: (v: boolean) => void = () => {};
    areGifsEnabled.mockReturnValue(new Promise((resolve) => (resolveEnabled = resolve)));
    const { container } = show();
    expect(container.querySelector('[data-nu-role="gif-picker-toggle"]')).toBeNull();
    resolveEnabled(true);
    await waitFor(() => expect(container.querySelector('[data-nu-role="gif-picker-toggle"]')).not.toBeNull());
  });

  it('loads trending GIFs as soon as the panel opens', async () => {
    areGifsEnabled.mockResolvedValue(true);
    trendingGifs.mockResolvedValue({ results: [gif('1'), gif('2')], nextCursor: null });
    const { container } = show();
    await waitFor(() => expect(container.querySelector('[data-nu-role="gif-picker-toggle"]')).not.toBeNull());

    fireEvent.click(container.querySelector('[data-nu-role="gif-picker-toggle"]')!);
    await waitFor(() => expect(trendingGifs).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelectorAll('[data-nu-role="gif-picker-item"]')).toHaveLength(2));
    expect(searchGifs).not.toHaveBeenCalled();
  });

  it('debounces typing into a search call instead of firing on every keystroke', async () => {
    areGifsEnabled.mockResolvedValue(true);
    trendingGifs.mockResolvedValue({ results: [], nextCursor: null });
    searchGifs.mockResolvedValue({ results: [gif('cat')], nextCursor: null });
    const { container } = show();
    await waitFor(() => expect(container.querySelector('[data-nu-role="gif-picker-toggle"]')).not.toBeNull());
    fireEvent.click(container.querySelector('[data-nu-role="gif-picker-toggle"]')!);
    await waitFor(() => expect(trendingGifs).toHaveBeenCalledTimes(1));

    const input = container.querySelector('[data-nu-role="gif-picker-search"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'c' } });
    fireEvent.change(input, { target: { value: 'ca' } });
    fireEvent.change(input, { target: { value: 'cat' } });

    await waitFor(() => expect(searchGifs).toHaveBeenCalledTimes(1));
    expect(searchGifs.mock.calls[0][1]).toMatchObject({ query: 'cat' });
  });

  it('downloads the picked GIF and hands the file to the caller, then closes', async () => {
    areGifsEnabled.mockResolvedValue(true);
    trendingGifs.mockResolvedValue({ results: [gif('1')], nextCursor: null });
    const file = new File(['bytes'], 'gif-1.gif', { type: 'image/gif' });
    downloadGifAsFile.mockResolvedValue(file);
    const onPickGif = vi.fn();
    const { container } = show(onPickGif);
    await waitFor(() => expect(container.querySelector('[data-nu-role="gif-picker-toggle"]')).not.toBeNull());
    fireEvent.click(container.querySelector('[data-nu-role="gif-picker-toggle"]')!);
    await waitFor(() => expect(container.querySelectorAll('[data-nu-role="gif-picker-item"]')).toHaveLength(1));

    fireEvent.click(container.querySelector('[data-nu-role="gif-picker-item"]')!);
    await waitFor(() => expect(onPickGif).toHaveBeenCalledWith(file));
    expect(container.querySelector('[data-nu-role="gif-picker-panel"]')).toBeNull();
  });

  it('loads the next page on scrolling near the bottom of the grid', async () => {
    areGifsEnabled.mockResolvedValue(true);
    trendingGifs.mockResolvedValueOnce({ results: [gif('1')], nextCursor: 'page-2' });
    trendingGifs.mockResolvedValueOnce({ results: [gif('2')], nextCursor: null });
    const { container } = show();
    await waitFor(() => expect(container.querySelector('[data-nu-role="gif-picker-toggle"]')).not.toBeNull());
    fireEvent.click(container.querySelector('[data-nu-role="gif-picker-toggle"]')!);
    await waitFor(() => expect(container.querySelectorAll('[data-nu-role="gif-picker-item"]')).toHaveLength(1));

    const body = container.querySelector('[data-nu-role="gif-picker-body"]') as HTMLDivElement;
    Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(body, 'scrollTop', { value: 850, configurable: true });
    fireEvent.scroll(body);

    await waitFor(() => expect(trendingGifs).toHaveBeenCalledTimes(2));
    expect(trendingGifs.mock.calls[1][1]).toMatchObject({ cursor: 'page-2' });
    await waitFor(() => expect(container.querySelectorAll('[data-nu-role="gif-picker-item"]')).toHaveLength(2));
  });

  it('shows an error instead of a blank grid when the request fails', async () => {
    areGifsEnabled.mockResolvedValue(true);
    trendingGifs.mockRejectedValue(new Error('GIF provider request failed'));
    const { container } = show();
    await waitFor(() => expect(container.querySelector('[data-nu-role="gif-picker-toggle"]')).not.toBeNull());
    fireEvent.click(container.querySelector('[data-nu-role="gif-picker-toggle"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-nu-role="gif-picker-error"]')?.textContent).toBe('GIF provider request failed')
    );
  });
});
