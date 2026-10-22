import type { MatrixEvent } from 'matrix-js-sdk';

/** The `m.in_reply_to` target of a quote-reply, if this event is one — Matrix's reply relation
 *  predates the newer `rel_type`-based ones (edits, threads, reactions) and lives at
 *  `m.relates_to.m.in_reply_to.event_id` instead. No plain-text/HTML fallback body is sent
 *  alongside it (see matrix/replies.ts's buildReplyRelation) — a deliberate scope cut like the
 *  rest of this app's Matrix-feature narrowing: clients without reply support just won't show
 *  the quoted context, which is an acceptable tradeoff for a Purrlor-authored message. */
export function getReplyEventId(event: MatrixEvent): string | undefined {
  return event.getContent()?.['m.relates_to']?.['m.in_reply_to']?.event_id;
}

export function buildReplyRelation(eventId: string): { 'm.in_reply_to': { event_id: string } } {
  return { 'm.in_reply_to': { event_id: eventId } };
}

/** Who a reply mentions: whoever wrote the message replied to, unless that's you. Sent in
 *  `m.mentions`, it notifies them the same way an @mention does (the spec's
 *  `.m.rule.is_user_mention`), which is also what the spec asks of a reply. */
export function replyMentions(target: Pick<ReplyTarget, 'senderId'>, myUserId: string | null): string[] {
  return target.senderId && target.senderId !== myUserId ? [target.senderId] : [];
}

/** The content keys that make an event a reply to `target`, mention included (see replyMentions). */
export function buildReplyContent(
  target: Pick<ReplyTarget, 'eventId' | 'senderId'>,
  myUserId: string | null
): { 'm.relates_to': { 'm.in_reply_to': { event_id: string } }; 'm.mentions'?: { user_ids: string[] } } {
  const mentioned = replyMentions(target, myUserId);
  return { 'm.relates_to': buildReplyRelation(target.eventId), ...(mentioned.length > 0 && { 'm.mentions': { user_ids: mentioned } }) };
}

/** What the composer needs to know about the message being replied to — set from a timeline
 *  row's "Reply" action, cleared once the reply actually sends (see MainPane.tsx). */
export type ReplyTarget = {
  eventId: string;
  /** Who wrote it, so the reply can mention them. */
  senderId?: string;
  senderName: string;
  preview: string;
};
