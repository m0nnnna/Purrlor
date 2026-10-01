import { useContext } from 'react';
import { MatrixClientContext } from '../MatrixClientContext';

/** Whether there's a signed-in client. Everyone with an account is 18 or over (the terms, section 1). */
export function useSignedIn(): boolean {
  return !!useContext(MatrixClientContext);
}
