import { powerMonitor } from 'electron';

/**
 * Whether you've left the computer, for the page's automatic Away (`watchIdle`): no keyboard or
 * mouse input anywhere for the page's number of minutes, or the screen locked. The system's idle
 * timer only says how long since the last input, never what it was, and the page only hears
 * "idle" or "back".
 */
export class IdleWatch {
  private thresholdSeconds = 0;
  private idle = false;
  private locked = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly report: (idle: boolean) => void) {
    powerMonitor.on('lock-screen', () => this.setLocked(true));
    powerMonitor.on('unlock-screen', () => this.setLocked(false));
    powerMonitor.on('suspend', () => this.setLocked(true));
    powerMonitor.on('resume', () => this.setLocked(false));
  }

  /** Starts watching with this many minutes before idle; 0 stops. */
  watch(minutes: number): void {
    this.thresholdSeconds = Math.max(0, Math.min(24 * 60, Math.floor(minutes))) * 60;
    this.idle = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.thresholdSeconds === 0) return;
    this.timer = setInterval(() => this.check(), 15_000);
    this.check();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private setLocked(locked: boolean): void {
    this.locked = locked;
    if (this.thresholdSeconds > 0) this.check();
  }

  private check(): void {
    const now = this.locked || powerMonitor.getSystemIdleTime() >= this.thresholdSeconds;
    if (now === this.idle) return;
    this.idle = now;
    this.report(now);
  }
}
