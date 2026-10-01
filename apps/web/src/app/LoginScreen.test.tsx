import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LoginScreen } from './LoginScreen';
import { loadRuntimeConfig } from './runtimeConfig';

const loginWithPassword = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../matrix/login', () => ({ loginWithPassword: (...args: unknown[]) => loginWithPassword(...args) }));

async function withConfig(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
  await loadRuntimeConfig();
  vi.unstubAllGlobals();
}

afterEach(() => {
  cleanup();
  loginWithPassword.mockClear();
});

describe('LoginScreen', () => {
  it('asks for a homeserver when the deployment has not locked one', async () => {
    await withConfig({ homeserver: '' });
    render(<LoginScreen onLoggedIn={vi.fn()} onSwitchToRegister={vi.fn()} />);

    expect(screen.getByLabelText('Homeserver')).toBeTruthy();
    expect(screen.queryByText(/Signing in to/)).toBeNull();
  });

  it('replaces the field with the locked homeserver and logs in against it', async () => {
    await withConfig({ homeserver: 'https://matrix.example.com' });
    const { container } = render(<LoginScreen onLoggedIn={vi.fn()} onSwitchToRegister={vi.fn()} />);

    expect(screen.queryByLabelText('Homeserver')).toBeNull();
    expect(screen.getByText('matrix.example.com')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } });
    fireEvent.submit(container.querySelector('form')!);

    expect(loginWithPassword).toHaveBeenCalledWith('https://matrix.example.com', 'alice', 'hunter22');
  });

  it('opens the terms of service from the agreement note', async () => {
    await withConfig({ homeserver: '' });
    render(<LoginScreen onLoggedIn={vi.fn()} onSwitchToRegister={vi.fn()} />);

    expect(screen.getByText(/By making an account you agree to our/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Terms of Service' }));

    expect(screen.getByText(/You must be at least 18 years old/)).toBeTruthy();
    expect(screen.getByText(/must be marked with a content warning/)).toBeTruthy();
  });
});
