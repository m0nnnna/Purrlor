/**
 * The desktop app's own UI around the Purrlor page: the title bar, the first-run connect screen,
 * loading and error screens, and modals over the page (change server, the screen-share picker,
 * a one-time notice). The main process owns the state (src/main/app.ts) and sends all of it on
 * every change; this only draws it and reports clicks.
 */
import type { Modal, PickerSource, ShellApi, ShellState } from '../shared/types';

const api = (window as unknown as { purrlor: ShellApi }).purrlor;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ICONS = {
  offline:
    '<svg viewBox="0 0 24 24"><path d="M2 8.8a15 15 0 0 1 4.2-2.6M10 5.1A15 15 0 0 1 22 8.8M5 12.5a10 10 0 0 1 3.5-2.2M15.6 10.4A10 10 0 0 1 19 12.5M8.5 16.1a5 5 0 0 1 7 0M12 20h.01M3 3l18 18"/></svg>',
  crashed:
    '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/></svg>',
  sparkle:
    '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
  screen: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12"/><path d="M8 20h8M12 16v4"/></svg>',
};

let state: ShellState | null = null;
let modalKey = '';
let loadingSlowTimer: number | undefined;
let retryTimer: number | undefined;
let retryAttempt = 0;

api.onState((next) => {
  const previous = state;
  state = next;
  render(previous, next);
});

api.onDrawBadge(({ id, count }) => void drawBadge(id, count));

// ---- Rendering ------------------------------------------------------------------------------------

function render(prev: ShellState | null, s: ShellState): void {
  document.body.classList.toggle('is-blurred', !s.focused);
  document.body.classList.toggle('is-fullscreen', s.fullscreen);
  document.body.dataset.platform = s.platform;

  $('title').textContent = s.view === 'page' && s.title !== 'Purrlor' ? s.title : '';

  const serverPill = $('server-pill');
  serverPill.hidden = !s.server || s.view === 'connect';
  $('server-name').textContent = s.server?.name ?? '';
  $('server-dot').className = `pill__dot${s.view === 'loading' ? ' is-connecting' : s.view === 'error' || s.view === 'crashed' ? ' is-down' : ''}`;

  const updatePill = $('update-pill');
  updatePill.hidden = s.update.state !== 'ready';
  $('update-pill-text').textContent = `Restart to update${s.update.version ? ` to ${s.update.version}` : ''}`;

  $('screen-loading').hidden = s.view !== 'loading';
  $('screen-connect').hidden = s.view !== 'connect';
  $('screen-error').hidden = s.view !== 'error' && s.view !== 'crashed';

  if (s.view === 'loading') {
    $('loading-server').textContent = s.server?.name ?? '';
    if (prev?.view !== 'loading') {
      $('loading-slow').hidden = true;
      window.clearTimeout(loadingSlowTimer);
      loadingSlowTimer = window.setTimeout(() => ($('loading-slow').hidden = false), 12_000);
    }
  } else window.clearTimeout(loadingSlowTimer);

  if (s.view === 'connect' && (prev?.view !== 'connect' || !$('connect-home').firstChild)) {
    mountConnectForm($('connect-home'), { cancellable: false, current: null });
  }

  renderError(prev, s);
  renderModal(s);

  const backdrop = $<HTMLImageElement>('backdrop');
  if (s.backdrop && s.modal) {
    if (backdrop.getAttribute('src') !== s.backdrop) backdrop.src = s.backdrop;
    backdrop.hidden = false;
  } else {
    backdrop.hidden = true;
    backdrop.removeAttribute('src');
  }
}

function renderError(prev: ShellState | null, s: ShellState): void {
  const showing = s.view === 'error' || s.view === 'crashed';
  if (!showing) {
    window.clearInterval(retryTimer);
    retryTimer = undefined;
    if (s.view === 'page') retryAttempt = 0;
    return;
  }
  const crashed = s.view === 'crashed';
  $('error-icon').innerHTML = crashed ? ICONS.crashed : ICONS.offline;
  $('error-title').textContent = s.error?.title ?? 'Something went wrong';
  $('error-detail').textContent = s.error?.detail ?? '';
  $('error-retry').textContent = crashed ? 'Reload' : 'Try again';
  if (prev?.view === s.view) return;

  // Couldn't reach the server: keep trying, backing off, and straight away when the network's back.
  window.clearInterval(retryTimer);
  const countdown = $('error-countdown');
  countdown.textContent = '';
  if (crashed) return;
  const delays = [5, 10, 20, 30];
  let left = delays[Math.min(retryAttempt, delays.length - 1)];
  retryAttempt++;
  const tick = () => {
    if (!navigator.onLine) {
      countdown.textContent = 'Waiting for your network…';
      return;
    }
    countdown.textContent = `Trying again in ${left}s`;
    if (left-- <= 0) {
      window.clearInterval(retryTimer);
      countdown.textContent = 'Trying again…';
      api.retry();
    }
  };
  tick();
  retryTimer = window.setInterval(tick, 1000);
}

window.addEventListener('online', () => {
  if (state?.view === 'error') api.retry();
});

function keyOf(modal: Modal | null): string {
  if (!modal) return '';
  if (modal.kind === 'picker') return `picker:${modal.sources.map((s) => s.id).join(',')}`;
  if (modal.kind === 'notice') return `notice:${modal.title}`;
  return modal.kind;
}

function renderModal(s: ShellState): void {
  const key = keyOf(s.modal);
  const root = $('modal');
  root.hidden = !s.modal;
  if (key === modalKey) return;
  modalKey = key;
  const card = $('modal-card');
  card.className = 'modal__card';
  card.replaceChildren();
  if (!s.modal) return;
  if (s.modal.kind === 'connect') {
    mountConnectForm(card, { cancellable: true, current: s.server?.name ?? null });
  } else if (s.modal.kind === 'picker') {
    card.classList.add('modal__card--wide');
    mountPicker(card, s.modal.sources, s.modal.audio);
  } else {
    mountNotice(card, s.modal.title, s.modal.body);
  }
}

// ---- Connect -------------------------------------------------------------------------------------

function mountConnectForm(host: HTMLElement, opts: { cancellable: boolean; current: string | null }): void {
  const template = $<HTMLTemplateElement>('connect-form');
  const form = (template.content.firstElementChild as HTMLFormElement).cloneNode(true) as HTMLFormElement;
  host.replaceChildren(form);

  const input = form.querySelector<HTMLInputElement>('input[name=address]')!;
  const control = form.querySelector<HTMLElement>('.field__control')!;
  const status = form.querySelector<HTMLElement>('.connect__status')!;
  const submit = form.querySelector<HTMLButtonElement>('.connect__submit')!;
  const submitLabel = form.querySelector<HTMLElement>('.connect__submit-label')!;
  const cancel = form.querySelector<HTMLButtonElement>('.connect__cancel')!;
  cancel.hidden = !opts.cancellable;
  if (opts.cancellable) form.querySelector('.connect__heading')!.textContent = 'Change server';

  input.value = opts.current ?? 'purr.meowops.net';
  // Pasting a whole address works too: the https:// is already shown in front.
  input.addEventListener('input', () => {
    if (/^https?:\/\//i.test(input.value)) input.value = input.value.replace(/^https:\/\//i, '');
    reset();
  });

  let confirmed: string | null = null;
  const reset = () => {
    confirmed = null;
    control.classList.remove('is-invalid');
    status.className = 'connect__status';
    status.replaceChildren();
    submit.className = 'button button--primary connect__submit';
    submitLabel.textContent = 'Connect';
  };

  form.querySelectorAll<HTMLButtonElement>('[data-suggest]').forEach((chip) =>
    chip.addEventListener('click', () => {
      input.value = chip.dataset.suggest!;
      reset();
      input.focus();
    })
  );
  cancel.addEventListener('click', () => api.cancelModal());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (confirmed) {
      api.connect(confirmed);
      return;
    }
    reset();
    submit.disabled = true;
    input.disabled = true;
    submit.classList.add('is-busy');
    submitLabel.textContent = 'Checking…';
    const result = await api.probe(input.value);
    submit.disabled = false;
    input.disabled = false;
    submit.classList.remove('is-busy');
    submitLabel.textContent = 'Connect';
    if (!result.ok) {
      control.classList.add('is-invalid');
      status.className = 'connect__status is-error';
      status.textContent = result.error;
      input.focus();
      return;
    }
    if (!result.problem) {
      status.textContent = `Connecting to ${result.name}…`;
      api.connect(result.origin);
      return;
    }
    // Reachable but not obviously Purrlor: say why, and let them go ahead anyway.
    confirmed = result.origin;
    const warning = document.createElement('div');
    warning.className = 'warning';
    warning.innerHTML = ICONS.warning;
    const text = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = `${result.name} might not be a Purrlor server`;
    text.append(strong, document.createTextNode(result.problem));
    warning.append(text);
    status.replaceChildren(warning);
    submit.className = 'button button--warning connect__submit';
    submitLabel.textContent = 'Connect anyway';
  });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

// ---- Screen share picker -------------------------------------------------------------------------

function mountPicker(card: HTMLElement, sources: PickerSource[], offerAudio: boolean): void {
  const screens = sources.filter((s) => s.kind === 'screen');
  const windows = sources.filter((s) => s.kind === 'window');
  let tab: 'screen' | 'window' = screens.length > 0 ? 'screen' : 'window';
  let selected: string | null = (tab === 'screen' ? screens : windows)[0]?.id ?? null;

  card.innerHTML = `
    <div class="picker__head">
      <div>
        <h2 class="picker__title">Share your screen</h2>
        <p class="picker__sub">Choose what everyone in the call sees.</p>
      </div>
      <div class="tabs" role="tablist">
        <button class="tab" type="button" role="tab" data-tab="screen">Screens<span class="tab__count">${screens.length}</span></button>
        <button class="tab" type="button" role="tab" data-tab="window">Windows<span class="tab__count">${windows.length}</span></button>
      </div>
    </div>
    <div class="picker__grid" role="listbox"></div>
    <div class="picker__foot">
      <label class="toggle" ${offerAudio ? '' : 'hidden'}>
        <input type="checkbox" class="picker__audio" />
        <span class="toggle__track"></span>
        Also share your computer’s sound
      </label>
      <span ${offerAudio ? 'hidden' : ''}></span>
      <div class="button-row">
        <button class="button button--secondary picker__cancel" type="button">Cancel</button>
        <button class="button button--primary picker__share" type="button">Share</button>
      </div>
    </div>`;

  const grid = card.querySelector<HTMLElement>('.picker__grid')!;
  const shareButton = card.querySelector<HTMLButtonElement>('.picker__share')!;
  const audio = card.querySelector<HTMLInputElement>('.picker__audio')!;
  const share = () => selected && api.choosePickerSource(selected, offerAudio && audio.checked);

  const draw = () => {
    card.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === tab));
    const list = tab === 'screen' ? screens : windows;
    grid.replaceChildren();
    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'picker__empty';
      empty.textContent = tab === 'screen' ? 'No screens to share.' : 'No windows to share.';
      grid.append(empty);
    }
    for (const source of list) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `source${source.id === selected ? ' is-selected' : ''}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(source.id === selected));
      const thumb = document.createElement('div');
      thumb.className = 'source__thumb';
      if (source.thumbnail) {
        const img = document.createElement('img');
        img.src = source.thumbnail;
        img.alt = '';
        thumb.append(img);
      } else thumb.innerHTML = ICONS.screen;
      const label = document.createElement('div');
      label.className = 'source__label';
      if (source.icon) {
        const icon = document.createElement('img');
        icon.src = source.icon;
        icon.alt = '';
        label.append(icon);
      }
      const name = document.createElement('span');
      name.textContent = source.kind === 'screen' && /^(entire screen|screen \d+)$/i.test(source.name) ? prettyScreen(source.name, screens) : source.name;
      name.title = source.name;
      label.append(name);
      item.append(thumb, label);
      item.addEventListener('click', () => {
        selected = source.id;
        draw();
      });
      item.addEventListener('dblclick', () => {
        selected = source.id;
        share();
      });
      grid.append(item);
    }
    shareButton.disabled = !selected || !list.some((s) => s.id === selected);
  };

  card.querySelectorAll<HTMLElement>('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      tab = t.dataset.tab as 'screen' | 'window';
      const list = tab === 'screen' ? screens : windows;
      if (!list.some((s) => s.id === selected)) selected = list[0]?.id ?? null;
      draw();
    })
  );
  card.querySelector('.picker__cancel')!.addEventListener('click', () => api.cancelModal());
  shareButton.addEventListener('click', share);
  draw();
  requestAnimationFrame(() => shareButton.focus());
}

function prettyScreen(name: string, screens: PickerSource[]): string {
  if (screens.length === 1) return 'Entire screen';
  return name.replace(/^screen/i, 'Screen');
}

// ---- Notice --------------------------------------------------------------------------------------

function mountNotice(card: HTMLElement, title: string, body: string): void {
  const icon = document.createElement('div');
  icon.className = 'notice__icon';
  icon.innerHTML = ICONS.sparkle;
  const h = document.createElement('h2');
  h.className = 'modal__title';
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'modal__body';
  p.textContent = body;
  const row = document.createElement('div');
  row.className = 'button-row button-row--end';
  const ok = document.createElement('button');
  ok.className = 'button button--primary';
  ok.type = 'button';
  ok.textContent = 'Got it';
  ok.addEventListener('click', () => api.dismissNotice());
  row.append(ok);
  card.append(icon, h, p, row);
  requestAnimationFrame(() => ok.focus());
}

// ---- Clicks and keys -----------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  switch (target?.dataset.action) {
    case 'retry':
      api.retry();
      break;
    case 'change-server':
      if (state?.view === 'connect') return;
      api.changeServer();
      break;
    case 'scrim':
      if (state?.modal?.kind !== 'notice') api.cancelModal();
      break;
  }
});

$('server-pill').addEventListener('click', () => api.changeServer());
$('update-pill').addEventListener('click', () => api.installUpdate());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state?.modal) {
    e.preventDefault();
    if (state.modal.kind === 'notice') api.dismissNotice();
    else api.cancelModal();
  }
});

// Links in the shell's own text never navigate it.
document.addEventListener('auxclick', (e) => e.preventDefault());

// ---- The unread badge ----------------------------------------------------------------------------

let logo: HTMLImageElement | null = null;
function loadLogo(): Promise<HTMLImageElement> {
  if (logo?.complete) return Promise.resolve(logo);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve((logo = img));
    img.onerror = () => resolve(img);
    img.src = 'logo.png';
  });
}

/** The taskbar's overlay (a red count, Windows) and the tray icon with a dot when anything's unread. */
async function drawBadge(id: number, count: number): Promise<void> {
  const overlay = document.createElement('canvas');
  overlay.width = overlay.height = 32;
  const o = overlay.getContext('2d')!;
  if (count > 0) {
    o.fillStyle = '#e5484d';
    o.beginPath();
    o.arc(16, 16, 15, 0, Math.PI * 2);
    o.fill();
    o.fillStyle = '#ffffff';
    const text = count > 99 ? '99+' : String(count);
    o.font = `700 ${text.length >= 3 ? 13 : text.length === 2 ? 17 : 20}px "Segoe UI", "Ubuntu", sans-serif`;
    o.textAlign = 'center';
    o.textBaseline = 'middle';
    o.fillText(text, 16, 17);
  }

  const tray = document.createElement('canvas');
  tray.width = tray.height = 32;
  const t = tray.getContext('2d')!;
  const image = await loadLogo();
  if (image.naturalWidth) t.drawImage(image, 0, 0, 32, 32);
  if (count > 0) {
    t.fillStyle = '#e5484d';
    t.strokeStyle = '#050607';
    t.lineWidth = 3;
    t.beginPath();
    t.arc(24, 24, 7, 0, Math.PI * 2);
    t.stroke();
    t.fill();
  }
  api.badgeDrawn(id, count > 0 ? overlay.toDataURL('image/png') : null, tray.toDataURL('image/png'));
}
