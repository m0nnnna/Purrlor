import { useRef, useState } from 'react';
import { useVoiceCall } from './voiceCallContext';
import { useSharedWatchTogether } from './watchTogetherContext';
import { mediaTitle, sessionMode } from './watchTogether';
import { MediaPlayer, SharedMediaControls, YoutubePlayer } from './WatchTogetherPlayer';
import { readListenVolume, saveListenVolume } from './listenVolume';
import './NowPlayingCard.css';

/**
 * Listen together's home: a compact card beside the call bar, there whichever channel is open,
 * so music keeps playing while you chat. Everyone hears the same thing at the same point; play,
 * pause, seek and stop are shared, and volume is yours alone.
 *
 * A YouTube link shows a small player rather than none: YouTube's API terms forbid separating a
 * video's audio from its picture, and embeds must be at least 200×200. A direct audio file has
 * no picture to show.
 */
export function NowPlayingCard() {
  const session = useSharedWatchTogether();
  const deafened = useVoiceCall()?.deafened ?? false;
  const [volume, setVolume] = useState(readListenVolume);
  const [youtubeTitle, setYoutubeTitle] = useState<string>();
  const getInfoRef = useRef<() => { position: number; duration: number }>(() => ({ position: 0, duration: 0 }));

  const state = session?.state;
  if (!session || !state || sessionMode(state) !== 'listen') return null;

  const audio = { volume, muted: deafened };
  const register = (fn: () => { position: number; duration: number }) => (getInfoRef.current = fn);
  const isYoutube = state.kind === 'youtube' && !!state.videoId;
  const title = isYoutube ? (youtubeTitle ?? 'YouTube') : mediaTitle(state.url);

  const changeVolume = (next: number) => {
    setVolume(next);
    saveListenVolume(next);
  };

  return (
    <section className="nu-now-playing" data-nu-role="now-playing" aria-label="Listening together">
      <header className="nu-now-playing__header">
        <span className="nu-now-playing__label">Listening together</span>
        <span className="nu-now-playing__title" data-nu-role="now-playing-title" title={title}>
          {title}
        </span>
      </header>
      {isYoutube ? (
        <YoutubePlayer
          key={state.videoId}
          state={state}
          videoId={state.videoId!}
          registerPlaybackInfo={register}
          audio={audio}
          onTitle={setYoutubeTitle}
          compact
        />
      ) : (
        <MediaPlayer key={state.url} state={state} registerPlaybackInfo={register} audio={audio} audioOnly />
      )}
      <SharedMediaControls
        state={state}
        controls={session}
        getInfo={() => getInfoRef.current()}
        stopLabel="Stop listening together"
      />
      <label className="nu-now-playing__volume">
        <span>{deafened ? 'Deafened' : 'Your volume'}</span>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.05}
          value={volume}
          disabled={deafened}
          data-nu-role="now-playing-volume"
          aria-label="Your volume for music"
          onChange={(e) => changeVolume(Number(e.target.value))}
        />
      </label>
    </section>
  );
}
