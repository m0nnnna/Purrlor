import { useEffect, useState } from 'react';
import { fetchPageHidden } from '../publicWeb';

/** Whether an admin hid this person's page (matrix/publicWeb.ts). False until known, and for no one. */
export function usePageHidden(userId: string | undefined): boolean {
  const [hidden, setHidden] = useState<{ userId?: string; hidden: boolean }>({ hidden: false });
  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    void fetchPageHidden(userId).then((result) => {
      if (!cancelled) setHidden({ userId, hidden: result });
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return !!userId && hidden.userId === userId && hidden.hidden;
}
