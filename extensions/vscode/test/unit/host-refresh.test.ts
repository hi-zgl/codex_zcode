import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {ActionService,type NativeAdapter,type ServiceOptions} from '../../src/host/actions.js';
import {HostError} from '../../src/host/client.js';
import {MockTransport,loadMockFixture} from '../../src/host/mock.js';
import {parseRequest,type RequestType} from '../../src/host/protocol.js';

const fixturePath=resolve(__dirname,'../fixtures/pool-demo.json');
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function harness(options:Partial<Pick<ServiceOptions,'mode'|'supported'|'configurationError'|'initialGeneration'>>={},trusted=true){
  const fixture=await loadMockFixture(fixturePath);const transports:MockTransport[]=[];
  const native:NativeAdapter={trusted:()=>trusted,getState:<T>(_key:string,fallback:T)=>fallback,setState:async()=>{},pickAccountFiles:async()=>undefined,pickRepository:async()=>undefined,openDiff:async()=>{},openSettings:async()=>{},saveInterval:async()=>{},copyDiagnostics:async()=>{},guidance:async()=>{}};
  const service=new ActionService({mode:'mock',poolHome:'/mock/pool',host:'mock-host',authority:'local',native,onSnapshot:()=>{},createTransport:async()=>{const transport=new MockTransport(fixture);transports.push(transport);return transport;},...options});
  let id=0;
  const execute=(type:RequestType,payload:unknown={})=>service.execute(parseRequest({v:1,id:String(++id),generation:service.generation(),type,payload}));
  return {service,native,fixture,transports,execute};
}

test('a replacement Host starts at the supplied generation and continues increasing it',async()=>{
  const h=await harness({initialGeneration:21});
  try{
    assert.equal(h.service.generation(),21);
    assert.equal(h.service.snapshot().connection.generation,21);
    await assert.rejects(h.service.execute(parseRequest({v:1,id:'old',generation:0,type:'refresh',payload:{}})),{code:'STALE_CONNECTION'});
    await h.execute('connect');assert.equal(h.service.generation(),22);
    h.service.disconnect();assert.equal(h.service.generation(),23);
  }finally{h.service.dispose();}
});

test('connecting a visible Host loads one overview before starting observation',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100_000});
  const h=await harness();t.after(()=>h.service.dispose());
  h.service.setVisible(true);await h.execute('connect');
  t.mock.timers.tick(0);await flush();
  assert.equal(h.transports[0]!.calls.filter(call=>call.method==='overview').length,1);
  assert.equal(h.transports[0]!.calls.filter(call=>call.method==='wait').length,1);
});

for(const source of ['configuration','workbench']as const)test(`shortening the ${source} overview interval wakes an idle Host`,async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100_000});
  const h=await harness();t.after(()=>h.service.dispose());
  h.fixture.details={};for(const workspace of h.fixture.overview.workspaces)workspace.activeTaskId=null;
  h.service.setOverviewInterval(300);h.service.setVisible(true);await h.execute('connect');
  t.mock.timers.tick(0);await flush();
  t.mock.timers.tick(15_000);
  if(source==='configuration')h.service.setOverviewInterval(15);else await h.execute('settings.save',{overviewIntervalSeconds:15});
  t.mock.timers.tick(0);await flush();
  assert.equal(h.transports[0]!.calls.filter(call=>call.method==='overview').length,2);
  assert.equal(h.transports[0]!.calls.filter(call=>call.method==='wait').length,0);
});

for(const taskList of [true,false])test(`refresh deduplicates overview and task details with task-list capability ${taskList}`,async()=>{
  const h=await harness();
  if(!taskList)Reflect.deleteProperty(h.fixture.capabilities.capabilities,'taskList');
  try{
    await h.execute('connect');await h.execute('task.select',{taskId:'task-approval'});
    const transport=h.transports[0]!;transport.calls.length=0;
    await Promise.all([h.service.refresh(),h.execute('resources.refresh'),h.execute('refresh')]);
    assert.equal(transport.calls.filter(call=>call.method==='overview').length,1);
    const details=transport.calls.filter(call=>call.method==='ui_get_task_detail').map(call=>(call.params as {task_id:string}).task_id);
    assert.equal(new Set(details).size,details.length);
    assert.equal(details.filter(taskId=>taskId==='task-approval').length,1);
    assert.equal(h.service.state.detail?.taskId,'task-approval');
    assert.deepEqual(h.service.state.resources.workers.find(worker=>worker.workerId==='worker-review')?.leaseTaskIds,['task-approval']);
  }finally{h.service.dispose();}
});

test('a resource write refreshes after an older in-flight overview finishes',async()=>{
  const h=await harness();let release:()=>void=()=>{};
  try{
    await h.execute('connect');const transport=h.transports[0]!;transport.calls.length=0;
    const original=transport.request.bind(transport);let overviewCount=0;
    transport.request=async(method,params,signal)=>{
      const value=await original(method,params,signal);
      if(method==='overview'&&++overviewCount===1)await new Promise<void>(resolve=>{release=resolve;});
      return value;
    };
    const old=h.service.refresh();await flush();
    const write=h.execute('worker.probe',{workerId:'worker-demo'});await flush();
    assert.equal(transport.calls.filter(call=>call.method==='ui_probe_quota').length,1);
    assert.equal(overviewCount,1);
    release();await Promise.all([old,write]);
    assert.equal(overviewCount,2);assert.ok(h.service.state.resources.quotas['account-demo']?.live);
  }finally{release();h.service.dispose();}
});

test('reconnect loads its own overview while a previous connection refresh is still settling',async()=>{
  const h=await harness();let release:()=>void=()=>{};
  try{
    await h.execute('connect');const transport=h.transports[0]!;
    const original=transport.request.bind(transport);
    transport.request=async(method,params,signal)=>{
      const value=await original(method,params,signal);
      if(method==='overview')await new Promise<void>(resolve=>{release=resolve;});
      return value;
    };
    const old=h.service.refresh().catch(error=>error);await flush();
    h.service.disconnect();await h.execute('connect');
    assert.equal(h.transports.length,2);
    assert.equal(h.transports[1]!.calls.filter(call=>call.method==='overview').length,1);
    release();assert.equal((await old).code,'STALE_CONNECTION');
    assert.equal(h.service.state.connection.state,'connected');
  }finally{release();h.service.dispose();}
});

test('connection configuration stays available without trust or a valid daemon connection',async()=>{
  const h=await harness({supported:false,configurationError:new HostError('INVALID_POOL_HOME','Invalid pool.')},false);
  try{
    await assert.rejects(h.execute('connection.configure'),{code:'ACTION_UNAVAILABLE'});
    let configured=0;h.native.configureConnection=async()=>{configured++;};
    assert.deepEqual(await h.execute('connection.configure'),{configured:true});assert.equal(configured,1);
    assert.equal(h.transports.length,0);
    assert.throws(()=>parseRequest({v:1,id:'extra',generation:0,type:'connection.configure',payload:{poolHome:'/other/pool'}}));
  }finally{h.service.dispose();}
});

test('daemon startup is an explicit trusted real-Host action with an optional native adapter',async()=>{
  for(const [options,trusted,code]of [
    [{mode:'mock'},true,'ACTION_UNAVAILABLE'],
    [{mode:'real'},false,'WORKSPACE_UNTRUSTED'],
    [{mode:'real',supported:false},true,'UNSUPPORTED_PLATFORM'],
    [{mode:'real',configurationError:new HostError('INVALID_POOL_HOME','Invalid pool.')},true,'INVALID_POOL_HOME'],
  ]as const){
    const h=await harness(options,trusted);let started=0;h.native.startDaemon=async()=>{started++;};
    try{await assert.rejects(h.execute('daemon.start'),{code});assert.equal(started,0);assert.equal(h.transports.length,0);}finally{h.service.dispose();}
  }
  const h=await harness({mode:'real'});
  try{
    await assert.rejects(h.execute('daemon.start'),{code:'ACTION_UNAVAILABLE'});
    let started=0;h.native.startDaemon=async()=>{started++;};
    assert.deepEqual(await h.execute('daemon.start'),{started:true});assert.equal(started,1);assert.equal(h.transports.length,0);
    assert.throws(()=>parseRequest({v:1,id:'extra',generation:0,type:'daemon.start',payload:{command:'arbitrary'}}));
  }finally{h.service.dispose();}
});
