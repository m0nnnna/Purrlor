import { useContext, useEffect, useState } from 'react';
import { ClientEvent, type MatrixEvent } from 'matrix-js-sdk';
import { MatrixClientContext } from '../MatrixClientContext';
import { AGE_ACCOUNT_DATA, readOver18 } from '../ageSetting';

/** Whether you've said you're over 18 (matrix/ageSetting.ts), live. Always false signed out. */
export function useOver18(): boolean {
  const mx = useContext(MatrixClientContext);
  const [over18, setOver18] = useState(() => (mx ? readOver18(mx) : false));
  useEffect(() => {
    if (!mx) return undefined;
    setOver18(readOver18(mx));
    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === AGE_ACCOUNT_DATA) setOver18(readOver18(mx));
    };
    mx.on(ClientEvent.AccountData, onAccountData);
    return () => {
      mx.removeListener(ClientEvent.AccountData, onAccountData);
    };
  }, [mx]);
  return over18;
}
