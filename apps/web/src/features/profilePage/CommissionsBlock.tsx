import { useContext, useEffect, useRef, useState } from 'react';
import { Lightbox } from '../../components/Lightbox';
import { ShareLinkButton } from '../../components/ShareLinkButton';
import { pageLink } from '../../matrix/publicWeb';
import { useMatrixClient, MatrixClientContext } from '../../matrix/MatrixClientContext';
import {
  COMMISSION_STATUS_LABELS,
  COMMISSION_STATUSES,
  hasConsented,
  setCommissionConsent,
  setCommissionStatus,
  slotClientName,
  type CommissionStatus,
  type CommissionType,
  type Commissions,
  type QueueSlot,
} from '../../matrix/commissions';
import { readAlertList, setCommissionAlert } from '../../matrix/commissionAlerts';
import { useCommissions } from '../../matrix/hooks/useCommissions';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { useFollows } from '../../matrix/hooks/useFollows';
import { handleFor } from '../../matrix/roles';
import { CommissionManager } from './CommissionManager';
import { CommissionRequestModal } from './CommissionRequestModal';
import { PageOwnerContext } from './PageOwnerContext';
import { PageTargetContext } from './PageTargetContext';

/** "Commissions: open": the badge on the header and the block (CommissionBadge in ProfileView too). */
export function StatusBadge({ status }: { status: CommissionStatus }) {
  return (
    <span className={`nu-commission-badge nu-commission-badge--${status}`} data-nu-role="commission-status-badge">
      Commissions: {COMMISSION_STATUS_LABELS[status].toLowerCase()}
    </span>
  );
}

/** The status badge for a profile's header, for a page that has a commissions block. Nothing if no status is set. */
export function HeaderCommissionBadge({ roomId }: { roomId: string | undefined }) {
  const { commissions } = useCommissions(roomId);
  const status = commissions?.state?.status;
  return status ? <StatusBadge status={status} /> : null;
}

/**
 * One commission type: its example picture (pressed, shown large), name, price, description and
 * slots, and a link straight to it. A link that pointed here scrolls it into view, marks it, and
 * shows the example large.
 */
function PriceCard({ type, ownerId, linked }: { type: CommissionType; ownerId: string; linked: boolean }) {
  const example = useMediaUrl(type.example, { width: 480, height: 320, method: 'scale' });
  const full = useMediaUrl(type.example);
  const [large, setLarge] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const shownLinked = useRef(false);
  useEffect(() => {
    if (!linked || shownLinked.current) return;
    shownLinked.current = true;
    ref.current?.scrollIntoView?.({ block: 'center' });
    if (type.example) setLarge(true);
  }, [linked, type.example]);
  return (
    <article
      ref={ref}
      className={linked ? 'nu-commissions__price nu-commissions__price--linked' : 'nu-commissions__price'}
      data-nu-role="commission-price"
    >
      {example && (
        <button type="button" className="nu-commissions__example-button" aria-label={`Show the example for ${type.name}`} onClick={() => setLarge(true)}>
          <img className="nu-commissions__example" src={example} alt="" loading="lazy" />
        </button>
      )}
      {large && full && <Lightbox src={full} alt={type.name} onClose={() => setLarge(false)} />}
      <div className="nu-commissions__price-head">
        <strong>{type.name}</strong>
        <span className="nu-commissions__amount">{type.price}</span>
        <ShareLinkButton
          url={pageLink(ownerId, { kind: 'commission', type: type.id })}
          title={type.name}
          iconOnly
          className="nu-profile-page__piece-link"
          role="commission-link"
        />
      </div>
      {type.description && <p className="nu-commissions__description">{type.description}</p>}
      {type.slots && (
        <p className="nu-commissions__slots" data-nu-role="commission-slots">
          {type.slots.open} of {type.slots.total} open
        </p>
      )}
    </article>
  );
}

function SlotRow({
  slot,
  stages,
  label,
  consent,
}: {
  slot: QueueSlot;
  stages: string[];
  label: { name: string; named: boolean; mine: boolean };
  consent?: { agreed: boolean; onChange: (agree: boolean) => void };
}) {
  return (
    <li className="nu-commissions__slot" data-nu-role="commission-slot">
      <div className="nu-commissions__slot-head">
        <strong>{slot.title}</strong>
        <span className="nu-commissions__slot-client">{label.named ? handleFor(label.name) : label.name === 'Client' ? 'Client' : `${handleFor(label.name)} (shown as “Client”)`}</span>
      </div>
      <div className="nu-commissions__stages" role="img" aria-label={`Stage: ${stages[slot.stage]}`}>
        {stages.map((stage, index) => (
          <span
            key={`${stage}-${index}`}
            className={index < slot.stage ? 'nu-commissions__stage nu-commissions__stage--done' : index === slot.stage ? 'nu-commissions__stage nu-commissions__stage--now' : 'nu-commissions__stage'}
          >
            {stage}
          </span>
        ))}
      </div>
      {consent && (
        <label className="nu-field__checkbox-row">
          <input type="checkbox" checked={consent.agreed} onChange={(evt) => consent.onChange(evt.target.checked)} data-nu-role="commission-consent" />
          Show my name on this slot
        </label>
      )}
    </li>
  );
}

function AlertToggle({ artistId }: { artistId: string }) {
  const mx = useMatrixClient();
  const [on, setOn] = useState(() => readAlertList(mx).includes(artistId));
  const [error, setError] = useState<string>();
  const follows = useFollows().users;
  useEffect(() => setOn(readAlertList(mx).includes(artistId)), [mx, artistId]);
  return (
    <div className="nu-field">
      <label className="nu-field__checkbox-row">
        <input
          type="checkbox"
          checked={on}
          data-nu-role="commission-alert"
          onChange={(evt) => {
            const next = evt.target.checked;
            setOn(next);
            setError(undefined);
            setCommissionAlert(mx, artistId, next).catch((err: unknown) => {
              setOn(!next);
              setError(err instanceof Error ? err.message : 'Couldn’t change that');
            });
          }}
        />
        Tell me when commissions open
      </label>
      {on && !follows.includes(artistId) && <p className="nu-field__hint">Follow {handleFor(artistId)} too: that’s how you hear about it.</p>}
      {error && <p className="nu-field__error">{error}</p>}
    </div>
  );
}

function SignedInCommissions({ owner }: { owner: { userId: string; roomId?: string; isMe: boolean } }) {
  const mx = useMatrixClient();
  const me = mx.getUserId() ?? '';
  const target = useContext(PageTargetContext);
  const { commissions, consents, loading, reload } = useCommissions(owner.roomId);
  const [requesting, setRequesting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const data: Commissions | undefined = commissions;
  const status = data?.state?.status;

  if (!owner.roomId) {
    return <p className="nu-field__hint">{owner.isMe ? 'Publish your page to set up commissions.' : 'No commissions set up yet.'}</p>;
  }
  if (loading || !data) return <p className="nu-field__hint">Loading…</p>;

  const flip = (next: CommissionStatus) => {
    setError(undefined);
    setCommissionStatus(mx, owner.roomId as string, { status: next, note: note ?? data.state?.note }).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Couldn’t change the status')
    );
  };

  const hasContent = status || data.types.length > 0 || data.queue.slots.length > 0;
  return (
    <>
      <div className="nu-commissions__status">
        {status ? <StatusBadge status={status} /> : <span className="nu-field__hint">No status set.</span>}
        {data.state?.note && <span className="nu-commissions__note">{data.state.note}</span>}
      </div>

      {owner.isMe && (
        <div className="nu-commissions__owner" data-nu-role="commission-owner">
          <div className="nu-commissions__flip" role="group" aria-label="Commission status">
            {COMMISSION_STATUSES.map((value) => (
              <button
                key={value}
                type="button"
                className={status === value ? 'nu-button nu-button--primary' : 'nu-button nu-button--secondary'}
                aria-pressed={status === value}
                data-nu-role={`commission-set-${value}`}
                onClick={() => flip(value)}
              >
                {COMMISSION_STATUS_LABELS[value]}
              </button>
            ))}
          </div>
          <input
            className="nu-field__input"
            placeholder="A note (optional): “2 slots, back to full in March”"
            maxLength={200}
            defaultValue={data.state?.note ?? ''}
            onChange={(evt) => setNote(evt.target.value)}
            onBlur={() => status && note !== undefined && flip(status)}
            aria-label="Status note"
          />
          <button type="button" className="nu-button nu-button--secondary" data-nu-role="commission-manage" onClick={() => setManaging(true)}>
            Edit price sheet and queue
          </button>
          <p className="nu-field__hint">Purrlor takes no payments. Add your Ko-fi or PayPal as a link button on your page.</p>
        </div>
      )}

      {!owner.isMe && (
        <div className="nu-commissions__visitor">
          <button
            type="button"
            className="nu-button nu-button--primary"
            data-nu-role="commission-request"
            disabled={status === 'closed'}
            title={status === 'closed' ? 'Commissions are closed' : undefined}
            onClick={() => setRequesting(true)}
          >
            Request a commission
          </button>
          <AlertToggle artistId={owner.userId} />
        </div>
      )}

      {data.types.length > 0 && (
        <div className="nu-commissions__prices" data-nu-role="commission-prices">
          {data.types.map((type) => (
            <PriceCard key={type.id} type={type} ownerId={owner.userId} linked={target?.kind === 'commission' && target.type === type.id} />
          ))}
        </div>
      )}

      {data.queue.slots.length > 0 && (
        <ul className="nu-commissions__queue" data-nu-role="commission-queue">
          {data.queue.slots.map((slot) => {
            const label = slotClientName(slot, consents, { userId: me, isArtist: owner.isMe });
            return (
              <SlotRow
                key={slot.id}
                slot={slot}
                stages={data.queue.stages}
                label={label}
                consent={
                  label.mine
                    ? {
                        agreed: !!me && hasConsented(consents, slot, me),
                        onChange: (agree) => {
                          setCommissionConsent(mx, owner.roomId as string, owner.userId, slot, agree).then(reload, (err: unknown) =>
                            setError(err instanceof Error ? err.message : 'Couldn’t save that')
                          );
                        },
                      }
                    : undefined
                }
              />
            );
          })}
        </ul>
      )}

      {!hasContent && !owner.isMe && <p className="nu-field__hint">Nothing here yet.</p>}
      {error && <p className="nu-field__error">{error}</p>}
      {requesting && (
        <CommissionRequestModal artistId={owner.userId} types={data.types} onClose={() => setRequesting(false)} />
      )}
      {managing && <CommissionManager roomId={owner.roomId} commissions={data} onClose={() => setManaging(false)} />}
    </>
  );
}

/** The commissions block: status, price sheet, queue and the request form. Signed out it asks you to sign in. */
export function CommissionsBlock() {
  const mx = useContext(MatrixClientContext);
  const owner = useContext(PageOwnerContext);
  if (!owner) return null;
  return mx ? (
    <SignedInCommissions owner={owner} />
  ) : (
    <p className="nu-field__hint" data-nu-role="commissions-signed-out">
      Sign in to see commission status, prices and the queue.
    </p>
  );
}
