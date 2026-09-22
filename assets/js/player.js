/**
 * player.js — thin wrapper around a single <audio> element.
 *
 * The player owns playback mechanics (load/play/pause/seek/timing) and emits
 * events. Deciding *what* plays next is the app's job, which keeps queue logic
 * testable and lets ayah-mode and surah-mode share one audio pipeline.
 */

import { fmtTime } from './fx.js';

export class Player {
  #audio = new Audio();
  #listeners = new Map();
  #track = null;

  constructor() {
    // No crossOrigin attribute on purpose: the murattal CDN is not guaranteed to
    // send CORS headers, and plain playback does not need them.
    this.#audio.preload = 'metadata';

    this.#audio.addEventListener('timeupdate', () => this.#emit('time', this.timeInfo()));
    this.#audio.addEventListener('durationchange', () => this.#emit('time', this.timeInfo()));

    // Every `state` payload carries the real `playing` value read from the
    // element. The `waiting`/`playing` events are about buffering and would
    // otherwise emit `playing: undefined`, which a listener reads as "paused"
    // and uses to flip the icon back mid-playback.
    this.#audio.addEventListener('play', () => this.#emit('state', this.#stateInfo()));
    this.#audio.addEventListener('pause', () => this.#emit('state', this.#stateInfo()));
    this.#audio.addEventListener('waiting', () => this.#emit('state', this.#stateInfo({ buffering: true })));
    this.#audio.addEventListener('playing', () => this.#emit('state', this.#stateInfo()));

    this.#audio.addEventListener('ended', () => this.#emit('ended', this.#track));
    this.#audio.addEventListener('error', () => {
      // `stop()` clears the source, which can surface as a spurious error event.
      if (!this.#track) return;
      this.#emit('error', new Error('Audio gagal dimuat dari server murottal.'));
    });
  }

  /* ── Events ──────────────────────────────────────────────────────────── */

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.#listeners.get(event)?.delete(fn);
  }

  #emit(event, payload) {
    this.#listeners.get(event)?.forEach((fn) => fn(payload));
  }

  /* ── State ───────────────────────────────────────────────────────────── */

  get track() { return this.#track; }
  get playing() { return !this.#audio.paused && !this.#audio.ended; }
  get currentTime() { return this.#audio.currentTime || 0; }
  get duration() { return Number.isFinite(this.#audio.duration) ? this.#audio.duration : 0; }

  timeInfo() {
    const duration = this.duration;
    return {
      current: this.currentTime,
      duration,
      fraction: duration ? this.currentTime / duration : 0,
      label: `${fmtTime(this.currentTime)} / ${fmtTime(duration)}`,
    };
  }

  /** Snapshot of the transport state, always including an accurate `playing`. */
  #stateInfo(extra = {}) {
    return { playing: this.playing, buffering: false, ...extra };
  }

  /* ── Transport ───────────────────────────────────────────────────────── */

  /**
   * Point the element at a new source and start playing.
   * @param {{url:string, title:string, sub?:string, surah:number, ayah?:number}} track
   */
  async load(track, { autoplay = true } = {}) {
    const sameSource = this.#track?.url === track.url;
    this.#track = track;

    if (sameSource) {
      // Replaying the same ayah (loop, or tapping it again) must restart it —
      // otherwise the element sits at the end and immediately re-fires `ended`.
      this.#audio.currentTime = 0;
    } else {
      this.#audio.src = track.url;
    }

    this.#updateMediaSession(track);
    this.#emit('track', track);

    if (autoplay) {
      try {
        await this.#audio.play();
      } catch (err) {
        if (err?.name !== 'AbortError') this.#emit('error', err);
      }
    }
  }

  async play() {
    try {
      await this.#audio.play();
    } catch (err) {
      if (err?.name !== 'AbortError') this.#emit('error', err);
    }
  }

  pause() { this.#audio.pause(); }

  toggle() { return this.playing ? (this.pause(), Promise.resolve()) : this.play(); }

  stop() {
    this.#audio.pause();
    this.#audio.removeAttribute('src');
    this.#audio.load();
    this.#track = null;
    this.#emit('state', { playing: false });
    this.#emit('track', null);
  }

  /** @param {number} fraction 0..1 */
  seek(fraction) {
    if (!this.duration) return;
    this.#audio.currentTime = Math.min(Math.max(fraction, 0), 1) * this.duration;
    this.#emit('time', this.timeInfo());
  }

  /** Relative seek in seconds. */
  skip(seconds) {
    if (!this.duration) return;
    this.#audio.currentTime = Math.min(Math.max(this.#audio.currentTime + seconds, 0), this.duration);
    this.#emit('time', this.timeInfo());
  }

  setRate(rate) { this.#audio.playbackRate = rate; }

  /* ── Prefetch ────────────────────────────────────────────────────────── */

  #warm = new Map();

  /**
   * Warm the HTTP cache for the next ayah so a continuous murattal has no
   * audible gap at the join. The holding elements stay referenced (a detached
   * Audio would abort its own download); the oldest are released.
   */
  prefetch(url) {
    if (!url || this.#warm.has(url) || url === this.#track?.url) return;
    const el = new Audio();
    el.preload = 'auto';
    el.src = url;
    this.#warm.set(url, el);
    while (this.#warm.size > 3) {
      this.#warm.delete(this.#warm.keys().next().value);
    }
  }

  /* ── OS-level media controls ─────────────────────────────────────────── */

  #updateMediaSession(track) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.sub || 'Al-Qur\u2019an',
      album: 'N\u016Br al-Qur\u2019\u0101n',
    });
  }

  bindMediaSession({ onPrev, onNext, onPlay, onPause, onStop }) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => {
      try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
    };
    set('play', () => onPlay?.());
    set('pause', () => onPause?.());
    set('stop', () => onStop?.());
    set('previoustrack', () => onPrev?.());
    set('nexttrack', () => onNext?.());
  }
}
