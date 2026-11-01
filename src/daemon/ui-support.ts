import {createHash,createHmac,randomBytes} from 'node:crypto';
import type {UiErrorData,UiErrorKind} from '../shared/ui-contract.js';

const messages:Record<UiErrorKind,string> = {
 INCOMPATIBLE_API:'The client and daemon have no compatible UI API version.', CAPABILITY_UNAVAILABLE:'This capability is unavailable.',
 NOT_FOUND:'The requested object was not found at this observation.',CURSOR_INVALID:'The page cursor is invalid for this request.',CURSOR_STALE:'The page cursor expired or its snapshot changed.',
 OUTPUT_BUDGET_EXCEEDED:'The response exceeds the UI output budget; request a smaller page.',UNSUPPORTED_SCHEMA:'This source cannot be represented by the supported UI schema.',
 APPROVAL_CHANGED:'Approval changed; load the current review before responding.',APPROVAL_GONE:'This approval is no longer pending.',APPROVAL_READ_ONLY:'This approval has no complete, supported actionable review.',
 APPROVAL_RESPONSE_PENDING:'This approval already has a response intent; inspect its receipt.',ACTION_CONFLICT:'This action ID belongs to a different approval response.',
 ARTIFACT_UNAVAILABLE:'The immutable artifact side is unavailable.',INTEGRITY_MISMATCH:'The saved artifact failed its integrity check.',PATH_REJECTED:'The saved artifact path or file type is not permitted.',
 WORKSPACE_BUSY:'The workspace is held by active or uncertain work.',WORKER_BUSY:'The worker is held by active or uncertain work.',REQUEST_CONFLICT:'The request ID belongs to a different dispatch payload.',
 WORKER_UNAVAILABLE:'The worker is not ready.',RECOVERY_REQUIRED:'A safe live attachment is unavailable; inspect or recover execution separately.',AUTH_INVALID:'Account authentication is unavailable.',RISK_BLOCKED:'The account is blocked.',MODEL_SELECTION_MISMATCH:'The native model selection changed.',
 NATIVE_UNAVAILABLE:'The native runtime could not be read.',OUTCOME_UNKNOWN:'The operation may have applied; inspect the existing receipt before another action.',INTERNAL_ERROR:'The daemon could not complete this UI request.',
};
export class UiRpcError extends Error {
 readonly code:number; readonly data?:UiErrorData;
 constructor(kind:UiErrorKind| 'INVALID_ARGUMENT'|'UNKNOWN_METHOD', fields:Partial<Omit<UiErrorData,'kind'>>={}) {
  super(kind==='INVALID_ARGUMENT'?'Invalid UI parameters.':kind==='UNKNOWN_METHOD'?'Unknown method':messages[kind]);
  this.name='UiRpcError';this.code=kind==='INVALID_ARGUMENT'?-32602:kind==='UNKNOWN_METHOD'?-32601:-32010;
  if(kind!=='INVALID_ARGUMENT'&&kind!=='UNKNOWN_METHOD')this.data={kind,retryable:false,outcome:'read_only',...fields};
 }
}
export function canonicalJson(value:unknown):string {
 const ancestors=new Set<object>();
 const walk=(x:unknown,depth:number):unknown=>{
  if(depth>32)throw new UiRpcError('UNSUPPORTED_SCHEMA');
  if(x===null||typeof x==='boolean'||typeof x==='string')return x;
  if(typeof x==='number'&&Number.isFinite(x))return x;
  if(!x||typeof x!=='object'||ancestors.has(x))throw new UiRpcError('UNSUPPORTED_SCHEMA');
  if(!Array.isArray(x)&&Object.getPrototypeOf(x)!==Object.prototype&&Object.getPrototypeOf(x)!==null)throw new UiRpcError('UNSUPPORTED_SCHEMA');
  ancestors.add(x);
  const result=Array.isArray(x)?x.map(v=>walk(v,depth+1)):Object.fromEntries(Object.keys(x).sort().map(key=>[key,walk((x as Record<string,unknown>)[key],depth+1)]));
  ancestors.delete(x);return result;
 };
 return JSON.stringify(walk(value,0));
}
export const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function bounded(value:unknown,maxBytes:number):{text:string;truncated:boolean} {
 const original=typeof value==='string'?value:'';
 if(Buffer.byteLength(original)<=maxBytes)return {text:original,truncated:false};
 let text='';let n=0;for(const char of original){const b=Buffer.byteLength(char);if(n+b>maxBytes)break;text+=char;n+=b;}return {text,truncated:true};
}
interface CursorPayload {method:string;store:string;instance:string;binding:string;expires:number;key:unknown;revision?:number|string}
export class UiCursors {
 private readonly key=randomBytes(32);
 constructor(readonly store:string,readonly instance:string){}
 encode(method:string,binding:unknown,key:unknown,ttlMs:number,revision?:number|string):string {
  const payload:CursorPayload={method,store:this.store,instance:this.instance,binding:digest(canonicalJson(binding)),expires:Date.now()+ttlMs,key,...(revision===undefined?{}:{revision})};
  const body=Buffer.from(canonicalJson(payload)).toString('base64url');return body+'.'+createHmac('sha256',this.key).update(body).digest('base64url');
 }
 decode(token:string,method:string,binding:unknown):CursorPayload {
  try {
   const [body,mac,...rest]=token.split('.');
   if(rest.length||!body||!mac)throw new UiRpcError('CURSOR_INVALID');
   const p=JSON.parse(Buffer.from(body,'base64url').toString('utf8')) as CursorPayload;
   if(p.method!==method||p.binding!==digest(canonicalJson(binding))||p.store!==this.store)throw new UiRpcError('CURSOR_INVALID');
   // A previous instance's private signing key has intentionally been discarded.
   // Its claimed identity can only invalidate a chain, never authorize a read.
   if(p.instance!==this.instance)throw new UiRpcError('CURSOR_STALE');
   if(createHmac('sha256',this.key).update(body).digest('base64url')!==mac)throw new UiRpcError('CURSOR_INVALID');
   if(!Number.isSafeInteger(p.expires)||p.expires<Date.now())throw new UiRpcError('CURSOR_STALE');
   return p;
  }catch(e){if(e instanceof UiRpcError)throw e;throw new UiRpcError('CURSOR_INVALID');}
 }
}
