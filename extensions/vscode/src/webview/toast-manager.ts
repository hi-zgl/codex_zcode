import type { LocalState } from './state.js';

export interface ToastManagerOptions {
  readonly root: HTMLElement;
  readonly state: LocalState;
  readonly onDismiss: (key: string) => void;
}

export class ToastManager {
  private readonly root: HTMLElement;
  private readonly state: LocalState;
  private readonly onDismiss: (key: string) => void;
  private readonly toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly hoveredToasts = new Set<string>();

  constructor(options: ToastManagerOptions) {
    this.root = options.root;
    this.state = options.state;
    this.onDismiss = options.onDismiss;
  }

  pauseToast(key: string): void {
    this.hoveredToasts.add(key);
    const timer = this.toastTimers.get(key);
    if (timer) { clearTimeout(timer); this.toastTimers.delete(key); }
  }

  resumeToast(key: string, delayMs = 4000): void {
    this.hoveredToasts.delete(key);
    const actionObj = this.state.snapshot?.actions.find(a => a.key === key);
    if (actionObj && actionObj.phase === 'succeeded' && !this.toastTimers.has(key)) {
      this.scheduleToast(key, delayMs);
    }
  }

  scheduleToast(key: string, delayMs = 6000): void {
    const existing = this.toastTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.toastTimers.delete(key);
      this.hoveredToasts.delete(key);
      this.onDismiss(key);
    }, delayMs);
    this.toastTimers.set(key, timer);
  }

  attachToastInteractions(): void {
    const receiptEls = Array.from(this.root.querySelectorAll<HTMLElement>('.action-receipt'));
    const currentKeys = new Set<string>();
    for (const receipt of receiptEls) {
      const key = receipt.dataset.key;
      if (!key) continue;
      currentKeys.add(key);
      receipt.addEventListener('mouseenter', () => this.pauseToast(key));
      receipt.addEventListener('mouseleave', () => this.resumeToast(key));
      receipt.addEventListener('focusin', () => this.pauseToast(key));
      receipt.addEventListener('focusout', (e: FocusEvent) => {
        if (!receipt.contains(e.relatedTarget as Node | null)) this.resumeToast(key);
      });
      const actionObj = this.state.snapshot?.actions.find(a => a.key === key);
      if (actionObj && actionObj.phase === 'succeeded' && !this.toastTimers.has(key) && !this.hoveredToasts.has(key)) {
        this.scheduleToast(key, 6000);
      }
    }
    for (const [key, timer] of this.toastTimers.entries()) {
      if (!currentKeys.has(key)) {
        clearTimeout(timer);
        this.toastTimers.delete(key);
        this.hoveredToasts.delete(key);
      }
    }
  }

  dismiss(key?: string): void {
    if (key) {
      this.state.dismissedActions.add(key);
      const timer = this.toastTimers.get(key);
      if (timer) { clearTimeout(timer); this.toastTimers.delete(key); }
      this.hoveredToasts.delete(key);
      return;
    }
    for (const action of this.state.snapshot?.actions ?? []) {
      this.state.dismissedActions.add(action.key);
      const timer = this.toastTimers.get(action.key);
      if (timer) { clearTimeout(timer); this.toastTimers.delete(action.key); }
      this.hoveredToasts.delete(action.key);
    }
  }

  dispose(): void {
    for (const timer of this.toastTimers.values()) clearTimeout(timer);
    this.toastTimers.clear();
    this.hoveredToasts.clear();
  }
}
