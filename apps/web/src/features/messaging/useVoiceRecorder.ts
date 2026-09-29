import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_RECORDING_MS, pickRecordingMimeType } from './voiceRecording';

export type VoiceRecorderState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'recording'; elapsedMs: number }
  | { status: 'error'; message: string };

export type RecordedVoiceMessage = { blob: Blob; mimetype: string; durationMs: number };

/** How often the elapsed-time readout (and the cap check) refreshes while recording. */
const TICK_MS = 200;

function permissionErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return 'Microphone access was denied. Allow microphone access in your browser settings to send voice messages.';
    }
    if (err.name === 'NotFoundError') {
      return 'No microphone was found.';
    }
  }
  return 'Could not access the microphone.';
}

/**
 * Drives a single voice-message recording: mic permission request, MediaRecorder capture, a
 * live elapsed-time readout, and a hard stop at MAX_RECORDING_MS. Deliberately exposes just
 * start/stop/cancel — the composer decides what "stop" means (send it), matching the spec's
 * "cancel + send" pair rather than a separate stop control.
 */
export function useVoiceRecorder() {
  const [state, setState] = useState<VoiceRecorderState>({ status: 'idle' });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set just before triggering MediaRecorder.stop(), so the 'onstop' handler (which both a real
  // stop() call and the cap-triggered auto-stop land in) knows whether to resolve a pending
  // stop() promise, stash the result for a later stop() call to pick up (the cap-hit case — see
  // finishedRef), or just clean up quietly (cancel/unmount, where pendingStopRef stays null).
  const pendingStopRef = useRef<{
    resolve: (result: RecordedVoiceMessage | null) => void;
    mimetype: string;
  } | null>(null);
  // Holds a recording that finished on its own (the MAX_RECORDING_MS cap) before the user chose
  // send or cancel — stop() returns this immediately instead of trying to stop an already-
  // inactive MediaRecorder (which would otherwise silently lose the recording).
  const finishedRef = useRef<RecordedVoiceMessage | null>(null);
  // getUserMedia() has no way to cancel an in-flight permission prompt — if cancel() is called
  // while still 'requesting', there's no stream/recorder yet for teardown() to release. This
  // flag tells start()'s continuation to release the stream itself the moment it arrives instead
  // of turning it into an active recording.
  const requestCancelledRef = useRef(false);

  const clearTick = () => {
    if (tickIntervalRef.current !== null) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
  };

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  // Stop everything without resolving a pending stop() — used on unmount and on cancel.
  const teardown = useCallback(() => {
    clearTick();
    pendingStopRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      // No onstop handler races here: teardown() only runs when nothing should be resolved, and
      // the 'onstop' listener bails out early when pendingStopRef is already null (see below).
      recorder.stop();
    }
    releaseStream();
    chunksRef.current = [];
    finishedRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    requestCancelledRef.current = false;
    setState({ status: 'requesting' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (!requestCancelledRef.current) setState({ status: 'error', message: permissionErrorMessage(err) });
      return;
    }

    if (requestCancelledRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const mimeType = pickRecordingMimeType((t) => MediaRecorder.isTypeSupported?.(t) ?? false);
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setState({ status: 'error', message: 'Recording is not supported in this browser.' });
      return;
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    startedAtRef.current = Date.now();

    recorder.ondataavailable = (evt: BlobEvent) => {
      if (evt.data.size > 0) chunksRef.current.push(evt.data);
    };
    recorder.onstop = () => {
      const pending = pendingStopRef.current;
      pendingStopRef.current = null;
      releaseStream();
      if (!pending) return; // torn down via cancel/unmount — nothing to resolve
      const durationMs = Date.now() - startedAtRef.current;
      const blob = new Blob(chunksRef.current, { type: pending.mimetype });
      chunksRef.current = [];
      pending.resolve(blob.size > 0 ? { blob, mimetype: pending.mimetype, durationMs } : null);
    };

    recorder.start();
    setState({ status: 'recording', elapsedMs: 0 });

    tickIntervalRef.current = setInterval(() => {
      const elapsedMs = Date.now() - startedAtRef.current;
      if (elapsedMs >= MAX_RECORDING_MS) {
        clearTick();
        // Cap hit — stop capturing but leave the recording queued to send, same as a manual
        // stop, rather than silently discarding the tail of a long message. The result lands in
        // finishedRef (via onstop, since pendingStopRef.resolve just stashes it there) for a
        // later stop() call to pick up, since nobody's awaiting a stop() promise right now.
        const activeRecorder = recorderRef.current;
        if (activeRecorder?.state === 'recording') {
          pendingStopRef.current = {
            resolve: (result) => {
              finishedRef.current = result;
            },
            mimetype: activeRecorder.mimeType || 'audio/webm',
          };
          activeRecorder.stop();
        }
        setState((s) => (s.status === 'recording' ? { status: 'recording', elapsedMs: MAX_RECORDING_MS } : s));
        return;
      }
      setState({ status: 'recording', elapsedMs });
    }, TICK_MS);
  }, []);

  /** Stops capturing and resolves with the recorded blob (or null if nothing was captured). */
  const stop = useCallback((): Promise<RecordedVoiceMessage | null> => {
    clearTick();
    const recorder = recorderRef.current;
    if (!recorder) return Promise.resolve(finishedRef.current);
    if (recorder.state === 'inactive') {
      // Already finalized (the MAX_RECORDING_MS cap stopped it) — hand back what's waiting.
      const finished = finishedRef.current;
      finishedRef.current = null;
      return Promise.resolve(finished);
    }
    const mimetype = recorder.mimeType || 'audio/webm';
    return new Promise((resolve) => {
      pendingStopRef.current = { resolve, mimetype };
      recorder.stop();
    });
  }, []);

  /** Discards the in-progress recording (or in-flight permission request) without sending. */
  const cancel = useCallback(() => {
    requestCancelledRef.current = true;
    teardown();
    setState({ status: 'idle' });
  }, [teardown]);

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  return { state, start, stop, cancel, reset };
}
