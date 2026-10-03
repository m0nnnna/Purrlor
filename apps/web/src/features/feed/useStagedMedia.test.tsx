import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ClipboardEvent, ReactNode } from 'react';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import { useStagedMedia } from './useStagedMedia';

vi.mock('../../matrix/postMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../matrix/postMedia')>()),
  getUploadLimit: async () => undefined,
  prepareMedia: async (file: File) => ({ file, kind: 'image' }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <MatrixClientContext.Provider value={{} as never}>{children}</MatrixClientContext.Provider>
);

/** A paste event carrying these clipboard items, and whether the paste was stopped. */
function paste(items: { kind: string; type: string; file?: File }[]) {
  const evt = {
    clipboardData: { items: items.map((item) => ({ kind: item.kind, type: item.type, getAsFile: () => item.file ?? null })) },
    preventDefault: vi.fn(),
  };
  return evt as unknown as ClipboardEvent<HTMLTextAreaElement> & { preventDefault: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:preview', revokeObjectURL: () => undefined });
});
afterEach(() => vi.unstubAllGlobals());

describe('useStagedMedia: pasting', () => {
  it('stages a pasted image and keeps it out of the text', async () => {
    const { result } = renderHook(() => useStagedMedia(vi.fn()), { wrapper });
    const image = new File(['x'], 'image.png', { type: 'image/png' });
    const evt = paste([{ kind: 'file', type: 'image/png', file: image }]);
    act(() => result.current.addPasted(evt));
    expect(evt.preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(result.current.staged.map((item) => item.file)).toEqual([image]));
  });

  it('leaves a text paste alone', () => {
    const { result } = renderHook(() => useStagedMedia(vi.fn()), { wrapper });
    const evt = paste([{ kind: 'string', type: 'text/plain' }]);
    act(() => result.current.addPasted(evt));
    expect(evt.preventDefault).not.toHaveBeenCalled();
    expect(result.current.staged).toEqual([]);
  });

  it("leaves a pasted file that isn't an image or video to the text box", () => {
    const { result } = renderHook(() => useStagedMedia(vi.fn()), { wrapper });
    const evt = paste([{ kind: 'file', type: 'application/pdf', file: new File(['x'], 'a.pdf', { type: 'application/pdf' }) }]);
    act(() => result.current.addPasted(evt));
    expect(evt.preventDefault).not.toHaveBeenCalled();
  });
});
