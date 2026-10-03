import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppErrorBoundary } from './AppErrorBoundary';

const reportError = vi.fn();
vi.mock('../app/errorReporting', () => ({ reportError: (error: unknown) => reportError(error) }));

function Broken(): never {
  throw new TypeError('cannot draw this');
}

describe('AppErrorBoundary', () => {
  it('shows a way back instead of a blank page, and reports the error with its components', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Broken />
      </AppErrorBoundary>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    const reported = reportError.mock.calls[0][0] as Error;
    expect(reported.message).toBe('cannot draw this');
    expect(reported.name).toBe('TypeError');
    expect(reported.stack).toMatch(/In components:[\s\S]*Broken/);
    vi.mocked(console.error).mockRestore();
  });

  it('draws its children when nothing fails', () => {
    render(
      <AppErrorBoundary>
        <p>fine</p>
      </AppErrorBoundary>
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });
});
