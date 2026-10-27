import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AudioCodec,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  VideoCodec,
} from 'livekit-server-sdk';
import type { Replay } from './streams.js';

/**
 * Recording streams with LiveKit Egress (docs/streaming.md, "Recording and replays"): one
 * participant egress of the streamer to one MP4, H.264 720p30 with AAC. That one encode is all the
 * server does per stream. Egress writes into a volume this service shares: Egress sees it at
 * `egressDir`, this service at `dir`.
 */

/** The replay's encoding: plays in every browser, and is what the streamer downloads. */
const REPLAY_ENCODING = new EncodingOptions({
  width: 1280,
  height: 720,
  framerate: 30,
  videoCodec: VideoCodec.H264_MAIN,
  videoBitrate: 2500,
  keyFrameInterval: 4,
  audioCodec: AudioCodec.AAC,
  audioBitrate: 128,
});

export type RecordingResult = { status: 'running' } | { status: 'failed' } | { status: 'done'; replay: Replay };

export class Recorder {
  constructor(
    private readonly egress: EgressClient | undefined,
    readonly dir: string,
    private readonly egressDir: string
  ) {}

  /** Recording is off when STREAM_RECORDING=off, or nothing to record with. */
  get enabled(): boolean {
    return this.egress !== undefined;
  }

  replayPath(id: string): string {
    return join(this.dir, `${id}.mp4`);
  }

  /** Starts recording the streamer; resolves with the egress ID, or undefined when recording is off. */
  async start(roomName: string, identity: string, id: string): Promise<string | undefined> {
    if (!this.egress) return undefined;
    const file = new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath: `${this.egressDir}/${id}.mp4` });
    const info = await this.egress.startParticipantEgress(roomName, identity, { file }, { screenShare: true, encodingOptions: REPLAY_ENCODING });
    return info.egressId;
  }

  /** Stops it; Egress then finishes writing the file, which `result` finds out about. */
  async stop(egressId: string): Promise<void> {
    await this.egress?.stopEgress(egressId).catch((err: unknown) => {
      // Already over (the room went first) is the usual reason, and isn't a fault.
      console.warn(`Recording ${egressId} not stopped: ${(err as Error).message}`);
    });
  }

  /** Whether the file is written: done (with its size and length), still going, or failed. */
  async result(egressId: string, id: string): Promise<RecordingResult> {
    if (!this.egress) return { status: 'failed' };
    const [info] = await this.egress.listEgress({ egressId });
    if (!info) return { status: 'failed' };
    switch (info.status) {
      case EgressStatus.EGRESS_STARTING:
      case EgressStatus.EGRESS_ACTIVE:
      case EgressStatus.EGRESS_ENDING:
        return { status: 'running' };
      case EgressStatus.EGRESS_COMPLETE:
      case EgressStatus.EGRESS_LIMIT_REACHED: {
        const bytes = await stat(this.replayPath(id)).then(
          (s) => s.size,
          () => 0
        );
        if (!bytes) return { status: 'failed' };
        // Durations come in nanoseconds.
        const durationMs = Math.round(Number(info.fileResults[0]?.duration ?? 0n) / 1e6);
        return { status: 'done', replay: { bytes, durationMs } };
      }
      default:
        return { status: 'failed' };
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.replayPath(id), { force: true });
  }
}

/** The recorder this service runs with: Egress through LiveKit's API unless STREAM_RECORDING=off. */
export function recorderFromEnv(livekitUrl: string, apiKey: string, apiSecret: string, env: Record<string, string | undefined>): Recorder {
  const on = (env.STREAM_RECORDING ?? 'on').trim().toLowerCase() !== 'off';
  return new Recorder(on ? new EgressClient(livekitUrl, apiKey, apiSecret) : undefined, env.RECORDINGS_DIR ?? '/recordings', env.RECORDINGS_EGRESS_DIR ?? '/out');
}
