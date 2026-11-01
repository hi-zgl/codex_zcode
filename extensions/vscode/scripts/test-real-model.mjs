import {createHash,randomUUID} from 'node:crypto';
import {hostname,tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {lstat,mkdtemp,open,readFile,realpath,rm} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const emit=value=>process.stdout.write(`${JSON.stringify({test:'real-model',...value})}\n`);
const required=['pool-home','worker-id','workspace-id','prompt-file','verify-commands-file','model-id','mode','session','busy-retry-limit','receipt-file'];
const allowed=new Set([...required,'timeout-seconds']);
class RunnerError extends Error {constructor(code,message,details={}){super(message);this.code=code;this.details=details;}}
const sha256=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message,details)=>{throw new RunnerError(code,message,details);};
const isId=value=>typeof value==='string'&&value.length>0&&value.length<=150&&Buffer.byteLength(value)<=600&&!value.includes('\0');

function argumentsForRun(args){
 const flags={};
 for(let i=0;i<args.length;i++){
  const flag=args[i];if(!flag?.startsWith('--')||!allowed.has(flag.slice(2))||flags[flag.slice(2)]!==undefined)fail('INVALID_ARGUMENT','Use the documented flags exactly once; no positional arguments are accepted.');
  const value=args[++i];if(!value||value.startsWith('--')||value.includes('\0')||/[\r\n]/.test(value))fail('INVALID_ARGUMENT','Every flag requires one explicit value.');flags[flag.slice(2)]=value;
 }
 const missing=required.filter(name=>flags[name]===undefined);if(missing.length)fail('MISSING_ARGUMENTS','Enabled runs require all explicit inputs before connecting.',{missing:missing.map(name=>'--'+name)});
 for(const name of ['pool-home','prompt-file','verify-commands-file','receipt-file'])if(!isAbsolute(flags[name]))fail('INVALID_ARGUMENT','Pool, input files and receipt must use absolute paths.');
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(flags['worker-id'])||!isId(flags['workspace-id']))fail('INVALID_ARGUMENT','Supply valid explicit Worker and workspace identifiers.');
 if(!flags['model-id'].trim()||flags['model-id'].length>200||!['build','edit','plan','yolo','guarded'].includes(flags.mode)||!['continue','new'].includes(flags.session))fail('INVALID_ARGUMENT','Supply an explicit supported mode, session policy and model ID.');
 if(!/^(?:0|[1-9]|10)$/.test(flags['busy-retry-limit']))fail('INVALID_ARGUMENT','The explicit busy retry limit must be an integer from 0 to 10.');
 if(flags['timeout-seconds']!==undefined&&!/^[1-9]\d{0,3}$/.test(flags['timeout-seconds']))fail('INVALID_ARGUMENT','The observation timeout must be an integer from 1 to 3600 seconds.');
 const timeoutSeconds=Number(flags['timeout-seconds']??300);if(timeoutSeconds>3600)fail('INVALID_ARGUMENT','The observation timeout must be an integer from 1 to 3600 seconds.');
 return {...flags,timeoutSeconds};
}
async function inputFile(path,maxBytes){
 try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)throw new Error();const bytes=await readFile(path);if(bytes.length>maxBytes)throw new Error();return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 catch{fail('INVALID_INPUT_FILE','Input files must be regular, bounded UTF-8 files. Their paths and contents are not included in diagnostics.');}
}
function verificationPolicy(text){
 let value;try{value=JSON.parse(text);}catch{fail('INVALID_VERIFICATION_POLICY','The verification file must contain a JSON command array.');}
 if(!Array.isArray(value)||value.length<1||value.length>10||value.some(c=>!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['command','args','timeoutMs'].includes(k))||typeof c.command!=='string'||!c.command.trim()||c.command.length>4096||c.command.includes('\0')||!Array.isArray(c.args)||c.args.length>100||c.args.some(a=>typeof a!=='string'||a.length>4096||a.includes('\0'))||!Number.isInteger(c.timeoutMs)||c.timeoutMs<100||c.timeoutMs>300000))fail('INVALID_VERIFICATION_POLICY','Provide 1–10 complete {command,args,timeoutMs} entries; commands are never inferred.');
 return value;
}
async function hostClientBundle(extensionRoot,directory){
 // This happens only after the opt-in, all required flags and input validation.
 // It imports the actual extension client, never the coordinator or runtime.
 const {build}=await import('esbuild');const output=join(directory,'real-model-client.cjs');
 const built=await build({absWorkingDir:extensionRoot,stdin:{contents:"export {ActionService} from './src/host/actions.ts'; export {SocketTransport,HostError} from './src/host/client.ts';",resolveDir:extensionRoot,sourcefile:'real-model-entry.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',target:'node20',outfile:output,alias:{zod:join(extensionRoot,'node_modules','zod')},metafile:true,logLevel:'silent'});
 if(Object.keys(built.metafile.inputs).some(name=>/(?:src\/(?:daemon|core|accounts|runtime|supervisor)|node:sqlite)/.test(name.replaceAll('\\','/'))))fail('INVALID_CLIENT_BUNDLE','The acceptance client includes a forbidden daemon dependency.');
 const loaded=await import(pathToFileURL(output).href);return loaded.default??loaded;
}

async function runEnabled(flags){
 const prompt=await inputFile(flags['prompt-file'],400000);
 if(!prompt.trim()||prompt.length>100000)fail('INVALID_PROMPT','The prompt must contain 1–100000 UTF-16 units; it is never truncated or printed.');
 const verifyCommands=verificationPolicy(await inputFile(flags['verify-commands-file'],65536));
 const draft={workspaceId:flags['workspace-id'],workerId:flags['worker-id'],prompt,session:flags.session,mode:flags.mode,modelId:flags['model-id'],busyRetryLimit:Number(flags['busy-retry-limit']),verifyCommands,submitToken:randomUUID()};
 if(Buffer.byteLength(JSON.stringify(draft))>500000)fail('INVALID_ARGUMENT','The complete request exceeds the workbench request budget.');
 let poolHome;try{poolHome=await realpath(flags['pool-home']);if(!(await lstat(poolHome)).isDirectory())throw new Error();}catch{fail('INVALID_POOL','The explicitly selected pool directory is unavailable. No default pool is used.');}
 let receiptFile;try{receiptFile=await open(flags['receipt-file'],'wx',0o600);}catch{fail('RECEIPT_UNAVAILABLE','Use a new receipt path in an existing directory. Existing receipts are never overwritten and their dispatch is never repeated.');}
 const receipt={schemaVersion:1,phase:'prepared',poolHome,workerId:draft.workerId,workspaceId:draft.workspaceId,modelId:draft.modelId,mode:draft.mode,session:draft.session,busyRetryLimit:draft.busyRetryLimit,verificationCommandCount:verifyCommands.length,payloadSha256:null,storeId:null,instanceId:null,requestId:null,taskId:null,updatedAtMs:Date.now()};
 async function saveReceipt(){receipt.updatedAtMs=Date.now();const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');let offset=0;while(offset<bytes.length){const written=await receiptFile.write(bytes,offset,bytes.length-offset,offset);if(!written.bytesWritten)throw new Error('Receipt write failed');offset+=written.bytesWritten;}await receiptFile.truncate(bytes.length);await receiptFile.sync();}
 let service,temporary,timer,stopped=null;const observation=new AbortController();const storage=new Map();
 const stop=reason=>{stopped??=reason;observation.abort();service?.dispose();};
 const interrupt=()=>stop('INTERRUPTED');const terminate=()=>stop('TERMINATED');
 try{
  await saveReceipt();temporary=await mkdtemp(join(tmpdir(),'zcode-pool-real-model-'));
  const {ActionService,SocketTransport}=await hostClientBundle(fileURLToPath(new URL('..',import.meta.url)),temporary);
  const native={trusted:()=>true,getState:(key,fallback)=>storage.get(key)??fallback,setState:async(key,value)=>{
   storage.set(key,structuredClone(value));
   if(key==='dispatchRecovery'){
    const record=value.at(-1);if(!record||!isId(record.requestId))fail('INVALID_RECOVERY_RECORD','The workbench did not persist a valid original request identity.');
    receipt.requestId=record.requestId;receipt.payloadSha256=record.payloadHash;receipt.phase='dispatch_intent';await saveReceipt();
    emit({phase:'dispatch_intent',requestId:receipt.requestId,workerId:receipt.workerId,workspaceId:receipt.workspaceId,payloadSha256:receipt.payloadSha256});
   }
  },pickAccountFiles:async()=>fail('UNSUPPORTED_ACTION','This runner never imports accounts.'),pickRepository:async()=>fail('UNSUPPORTED_ACTION','This runner never creates workspaces.'),openDiff:async()=>fail('MANUAL_UI_REQUIRED','Open immutable Diff in the real VS Code workbench.'),openSettings:async()=>{},saveInterval:async()=>{},copyDiagnostics:async()=>{},guidance:async()=>{}};
  service=new ActionService({mode:'real',poolHome,host:hostname(),authority:'acceptance-script',native,createTransport:async()=>new SocketTransport(poolHome),onSnapshot:()=>{}});
  let sequence=0;const execute=(type,payload={})=>service.execute({v:1,id:`real-model-${++sequence}`,generation:service.generation(),type,payload});
  const ensureObserving=()=>{if(stopped)fail(stopped,'Observation stopped. The original task was not cancelled or resent.');};
  process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);timer=setTimeout(()=>stop('OBSERVATION_TIMEOUT'),flags.timeoutSeconds*1000);
  await execute('connect');ensureObserving();
  const state=service.snapshot();if(state.connection.state!=='connected'||['dispatchTask','taskDetail','taskLookupByRequest','artifactSnapshots'].some(cap=>state.connection.capabilities[cap]?.version!==1))fail('CAPABILITY_UNAVAILABLE','This run requires the current task, request lookup, dispatch and immutable artifact capabilities.');
  receipt.storeId=state.connection.storeId;receipt.instanceId=state.connection.instanceId;await saveReceipt();ensureObserving();
  const worker=state.resources.workers.find(w=>w.workerId===draft.workerId),workspace=state.resources.workspaces.find(w=>w.workspaceId===draft.workspaceId);
  if(!worker||worker.state!=='ready'||worker.runningTaskCount!==0||worker.leaseTaskIds.length||!workspace||workspace.state!=='active'||workspace.activeTaskId)fail('TARGET_UNAVAILABLE','Select an existing ready Worker with confirmed zero native activity and an unoccupied active workspace. No resources are started or reassigned.');
  emit({phase:'connected',poolHome,storeId:receipt.storeId,instanceId:receipt.instanceId,workerId:worker.workerId,accountAlias:worker.accountAlias,workspaceId:workspace.workspaceId,baseCommit:workspace.baseCommit,verificationCommandCount:verifyCommands.length,timeoutSeconds:flags.timeoutSeconds});
  await execute('draft.change',{draft});ensureObserving();
  // Exactly one call. ActionService durably records one request ID through setState
  // before its original dispatch; timeouts and connection loss never replay it.
  const dispatched=await execute('dispatch',{submitToken:draft.submitToken});receipt.taskId=dispatched.task.taskId;receipt.phase='observing';await saveReceipt();ensureObserving();
  let previous='';let detail;
  for(;;){
   ensureObserving();detail=await execute('task.select',{taskId:receipt.taskId});ensureObserving();
   const status={taskId:detail.taskId,requestId:receipt.requestId,status:detail.status,revision:detail.revision,leaseHeld:detail.leaseHeld,executionStopped:detail.executionStopped,cancelRequestedAtMs:detail.cancelRequestedAtMs,pendingApprovalCount:detail.approval.pendingCount,approvalResponsePending:detail.approval.responsePending,retry:detail.retry};
   const signature=JSON.stringify(status);if(signature!==previous){emit({phase:'status',...status,...(detail.status==='waiting_approval'?{manualAction:'Review this task in the VS Code workbench. This runner never answers approvals.'}:{})});previous=signature;}
   if(['succeeded','failed','cancelled','blocked','interrupted'].includes(detail.status))break;
   await sleep(1000,undefined,{signal:observation.signal});
  }
  emit({phase:'result',taskId:detail.taskId,requestId:receipt.requestId,status:detail.status,leaseHeld:detail.leaseHeld,executionStopped:detail.executionStopped,resultAvailable:detail.result.available,changedFileCount:detail.result.changedFileCount,artifactCount:detail.result.artifactCount,blockerCount:detail.result.blockers.length,verificationExitCodes:detail.result.verification.map(v=>v.exitCode),manifestState:detail.result.manifestState});
  const delivery=await execute('artifacts.list',{taskId:detail.taskId});ensureObserving();const manifest=delivery.manifest;let cursor=delivery.nextCursor;
  while(cursor){const page=await execute('artifacts.list',{taskId:detail.taskId,cursor});ensureObserving();if(page.nextCursor===cursor)fail('CURSOR_INVALID','The immutable file list did not advance.');cursor=page.nextCursor;}
  const files=service.snapshot().delivery.files;
  emit({phase:'immutable_manifest',taskId:detail.taskId,state:manifest.state,manifestSha256:manifest.manifestSha256,scope:manifest.scope,baseCommit:manifest.baseCommit,fileCount:manifest.fileCount,listedFileCount:files.length,availableFileCount:manifest.availableFileCount,unavailableFileCount:manifest.unavailableFileCount,fileListComplete:manifest.fileListComplete,untrackedFileCount:files.filter(f=>f.change==='untracked').length,manualUiReviewRequired:true});
  const passed=detail.status==='succeeded'&&detail.result.available&&detail.result.verification.length===verifyCommands.length&&detail.result.verification.every(v=>v.exitCode===0)&&manifest.state==='available'&&manifest.fileListComplete&&files.length===manifest.fileCount&&manifest.unavailableFileCount===0;
  receipt.phase=passed?'finished':'incomplete';await saveReceipt();emit({phase:receipt.phase,passed,requestId:receipt.requestId,taskId:receipt.taskId,receiptFile:resolve(flags['receipt-file']),manualAction:'Inspect immutable Diff and record your review in VS Code. No review marker was written by this runner.'});return passed?0:1;
 }catch(error){
  const code=stopped??(error instanceof RunnerError?error.code:typeof error?.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'REQUEST_FAILED');
  receipt.phase=stopped?'observation_stopped':receipt.requestId?'outcome_unknown':'not_started';receipt.errorCode=code;await saveReceipt().catch(()=>{});
  emit({phase:receipt.phase,code,requestId:receipt.requestId,taskId:receipt.taskId,outcome:receipt.requestId?'may_have_applied':'not_started',message:'No retry, approval reply, cancellation or Worker stop was sent. Inspect the original IDs and receipt in the selected pool.'});
  return code==='INTERRUPTED'?130:code==='TERMINATED'?143:code==='OBSERVATION_TIMEOUT'?124:2;
 }finally{
  clearTimeout(timer);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);observation.abort();service?.dispose();await receiptFile.close();if(temporary)await rm(temporary,{recursive:true,force:true});
 }
}

async function main(){
 if(process.argv.slice(2).includes('--help')){process.stdout.write(`Usage: ZCODE_POOL_RUN_REAL_MODEL=1 npm run test:real-model -- ${required.map(name=>`--${name} <value>`).join(' ')} [--timeout-seconds 300]\nVerification file: JSON array of {command,args,timeoutMs}; provide at least one command.\nThe receipt path must be new. Approvals and final review stay manual in VS Code.\n`);return 0;}
 // Default CI/build/F5 invocation returns before reading inputs, bundling or opening
 // any socket. ZCODE_POOL_HOME and default accounts/pools are never consulted.
 if(process.env.ZCODE_POOL_RUN_REAL_MODEL!=='1'){emit({phase:'skipped',reason:'Set ZCODE_POOL_RUN_REAL_MODEL=1 and supply every explicit input to opt in. No socket was opened.'});return 0;}
 const flags=argumentsForRun(process.argv.slice(2));return runEnabled(flags);
}
main().then(code=>{process.exitCode=code;}).catch(error=>{emit({phase:'not_started',code:error instanceof RunnerError?error.code:'PREPARATION_FAILED',message:error instanceof RunnerError?error.message:'The explicit acceptance inputs could not be prepared; no dispatch was sent.',...(error instanceof RunnerError?error.details:{})});process.exitCode=2;});
