import { parseRequest, type WebviewRequest } from './protocol.js';
import { safeError, HostError } from './client.js';
import type { HostResponse } from './types.js';
export interface RouterTarget { generation(): number; execute(request: WebviewRequest): Promise<unknown> }
/** Fixed union dispatch only. No generic command, file path, pool or RPC forwarding. */
export class MessageRouter {
  private disposed = false;
  private readonly inFlight = new Map<string,{fingerprint:string;promise:Promise<HostResponse>}>();
  constructor(private readonly target: RouterTarget, private readonly send: (response: HostResponse) => void) {}
  async receive(raw: unknown): Promise<void> {
    if (this.disposed) return;
    let request: WebviewRequest;
    try {request = parseRequest(raw);} catch {
      const id = raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' && raw.id.length <= 150 ? raw.id : 'invalid';
      this.send({v:1,id,generation:this.target.generation(),ok:false,error:{code:'INVALID_MESSAGE',message:'This message is not a supported workbench request.'}}); return;
    }
    const fingerprint = JSON.stringify(request);
    const previous = this.inFlight.get(request.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {this.send({v:1,id:request.id,generation:this.target.generation(),ok:false,error:{code:'ACTION_CONFLICT',message:'A message ID was reused with different content.'}}); return;}
      const response = await previous.promise; if (!this.disposed) this.send(response); return;
    }
    const promise: Promise<HostResponse> = (async () => {
      try {
        if (request.type !== 'ready' && request.generation !== this.target.generation()) throw new HostError('STALE_CONNECTION','This view belongs to an earlier connection. Reload its current state.');
        const data = await this.target.execute(request);
        return {v:1,id:request.id,generation:this.target.generation(),ok:true,data};
      } catch (error) {return {v:1,id:request.id,generation:this.target.generation(),ok:false,error:safeError(error)};}
    })();
    this.inFlight.set(request.id,{fingerprint,promise});
    const response = await promise;
    // Keep a bounded receipt cache so duplicate completed messages do not execute a write twice.
    if (this.inFlight.size > 500) this.inFlight.delete(this.inFlight.keys().next().value!);
    if (!this.disposed) this.send(response);
  }
  dispose(): void {this.disposed = true; this.inFlight.clear();}
}
