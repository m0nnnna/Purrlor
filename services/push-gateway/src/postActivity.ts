/**
 * How a notification about posts reads, or undefined for anything else (a chat message, which gets
 * the usual "Room: text" line instead). A feed room is named after its owner, so these skip the
 * room-name prefix: "Alice: Liked your post" would read wrong when it's your own feed.
 *
 * Who's receiving decides the wording, and the gateway can't see that from the event alone: the
 * web app puts the user ID in the pusher's data, which comes back on every notification. A pusher
 * registered before that has only the `highlight` tweak to go on, which only the mention rule sets.
 */
export function describePostActivity({
  type,
  content,
  recipient,
  highlight,
}: {
  type?: string;
  content?: Record<string, any>;
  recipient?: string;
  highlight: boolean;
}): string | undefined {
  const rawBody = content?.body;
  const text = typeof rawBody === 'string' && rawBody.trim() ? rawBody : '';
  const withText = (verb: string) => (text ? `${verb}: ${text}` : verb);
  const mentioned: unknown = content?.['m.mentions']?.user_ids;
  const mentionsRecipient = recipient ? Array.isArray(mentioned) && mentioned.includes(recipient) : highlight;
  // Tagged in one of its pictures (the web app's matrix/imageTags.ts): said so, rather than "mentioned".
  const attachments: unknown = content?.['xyz.nekous.attachments'];
  const taggedRecipient =
    !!recipient &&
    Array.isArray(attachments) &&
    attachments.some((a) => Array.isArray(a?.tags) && a.tags.some((tag: { user_id?: unknown } | null) => tag?.user_id === recipient));

  if (type === 'xyz.nekous.comment') {
    const repliedTo = content?.['xyz.nekous.reply_to']?.sender;
    // A reply also mentions the person replied to, so it's checked first.
    const isReplyToRecipient = recipient ? repliedTo === recipient : !!repliedTo && highlight;
    if (isReplyToRecipient) return withText('Replied to your comment');
    // A reply in a thread mentions everyone who has written in it (the web app's postInteractions.ts).
    if (mentionsRecipient && typeof content?.['xyz.nekous.thread'] === 'string') return withText('Replied in a thread you’re in');
    if (taggedRecipient) return withText('Tagged you in a photo');
    if (mentionsRecipient) return withText('Mentioned you in a comment');
    return withText('Commented on your post');
  }
  // A post only ever notifies anyone through a mention (no push rule matches posts otherwise).
  if (type === 'xyz.nekous.post') return withText(taggedRecipient ? 'Tagged you in a photo' : 'Mentioned you in a post');
  // Mentioned in a Global post while not in its author's profile room: the mention arrives as an
  // invite to that room, marked in its reason (the web app's matrix/mentionInvites.ts).
  if (type === 'm.room.member' && content?.membership === 'invite' && /\(xyz\.nekous\.mention \$[^\s)]+\)/.test(String(content?.reason ?? ''))) {
    return String(content?.reason).startsWith('Tagged you in a photo') ? 'Tagged you in a photo' : 'Mentioned you in a post';
  }
  if (type === 'm.reaction') return 'Liked your post';
  // Only ever reaches the comment's author, through the mention it carries.
  if (type === 'xyz.nekous.comment_like') return 'Liked your comment';
  return undefined;
}
