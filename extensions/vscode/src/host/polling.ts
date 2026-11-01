/** One visible-window coordinator. Closing a wait only stops local observation. */
export class PollCoordinator {
  private visible = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private refreshPromise: Promise<void> | undefined;
  private lastOverview: number | undefined;
  private refreshEpoch = 0;
  private failures = 0;
  private epoch = 0;
  constructor(private readonly refresh: (signal: AbortSignal) => Promise<void>, private readonly wait: (signal: AbortSignal) => Promise<boolean|'idle'>, private readonly interval: () => number, private readonly onError: (error: unknown) => void, private readonly random = Math.random) {}
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.epoch++;
    if (!visible) this.stop(); else this.schedule(0);
  }
  requestRefresh(afterCurrent = false, signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (afterCurrent && this.refreshPromise) {
      const epoch = this.refreshEpoch;
      // A write needs a snapshot started after its acknowledgement, even when
      // a background refresh was already running. Concurrent writes share it.
      return this.refreshPromise.catch(() => {}).then(() => {
        if (epoch === this.refreshEpoch) return this.requestRefresh(false, signal);
      });
    }
    if (!this.refreshPromise) {
      const promise = this.refresh(signal ?? this.controller?.signal ?? new AbortController().signal)
        .then(() => {
          if (this.refreshPromise !== promise) return;
          this.lastOverview = Date.now();
          // Explicit refreshes can discover active work while an idle timer sleeps.
          if (this.timer !== undefined) this.schedule(0);
        })
        .finally(() => {if (this.refreshPromise === promise) this.refreshPromise = undefined;});
      this.refreshPromise = promise;
    }
    return this.refreshPromise;
  }
  private schedule(delay: number, discover = false): void {
    if (!this.visible || this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const epoch=this.epoch;
    this.timer = setTimeout(() => {this.timer = undefined; if(epoch===this.epoch)void this.tick(discover,epoch);},delay);
  }
  private async tick(discover: boolean,epoch:number): Promise<void> {
    if (!this.visible || this.disposed || epoch!==this.epoch) return;
    const controller = new AbortController(); this.controller = controller;
    try {
      if (discover || this.lastOverview === undefined || Date.now() - this.lastOverview >= this.interval()) await this.requestRefresh();
      if (controller.signal.aborted || !this.visible || epoch!==this.epoch) return;
      const waited = await this.wait(controller.signal);
      if (controller.signal.aborted || !this.visible || this.disposed || epoch!==this.epoch) return;
      this.failures = 0;
      // With no observable tasks, only wake for the next overview discovery.
      const untilOverview = Math.max(0, this.interval() - (Date.now() - (this.lastOverview ?? 0)));
      this.schedule(waited === 'idle' ? untilOverview : waited ? 250 : Math.min(this.interval(),5_000));
    } catch (error) {
      if (controller.signal.aborted || !this.visible || this.disposed || epoch!==this.epoch) return;
      if(error&&typeof error==='object'&&'code' in error&&error.code==='ABORTED'){this.schedule(0,true);return;}
      this.onError(error); this.failures++;
      this.schedule(Math.min(30_000,1000 * 2 ** Math.min(this.failures,5) * (0.85 + this.random() * 0.3)),true);
    } finally {if (this.controller === controller) this.controller = undefined;}
  }
  intervalChanged(): void {if (this.timer !== undefined) this.schedule(0);}
  private stop(): void {if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; this.controller?.abort(); this.controller = undefined;}
  reset(): void {this.stop();this.epoch++;this.refreshEpoch++;this.refreshPromise=undefined;this.lastOverview=undefined;this.failures=0;}
  dispose(): void {this.disposed = true; this.visible = false; this.stop();}
}
