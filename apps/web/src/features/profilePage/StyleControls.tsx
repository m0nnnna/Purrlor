import {
  BACKGROUND_FITS,
  LIMITS,
  PAGE_BORDERS,
  PAGE_EFFECTS,
  PAGE_FONTS,
  readableTextOn,
  type BackgroundFit,
  type PageBorder,
  type PageColors,
  type PageEffect,
  type PageFont,
  type PageStyle,
} from '../../matrix/profilePage';
import { readabilityProblems, STARTER_PAGES } from './editorModel';
import { ImagePicker, ImageThumb } from './ImagePicker';
import { FONTS } from './pageStyle';

const COLOR_LABELS: Record<keyof PageColors, string> = {
  bg: 'Background',
  text: 'Text',
  accent: 'Accent',
  link: 'Links',
  block: 'Blocks',
};

const BORDER_LABELS: Record<PageBorder, string> = { none: 'None', solid: 'Solid', dashed: 'Dashed', double: 'Double', glow: 'Glow' };
const EFFECT_LABELS: Record<PageEffect, string> = { none: 'None', sparkles: 'Sparkles', snow: 'Snow', hearts: 'Hearts', stars: 'Stars' };
const FIT_LABELS: Record<BackgroundFit, string> = { cover: 'Fill the page', tile: 'Tile', fixed: 'Fill, stay put while scrolling' };

function ColorField({ label, value, onChange, role }: { label: string; value: string; onChange: (value: string) => void; role: string }) {
  return (
    <label className="nu-page-editor__color">
      <input type="color" value={value} onChange={(evt) => onChange(evt.target.value.toLowerCase())} data-nu-role={role} />
      {label}
    </label>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
  role,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
  role: string;
}) {
  return (
    <label className="nu-field">
      {label}
      <select className="nu-field__input" value={value} onChange={(evt) => onChange(evt.target.value as T)} data-nu-role={role}>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

const FONT_LABELS = Object.fromEntries(PAGE_FONTS.map((font) => [font, FONTS[font].label])) as Record<PageFont, string>;

/** The page-wide look: starting point, colours, background, fonts, block look, layout, effect. */
export function StyleControls({ style, onChange }: { style: PageStyle; onChange: (style: PageStyle) => void }) {
  const set = (patch: Partial<PageStyle>) => onChange({ ...style, ...patch });
  const setColor = (key: keyof PageColors, value: string) => set({ colors: { ...style.colors, [key]: value } });
  const problems = readabilityProblems(style);
  const background = style.background;

  return (
    <div className="nu-page-editor__section" data-nu-role="page-editor-style">
      <h3 className="nu-page-editor__heading">Start from</h3>
      <div className="nu-page-editor__starters">
        {STARTER_PAGES.map((starter) => (
          <button
            key={starter.id}
            type="button"
            className="nu-page-editor__starter"
            style={{ background: starter.style.colors.bg, color: starter.style.colors.text, borderColor: starter.style.colors.accent }}
            onClick={() => onChange(structuredClone(starter.style))}
            data-nu-role={`page-editor-starter-${starter.id}`}
          >
            {starter.label}
          </button>
        ))}
      </div>

      <h3 className="nu-page-editor__heading">Colours</h3>
      <div className="nu-page-editor__colors">
        {(Object.keys(COLOR_LABELS) as (keyof PageColors)[]).map((key) => (
          <ColorField
            key={key}
            label={COLOR_LABELS[key]}
            value={style.colors[key]}
            onChange={(value) => setColor(key, value)}
            role={`page-editor-color-${key}`}
          />
        ))}
      </div>
      {problems.length > 0 && (
        <p className="nu-field__warning" data-nu-role="page-editor-contrast">
          Your text is hard to read on {problems.includes('blocks') ? 'the blocks' : 'the background'}.{' '}
          <button
            type="button"
            className="nu-page-editor__inline-button"
            onClick={() => setColor('text', readableTextOn(problems.includes('blocks') ? style.colors.block : style.colors.bg))}
          >
            Fix it
          </button>
        </p>
      )}

      <h3 className="nu-page-editor__heading">Background</h3>
      <div className="nu-page-editor__radios" role="radiogroup" aria-label="Background">
        {(['color', 'gradient', 'image'] as const).map((kind) => (
          <label key={kind} className="nu-field__checkbox-row">
            <input
              type="radio"
              name="page-background"
              checked={background.kind === kind}
              // An image background starts from an upload, below.
              disabled={kind === 'image' && background.kind !== 'image'}
              onChange={() =>
                set({
                  background:
                    kind === 'gradient'
                      ? { kind, from: style.colors.bg, to: style.colors.accent, angle: 180 }
                      : kind === 'image'
                        ? background.kind === 'image'
                          ? background
                          : { kind: 'color' }
                        : { kind: 'color' },
                })
              }
              data-nu-role={`page-editor-background-${kind}`}
            />
            {kind === 'color' ? 'Colour' : kind === 'gradient' ? 'Gradient' : 'Image or GIF'}
          </label>
        ))}
      </div>
      {background.kind === 'gradient' && (
        <div className="nu-page-editor__row">
          <ColorField
            label="From"
            value={background.from}
            onChange={(from) => set({ background: { ...background, from } })}
            role="page-editor-gradient-from"
          />
          <ColorField
            label="To"
            value={background.to}
            onChange={(to) => set({ background: { ...background, to } })}
            role="page-editor-gradient-to"
          />
          <label className="nu-field">
            Angle {background.angle}°
            <input
              type="range"
              min={0}
              max={359}
              value={background.angle}
              onChange={(evt) => set({ background: { ...background, angle: Number(evt.target.value) } })}
            />
          </label>
        </div>
      )}
      <div className="nu-page-editor__row">
        {background.kind === 'image' && <ImageThumb mxc={background.url} />}
        <ImagePicker
          label={background.kind === 'image' ? 'Change image…' : 'Upload a background…'}
          onUploaded={([url]) => set({ background: { kind: 'image', url, fit: background.kind === 'image' ? background.fit : 'cover' } })}
        />
      </div>
      {background.kind === 'image' && (
        <Select
          label="How it fits"
          value={background.fit}
          options={BACKGROUND_FITS}
          labels={FIT_LABELS}
          onChange={(fit) => set({ background: { ...background, fit } })}
          role="page-editor-background-fit"
        />
      )}

      <h3 className="nu-page-editor__heading">Fonts</h3>
      <div className="nu-page-editor__row">
        <Select
          label="Headings"
          value={style.fonts.heading}
          options={PAGE_FONTS}
          labels={FONT_LABELS}
          onChange={(heading) => set({ fonts: { ...style.fonts, heading } })}
          role="page-editor-font-heading"
        />
        <Select
          label="Text"
          value={style.fonts.body}
          options={PAGE_FONTS}
          labels={FONT_LABELS}
          onChange={(body) => set({ fonts: { ...style.fonts, body } })}
          role="page-editor-font-body"
        />
      </div>

      <h3 className="nu-page-editor__heading">Blocks</h3>
      <label className="nu-field">
        Corners: {style.corners}px
        <input
          type="range"
          min={0}
          max={LIMITS.corners}
          value={style.corners}
          onChange={(evt) => set({ corners: Number(evt.target.value) })}
          data-nu-role="page-editor-corners"
        />
      </label>
      <label className="nu-field">
        See-through: {Math.round((1 - style.blockOpacity) * 100)}%
        <input
          type="range"
          min={Math.round(LIMITS.minBlockOpacity * 100)}
          max={100}
          value={Math.round(style.blockOpacity * 100)}
          // Reversed so "more" means more see-through, which is what the label says.
          style={{ direction: 'rtl' }}
          onChange={(evt) => set({ blockOpacity: Number(evt.target.value) / 100 })}
          data-nu-role="page-editor-opacity"
        />
      </label>
      <div className="nu-page-editor__row">
        <Select
          label="Border"
          value={style.border}
          options={PAGE_BORDERS}
          labels={BORDER_LABELS}
          onChange={(border) => set({ border })}
          role="page-editor-border"
        />
        {style.border !== 'none' && (
          <ColorField
            label="Border colour"
            value={style.borderColor}
            onChange={(borderColor) => set({ borderColor })}
            role="page-editor-border-color"
          />
        )}
      </div>

      <h3 className="nu-page-editor__heading">Layout and effects</h3>
      <div className="nu-page-editor__row">
        <Select
          label="Columns"
          value={String(style.columns) as '1' | '2'}
          options={['1', '2'] as const}
          labels={{ '1': 'One column', '2': 'Two on wide screens' }}
          onChange={(columns) => set({ columns: columns === '2' ? 2 : 1 })}
          role="page-editor-columns"
        />
        <Select
          label="Effect"
          value={style.effect}
          options={PAGE_EFFECTS}
          labels={EFFECT_LABELS}
          onChange={(effect) => set({ effect })}
          role="page-editor-effect"
        />
      </div>
    </div>
  );
}
