import { useEffect, useState, type FormEvent } from 'react';
import { RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { createWebhook, deleteWebhook, listWebhooks, setWebhookAvatar, WEBHOOK_EVENT, webhookService } from '../../matrix/webhooks';
import { Avatar } from '../../components/Avatar';
import './WebhooksModal.css';

/**
 * A channel's webhooks (matrix/webhooks.ts): the ones it has, a new one, and deleting one. A new
 * webhook's URL is shown once, here: only a hash of its token is stored anywhere.
 */
export function WebhooksModal({ channel, space, onClose }: { channel: Room; space: Room; onClose: () => void }) {
  const mx = useMatrixClient();
  const [, setVersion] = useState(0);
  const [name, setName] = useState('');
  const [newAvatar, setNewAvatar] = useState<File>();
  const [avatarBusy, setAvatarBusy] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const service = webhookService(mx, space);

  useEffect(() => {
    const onState = (event: MatrixEvent) => {
      if (event.getRoomId() === channel.roomId && event.getType() === WEBHOOK_EVENT) setVersion((v) => v + 1);
    };
    mx.on(RoomStateEvent.Events, onState);
    return () => {
      mx.removeListener(RoomStateEvent.Events, onState);
    };
  }, [mx, channel]);

  const webhooks = listWebhooks(channel);

  const handleCreate = async (evt: FormEvent) => {
    evt.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(undefined);
    try {
      setCreatedUrl(await createWebhook(mx, channel, space, name, newAvatar));
      setName('');
      setNewAvatar(undefined);
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t create the webhook');
    } finally {
      setCreating(false);
    }
  };

  const changeAvatar = async (webhookId: string, file: File | undefined) => {
    setAvatarBusy(webhookId);
    setError(undefined);
    try {
      await setWebhookAvatar(mx, channel, webhookId, file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t change the avatar');
    } finally {
      setAvatarBusy(undefined);
    }
  };

  const copy = async () => {
    if (!createdUrl) return;
    await navigator.clipboard.writeText(createdUrl).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  };

  return (
    <Modal title={`Webhooks for #${channel.name}`} onClose={onClose}>
      <div className="nu-modal-form" data-nu-role="webhooks">
        <p className="nu-field__hint">
          A webhook lets another service — CI, monitoring, a GitHub integration — post into this channel with one HTTP request. It
          accepts Discord’s <code>{'{ "content": "…", "username": "…" }'}</code> and Slack’s <code>{'{ "text": "…" }'}</code>.
          Its messages are marked APP and don’t notify anyone.
        </p>
        {!service && (
          <p className="nu-field__error">Webhooks go through this Space’s voice server, which isn’t set up (Space Settings → General).</p>
        )}

        {createdUrl && (
          <div className="nu-field" data-nu-role="webhook-created">
            <strong>Copy this URL now — it won’t be shown again.</strong>
            <input className="nu-field__input" data-nu-role="webhook-url" readOnly value={createdUrl} onFocus={(e) => e.target.select()} />
            <div className="nu-form-actions">
              <button type="button" className="nu-button nu-button--secondary" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy URL'}
              </button>
            </div>
          </div>
        )}

        {webhooks.length > 0 && (
          <ul className="nu-webhooks__list" data-nu-role="webhook-list">
            {webhooks.map((webhook) => (
              <li key={webhook.id} className="nu-webhooks__item" data-nu-role="webhook">
                <Avatar name={webhook.name} mxcUrl={webhook.avatarUrl} size={32} />
                <span className="nu-webhooks__item-text">
                  <strong>{webhook.name}</strong>
                  <span className="nu-field__hint"> · made by {space.getMember(webhook.createdBy)?.name ?? webhook.createdBy}</span>
                </span>
                <label className="nu-button nu-button--secondary nu-file-picker" data-nu-role="webhook-avatar-picker">
                  {avatarBusy === webhook.id ? 'Uploading…' : webhook.avatarUrl ? 'Change avatar' : 'Add avatar'}
                  <input
                    type="file"
                    accept="image/*"
                    data-nu-role="webhook-avatar"
                    disabled={avatarBusy === webhook.id}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void changeAvatar(webhook.id, file);
                    }}
                  />
                </label>
                {webhook.avatarUrl && (
                  <button
                    type="button"
                    className="nu-button nu-button--secondary"
                    data-nu-role="webhook-avatar-remove"
                    disabled={avatarBusy === webhook.id}
                    onClick={() => void changeAvatar(webhook.id, undefined)}
                  >
                    Remove avatar
                  </button>
                )}
                <button
                  type="button"
                  className="nu-button nu-button--danger"
                  data-nu-role="webhook-delete"
                  onClick={() => void deleteWebhook(mx, channel, webhook.id).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Couldn’t delete it'))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        {service && (
          <form onSubmit={handleCreate} className="nu-webhooks__create">
            <label className="nu-field">
              New webhook’s name
              <input
                className="nu-field__input"
                data-nu-role="webhook-name"
                value={name}
                placeholder="GitHub, Deploys, Uptime…"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="nu-button nu-button--secondary nu-file-picker">
              {newAvatar ? newAvatar.name : 'Choose an avatar (optional)'}
              <input type="file" accept="image/*" data-nu-role="webhook-new-avatar" onChange={(e) => setNewAvatar(e.target.files?.[0])} />
            </label>
            <div className="nu-form-actions">
              <button type="submit" className="nu-button nu-button--primary" data-nu-role="webhook-create" disabled={creating || !name.trim()}>
                {creating ? 'Creating…' : 'Create webhook'}
              </button>
            </div>
          </form>
        )}
        {error && <p className="nu-field__error">{error}</p>}
      </div>
    </Modal>
  );
}
