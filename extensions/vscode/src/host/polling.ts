/** One visible-window coordinator. Closing a wait only stops local observation. */
export class PollCoordinator {
  private visible = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private refreshPromise: Promise<void> | undefined;
  private failures = 0;
  private epoch = 0;
  constructor(private readonly refresh: (signal: AbortSignal) => Promise<void>, private readonly wait: (signal: AbortSignal) => Promise<boolean>, private readonly interval: () => number, private readonly onError: (error: unknown) => void, private readonly random = Math.random) {}
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.epoch++;
    if (!visible) this.stop(); else this.schedule(0, true);
  }
  requestRefresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.refreshPromise) {
      const signal = this.controller?.signal ?? new AbortController().signal;
      this.refreshPromise = this.refresh(signal).finally(() => {this.refreshPromise = undefined;});
    }
    return this.refreshPromise;
  }
  private schedule(delay: number, discover = false): void {
    if (!this.visible || this.disposed) return;
    const epoch=this.epoch;
    this.timer = setTimeout(() => {this.timer = undefined; if(epoch===this.epoch)void this.tick(discover,epoch);},delay);
  }
  private lastOverview = 0;
  private async tick(discover: boolean,epoch:number): Promise<void> {
    if (!this.visible || this.disposed || epoch!==this.epoch) return;
    const controller = new AbortController(); this.controller = controller;
    try {
      if (discover || Date.now() - this.lastOverview >= this.interval()) {await this.requestRefresh(); this.lastOverview = Date.now();}
      if (controller.signal.aborted || !this.visible || epoch!==this.epoch) return;
      const waited = await this.wait(controller.signal);
      if (controller.signal.aborted || !this.visible || this.disposed || epoch!==this.epoch) return;
      this.failures = 0;
      // Empty pools and terminal tasks return immediately; never turn them into a busy loop.
      this.schedule(waited ? 250 : Math.min(this.interval(),5_000));
    } catch (error) {
      if (controller.signal.aborted || !this.visible || this.disposed || epoch!==this.epoch) return;
      if(error&&typeof error==='object'&&'code' in error&&error.code==='ABORTED'){this.schedule(0,true);return;}
      this.onError(error); this.failures++;
      this.schedule(Math.min(30_000,1000 * 2 ** Math.min(this.failures,5) * (0.85 + this.random() * 0.3)),true);
    } finally {if (this.controller === controller) this.controller = undefined;}
  }
  private stop(): void {if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.controller?.abort(); this.controller = undefined;}
  dispose(): void {this.disposed = true; this.visible = false; this.stop();}
}
