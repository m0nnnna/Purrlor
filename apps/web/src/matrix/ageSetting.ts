import type { MatrixClient } from 'matrix-js-sdk';

/**
 * "I'm over 18", self-declared in Account Settings → Privacy, kept in your own account data. It
 * only decides whether *you* are shown pieces their artist rated Mature (art gallery blocks,
 * profilePage.ts): without it they're hidden, with it they're blurred until you click. Nothing
 * checks the claim, which is the plan's open question about whether that's enough for this
 * server's terms: someone signed out, or who hasn't said, never sees a Mature piece.
 */
export const AGE_ACCOUNT_DATA = 'xyz.nekous.age_confirmation';

export function parseOver18(content: unknown): boolean {
  return !!content && typeof content === 'object' && (content as { over18?: unknown }).over18 === true;
}

export function readOver18(mx: MatrixClient): boolean {
  return parseOver18(mx.getAccountData(AGE_ACCOUNT_DATA as any)?.getContent());
}

export async function setOver18(mx: MatrixClient, over18: boolean): Promise<void> {
  await mx.setAccountData(AGE_ACCOUNT_DATA as any, (over18 ? { over18: true, confirmed_ts: Date.now() } : {}) as any);
}
