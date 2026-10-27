import { EventType, type IEvent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';

/**
 * Keeps deleted encrypted messages from showing as "[unable to decrypt]".
 *
 * A server hands out a deleted (redacted) event with its content pruned, which for an encrypted
 * message leaves `{}`, and says why in `unsigned.redacted_because`. Some servers (Continuwuity, for
 * a remote user's message deleted later, at least) leave that out. matrix-js-sdk then takes the event
 * for a live encrypted message and tries to decrypt it, which fails on the missing `algorithm` every
 * time the event is loaded again ("DecryptionError[msg: missing field `algorithm`]").
 *
 * An encrypted message with no algorithm can't be decrypted by anyone, and a server only sends one
 * like that once it has pruned it. So before the SDK tries, it's marked redacted, as the server
 * should have: the SDK then skips decrypting it (MatrixEvent.shouldAttemptDecryption) and the
 * timeline hides it like any deleted message.
 */
export function isPrunedEncryptedEvent(event: MatrixEvent): boolean {
  return event.getType() === EventType.RoomMessageEncrypted && !event.isRedacted() && !event.getWireContent().algorithm;
}

/** Marks a pruned encrypted event redacted. Who deleted it isn't known, so the stand-in redaction names the sender. */
export function markPrunedRedacted(event: MatrixEvent): void {
  const eventId = event.getId();
  const because: Partial<IEvent> = {
    type: EventType.RoomRedaction,
    sender: event.getSender(),
    room_id: event.getRoomId(),
    origin_server_ts: event.getTs(),
    redacts: eventId,
    content: { redacts: eventId },
    unsigned: {},
  };
  event.event.unsigned = { ...event.event.unsigned, redacted_because: because as IEvent };
}

/** Every decryption goes through the client's decryptEventIfNeeded (the SDK's own event mapper too), so it's caught there. */
export function installPrunedEncryptedGuard(mx: MatrixClient): void {
  const decrypt = mx.decryptEventIfNeeded.bind(mx);
  mx.decryptEventIfNeeded = (event, options) => {
    if (isPrunedEncryptedEvent(event)) markPrunedRedacted(event);
    return decrypt(event, options);
  };
}
