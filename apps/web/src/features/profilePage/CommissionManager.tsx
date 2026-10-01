import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import {
  COMMISSION_LIMITS,
  DEFAULT_STAGES,
  setCommissionPrices,
  setCommissionQueue,
  type CommissionQueue,
  type CommissionType,
  type Commissions,
  type QueueSlot,
} from '../../matrix/commissions';
import { useFollows } from '../../matrix/hooks/useFollows';
import { handleFor } from '../../matrix/roles';
import { ImagePicker, ImageThumb } from './ImagePicker';

function newId(prefix: string, taken: string[]): string {
  for (;;) {
    const id = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.includes(id)) return id;
  }
}

function PricesEditor({ types, onChange }: { types: CommissionType[]; onChange: (types: CommissionType[]) => void }) {
  const set = (index: number, patch: Partial<CommissionType>) => onChange(types.map((type, i) => (i === index ? { ...type, ...patch } : type)));
  return (
    <section className="nu-commissions__editor" data-nu-role="commission-prices-editor">
      <h3>Price sheet</h3>
      {types.map((type, index) => (
        <fieldset key={type.id} className="nu-page-editor__subitem">
          <div className="nu-page-editor__row">
            <label className="nu-field">
              Type
              <input className="nu-field__input" value={type.name} maxLength={COMMISSION_LIMITS.name} placeholder="Sketch, flat colour, full render…" onChange={(evt) => set(index, { name: evt.target.value })} />
            </label>
            <label className="nu-field">
              Price
              <input className="nu-field__input" value={type.price} maxLength={COMMISSION_LIMITS.price} placeholder="$25 or from £10" onChange={(evt) => set(index, { price: evt.target.value })} />
            </label>
          </div>
          <label className="nu-field">
            Description (optional)
            <input className="nu-field__input" value={type.description ?? ''} maxLength={COMMISSION_LIMITS.description} onChange={(evt) => set(index, { description: evt.target.value || undefined })} />
          </label>
          <div className="nu-page-editor__row">
            <label className="nu-field">
              Slots open
              <input
                className="nu-field__input"
                type="number"
                min={0}
                max={COMMISSION_LIMITS.slotCount}
                value={type.slots?.open ?? ''}
                onChange={(evt) => {
                  const open = Math.max(0, Math.round(Number(evt.target.value) || 0));
                  set(index, { slots: { total: Math.max(type.slots?.total ?? open, open), open } });
                }}
              />
            </label>
            <label className="nu-field">
              of
              <input
                className="nu-field__input"
                type="number"
                min={0}
                max={COMMISSION_LIMITS.slotCount}
                value={type.slots?.total ?? ''}
                onChange={(evt) => {
                  const total = Math.max(0, Math.round(Number(evt.target.value) || 0));
                  set(index, total > 0 ? { slots: { total, open: Math.min(type.slots?.open ?? total, total) } } : { slots: undefined });
                }}
              />
            </label>
          </div>
          <div className="nu-page-editor__row">
            {type.example && <ImageThumb mxc={type.example} onRemove={() => set(index, { example: undefined })} />}
            <ImagePicker label={type.example ? 'Change example…' : 'Add an example image…'} onUploaded={([example]) => set(index, { example })} />
          </div>
          <button type="button" className="nu-page-editor__inline-button" onClick={() => onChange(types.filter((_, i) => i !== index))}>
            Remove this type
          </button>
        </fieldset>
      ))}
      {types.length < COMMISSION_LIMITS.types && (
        <button
          type="button"
          className="nu-button nu-button--secondary"
          data-nu-role="commission-add-type"
          onClick={() => onChange([...types, { id: newId('t', types.map((t) => t.id)), name: '', price: '' }])}
        >
          Add a type
        </button>
      )}
    </section>
  );
}

function QueueEditor({ queue, onChange }: { queue: CommissionQueue; onChange: (queue: CommissionQueue) => void }) {
  const follows = useFollows().users;
  const setSlot = (index: number, patch: Partial<QueueSlot>) =>
    onChange({ ...queue, slots: queue.slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)) });
  const setStages = (stages: string[]) =>
    onChange({ stages, slots: queue.slots.map((slot) => ({ ...slot, stage: Math.min(slot.stage, Math.max(0, stages.length - 1)) })) });

  return (
    <section className="nu-commissions__editor" data-nu-role="commission-queue-editor">
      <h3>Queue</h3>
      <label className="nu-field">
        Stages, in order (one per line)
        <textarea
          className="nu-field__input nu-field__textarea"
          rows={4}
          value={queue.stages.join('\n')}
          onChange={(evt) => setStages(evt.target.value.split('\n').slice(0, COMMISSION_LIMITS.stages).map((s) => s.slice(0, COMMISSION_LIMITS.stage)))}
        />
      </label>
      {queue.slots.map((slot, index) => (
        <fieldset key={slot.id} className="nu-page-editor__subitem">
          <label className="nu-field">
            What
            <input className="nu-field__input" value={slot.title} maxLength={COMMISSION_LIMITS.slotTitle} placeholder="Sketch for @nibbles" onChange={(evt) => setSlot(index, { title: evt.target.value })} />
          </label>
          <div className="nu-page-editor__row">
            <label className="nu-field">
              Stage
              <select className="nu-field__input" value={slot.stage} onChange={(evt) => setSlot(index, { stage: Number(evt.target.value) })}>
                {queue.stages.map((stage, i) => (
                  <option key={`${stage}-${i}`} value={i}>
                    {stage || `Stage ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="nu-field">
              Client
              <select className="nu-field__input" value={slot.client ?? ''} onChange={(evt) => setSlot(index, { client: evt.target.value || undefined })}>
                <option value="">Not named</option>
                {[...new Set([...(slot.client ? [slot.client] : []), ...follows])].map((user) => (
                  <option key={user} value={user}>
                    {handleFor(user)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="nu-field__hint">A client’s name shows to others only if they agree. Until then it says “Client”.</p>
          <button type="button" className="nu-page-editor__inline-button" onClick={() => onChange({ ...queue, slots: queue.slots.filter((_, i) => i !== index) })}>
            Remove this slot
          </button>
        </fieldset>
      ))}
      {queue.slots.length < COMMISSION_LIMITS.slots && (
        <button
          type="button"
          className="nu-button nu-button--secondary"
          data-nu-role="commission-add-slot"
          onClick={() => onChange({ ...queue, slots: [...queue.slots, { id: newId('s', queue.slots.map((s) => s.id)), title: '', stage: 0 }] })}
        >
          Add a slot
        </button>
      )}
    </section>
  );
}

/** The artist's editors for the price sheet and the queue: each saves as its own state event. */
export function CommissionManager({ roomId, commissions, onClose }: { roomId: string; commissions: Commissions; onClose: () => void }) {
  const mx = useMatrixClient();
  const [types, setTypes] = useState(commissions.types);
  const [queue, setQueue] = useState<CommissionQueue>({ ...commissions.queue, stages: commissions.queue.stages.length > 0 ? commissions.queue.stages : DEFAULT_STAGES });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      // Only what changed is written, so moving a slot doesn't touch the price sheet.
      if (JSON.stringify(types) !== JSON.stringify(commissions.types)) await setCommissionPrices(mx, roomId, types);
      if (JSON.stringify(queue) !== JSON.stringify(commissions.queue)) await setCommissionQueue(mx, roomId, queue);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save');
      setSaving(false);
    }
  };

  return (
    <Modal title="Price sheet and queue" onClose={onClose} wide>
      <div className="nu-modal-form" data-nu-role="commission-manager">
        <PricesEditor types={types} onChange={setTypes} />
        <QueueEditor queue={queue} onChange={setQueue} />
        {error && <p className="nu-field__error">{error}</p>}
        <div className="nu-form-actions">
          <button type="button" className="nu-button nu-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="nu-button nu-button--primary" disabled={saving} data-nu-role="commission-save" onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
