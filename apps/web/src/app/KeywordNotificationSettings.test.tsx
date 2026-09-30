import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IPushRules, MatrixClient } from 'matrix-js-sdk';
import { MatrixClientContext } from '../matrix/MatrixClientContext';
import { KeywordNotificationSettings } from './KeywordNotificationSettings';

afterEach(cleanup);

function fakeServer() {
  const content: { rule_id: string; pattern: string; enabled: boolean; default: boolean; actions: unknown[] }[] = [];
  const mx = {
    pushRules: { global: { content } } as unknown as IPushRules,
    getPushRules: async () => ({ global: { content: [...content] } }) as unknown as IPushRules,
    addPushRule: vi.fn(async (_scope: string, _kind: string, ruleId: string, body: { pattern: string; actions: unknown[] }) => {
      content.push({ rule_id: ruleId, pattern: body.pattern, enabled: true, default: false, actions: body.actions });
    }),
    deletePushRule: vi.fn(async (_scope: string, _kind: string, ruleId: string) => {
      content.splice(0, content.length, ...content.filter((r) => r.rule_id !== ruleId));
    }),
  } as unknown as MatrixClient;
  return mx;
}

describe('KeywordNotificationSettings', () => {
  it('adds a keyword to the list and removes it again', async () => {
    const mx = fakeServer();
    render(
      <MatrixClientContext.Provider value={mx}>
        <KeywordNotificationSettings />
      </MatrixClientContext.Provider>
    );

    fireEvent.change(screen.getByPlaceholderText('A word or phrase'), { target: { value: 'purrlor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('purrlor')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('A word or phrase')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Remove purrlor' }));
    await waitFor(() => expect(screen.queryByText('purrlor')).not.toBeInTheDocument());
  });

  it('refuses a repeat without asking the server', async () => {
    const mx = fakeServer();
    render(
      <MatrixClientContext.Provider value={mx}>
        <KeywordNotificationSettings />
      </MatrixClientContext.Provider>
    );
    for (let i = 0; i < 2; i++) {
      fireEvent.change(screen.getByPlaceholderText('A word or phrase'), { target: { value: 'Purrlor' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      if (i === 0) await screen.findByText('Purrlor');
    }
    expect(await screen.findByText('That one is already on the list.')).toBeInTheDocument();
    expect((mx.addPushRule as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
