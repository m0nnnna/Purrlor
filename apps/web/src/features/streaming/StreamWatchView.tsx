import { useAtom, useSetAtom } from 'jotai';
import { profileUserIdAtom } from '../../app/state/selection';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { handleFor } from '../../matrix/roles';
import { openStreamAtom } from './streamerState';
import { useStream, useStreamBase } from './useStream';
import { StreamWatch } from './StreamViews';

/** Signed in, the watch page (`/@name/live/<id>`) in the main pane, over whatever was open. Back closes it. */
export function StreamWatchView() {
  const mx = useMatrixClient();
  const [open, setOpen] = useAtom(openStreamAtom);
  const setProfile = useSetAtom(profileUserIdAtom);
  const base = useStreamBase(open?.owner, mx.getDomain() ?? undefined);
  const { stream, loaded } = useStream(base, open?.streamId);
  if (!open) return null;
  const ownerName = mx.getUser(open.owner)?.displayName || handleFor(open.owner);

  return (
    <main className="nu-main-pane" data-nu-role="main-pane">
      <div className="nu-main-pane__header" data-nu-role="main-pane-header">
        <button
          type="button"
          className="nu-main-pane__header-back nu-main-pane__header-back--always"
          data-nu-role="stream-watch-back"
          title="Back"
          aria-label="Back"
          onClick={() => setOpen(null)}
        >
          <Icon name="arrowLeft" size={18} />
        </button>
        <h1 className="nu-main-pane__header-name">{stream?.title ?? 'Live stream'}</h1>
      </div>
      <div className="nu-stream-page">
        {stream && base !== undefined ? (
          <StreamWatch
            base={base}
            stream={stream}
            mx={mx}
            ownerName={ownerName}
            onOwner={() => {
              setOpen(null);
              setProfile(open.owner);
            }}
          />
        ) : (
          <p className="nu-stream-page__missing" data-nu-role="stream-missing">
            {loaded || base === undefined ? 'This stream has ended, and its replay is gone.' : 'Loading the stream…'}
          </p>
        )}
      </div>
    </main>
  );
}
