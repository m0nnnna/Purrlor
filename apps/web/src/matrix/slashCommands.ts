import { MsgType, type MatrixClient } from 'matrix-js-sdk';
import { updateDisplayName } from './account';
import { banMember, inviteMember, kickMember, unbanMember } from './moderation';

export type SlashCommandContext = {
  mx: MatrixClient;
  roomId: string;
  threadId: string | null;
  /** Only /leave needs this — Composer clears the app's own room selection afterward, since
   *  leaving doesn't otherwise notify anything holding onto the now-invalid room id. */
  onLeft?: () => void;
};

export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
  execute: (ctx: SlashCommandContext, args: string) => Promise<void>;
};

function requireArg(args: string, usage: string): string {
  const trimmed = args.trim();
  if (!trimmed) throw new Error(`Usage: ${usage}`);
  return trimmed;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'me',
    usage: '/me <action>',
    description: 'Send an emote message',
    execute: async ({ mx, roomId, threadId }, args) => {
      const body = requireArg(args, '/me <action>');
      await mx.sendMessage(roomId, threadId, { msgtype: MsgType.Emote, body });
    },
  },
  {
    name: 'shrug',
    usage: '/shrug [text]',
    description: 'Send ¯\\_(ツ)_/¯, optionally with text',
    execute: async ({ mx, roomId, threadId }, args) => {
      // A real "_" would pair up across "_(ツ)_" and get parsed as this app's own italic
      // markdown, silently eating both underscores — the fullwidth lookalike (＿, U+FF3F) reads
      // as visually identical but isn't the character the markdown patterns match on.
      const shrug = '¯\\＿(ツ)＿/¯';
      const trimmed = args.trim();
      await mx.sendTextMessage(roomId, threadId, trimmed ? `${trimmed} ${shrug}` : shrug);
    },
  },
  {
    name: 'spoiler',
    usage: '/spoiler <text>',
    description: 'Send text hidden until clicked',
    execute: async ({ mx, roomId, threadId }, args) => {
      const text = requireArg(args, '/spoiler <text>');
      // The spoiler markdown (||text||) can't hold a "|" or a line break.
      if (/[|\n]/.test(text)) throw new Error('A spoiler can’t contain “|” or line breaks.');
      await mx.sendTextMessage(roomId, threadId, `||${text}||`);
    },
  },
  {
    name: 'nick',
    usage: '/nick <name>',
    description: 'Change your display name (everywhere, not just this channel)',
    execute: async ({ mx }, args) => {
      await updateDisplayName(mx, requireArg(args, '/nick <name>'));
    },
  },
  {
    name: 'topic',
    usage: '/topic <text>',
    description: 'Set this channel\'s topic',
    execute: async ({ mx, roomId }, args) => {
      await mx.setRoomTopic(roomId, args.trim());
    },
  },
  {
    name: 'invite',
    usage: '/invite <@user:server>',
    description: 'Invite a user to this channel',
    execute: async ({ mx, roomId }, args) => {
      await inviteMember(mx, roomId, requireArg(args, '/invite <@user:server>'));
    },
  },
  {
    name: 'kick',
    usage: '/kick <@user:server> [reason]',
    description: 'Kick a user from this channel',
    execute: async ({ mx, roomId }, args) => {
      const [userId, ...reason] = requireArg(args, '/kick <@user:server> [reason]').split(/\s+/);
      await kickMember(mx, roomId, userId, reason.join(' '));
    },
  },
  {
    name: 'ban',
    usage: '/ban <@user:server> [reason]',
    description: 'Ban a user from this channel',
    execute: async ({ mx, roomId }, args) => {
      const [userId, ...reason] = requireArg(args, '/ban <@user:server> [reason]').split(/\s+/);
      await banMember(mx, roomId, userId, reason.join(' '));
    },
  },
  {
    name: 'unban',
    usage: '/unban <@user:server>',
    description: 'Unban a user',
    execute: async ({ mx, roomId }, args) => {
      await unbanMember(mx, roomId, requireArg(args, '/unban <@user:server>'));
    },
  },
  {
    name: 'leave',
    usage: '/leave',
    description: 'Leave this channel',
    execute: async ({ mx, roomId, onLeft }) => {
      await mx.leave(roomId);
      onLeft?.();
    },
  },
];

export function findSlashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name.toLowerCase());
}

export type ParsedSlashInput = { type: 'command'; name: string; args: string } | { type: 'escaped'; text: string };

/**
 * "//" escapes to a literal message starting with "/" (Discord/Element's own convention) —
 * plenty of real messages legitimately start with a path or a URL fragment, and typing them
 * shouldn't risk accidentally invoking (or erroring on) a command.
 */
export function parseSlashInput(text: string): ParsedSlashInput | null {
  if (text.startsWith('//')) return { type: 'escaped', text: text.slice(1) };
  if (!text.startsWith('/')) return null;
  const spaceIndex = text.indexOf(' ');
  const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1);
  return { type: 'command', name, args };
}
