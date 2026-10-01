import { useState, type ChangeEvent } from 'react';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { MUSIC_ACCEPT, uploadTrack } from '../../matrix/musicTracks';
import type { MusicTrack } from '../../matrix/profilePage';

/**
 * "Add tracks…" for a music block: uploads each file straight away (one at a time, so a big one
 * doesn't compete with the next) and hands back the tracks. A file that can't be added says why and
 * the rest still go up.
 */
export function AudioPicker({
  max,
  disabled = false,
  onUploaded,
}: {
  max: number;
  disabled?: boolean;
  onUploaded: (tracks: MusicTrack[]) => void;
}) {
  const mx = useMatrixClient();
  const [busy, setBusy] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);

  const onChange = async (evt: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(evt.target.files ?? []);
    evt.target.value = '';
    if (files.length === 0) return;
    const problems: string[] = [];
    if (files.length > max) problems.push(`Room for ${max} more track${max === 1 ? '' : 's'}; the rest weren’t added.`);
    const tracks: MusicTrack[] = [];
    for (const file of files.slice(0, Math.max(0, max))) {
      setBusy(file.name);
      try {
        tracks.push(await uploadTrack(mx, file));
      } catch (err) {
        problems.push(err instanceof Error ? err.message : `${file.name} couldn’t be uploaded.`);
      }
    }
    setBusy(undefined);
    setErrors(problems);
    if (tracks.length > 0) onUploaded(tracks);
  };

  return (
    <span className="nu-page-editor__picker">
      <label className={`nu-button nu-button--secondary nu-file-picker${disabled || busy ? ' nu-page-editor__disabled' : ''}`}>
        {busy ? `Uploading ${busy}…` : 'Add tracks…'}
        <input
          type="file"
          accept={MUSIC_ACCEPT}
          multiple
          disabled={disabled || !!busy}
          data-nu-role="page-editor-add-tracks"
          onChange={(evt) => void onChange(evt)}
        />
      </label>
      {errors.map((message) => (
        <span key={message} className="nu-field__error">
          {message}
        </span>
      ))}
    </span>
  );
}
