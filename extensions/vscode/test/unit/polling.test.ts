import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PollCoordinator} from '../../src/host/polling.js';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('a successful explicit refresh satisfies discovery and idle pools only wake at the overview interval',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100_000});
  let refreshes=0,waits=0;
  const errors:unknown[]=[];
  const poll=new PollCoordinator(async()=>{refreshes++;},async()=>{waits++;return 'idle';},()=>30_000,error=>errors.push(error));
  t.after(()=>poll.dispose());
  await poll.requestRefresh();
  poll.setVisible(true);t.mock.timers.tick(0);await flush();
  assert.equal(refreshes,1);assert.equal(waits,1);
  t.mock.timers.tick(29_999);await flush();
  assert.equal(refreshes,1);assert.equal(waits,1);
  t.mock.timers.tick(1);await flush();
  assert.equal(refreshes,2);assert.equal(waits,2);
  poll.setVisible(false);t.mock.timers.tick(90_000);await flush();
  assert.equal(refreshes,2);assert.equal(waits,2);assert.deepEqual(errors,[]);
});

test('manual refresh moves the next idle overview discovery without an extra overview',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100_000});
  let refreshes=0;
  const poll=new PollCoordinator(async()=>{refreshes++;},async()=>'idle',()=>30_000,()=>{});
  t.after(()=>poll.dispose());
  poll.setVisible(true);t.mock.timers.tick(0);await flush();
  t.mock.timers.tick(10_000);await poll.requestRefresh();
  t.mock.timers.tick(20_000);await flush();
  assert.equal(refreshes,2);
  t.mock.timers.tick(10_000);await flush();
  assert.equal(refreshes,3);
});

test('explicit refresh wakes idle observation when new active work is discovered',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100_000});
  let idle=true,waits=0,refreshes=0;
  const poll=new PollCoordinator(async()=>{refreshes++;},async()=>{waits++;return idle?'idle':true;},()=>30_000,()=>{});
  t.after(()=>poll.dispose());
  poll.setVisible(true);t.mock.timers.tick(0);await flush();
  t.mock.timers.tick(1_000);idle=false;await poll.requestRefresh();
  t.mock.timers.tick(0);await flush();
  assert.equal(refreshes,2);assert.equal(waits,2);
});

test('shortening the overview interval reschedules an existing idle timer',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100_000});
  let interval=300_000,refreshes=0;
  const poll=new PollCoordinator(async()=>{refreshes++;},async()=>'idle',()=>interval,()=>{});
  t.after(()=>poll.dispose());
  poll.setVisible(true);t.mock.timers.tick(0);await flush();
  t.mock.timers.tick(15_000);interval=15_000;poll.intervalChanged();
  t.mock.timers.tick(0);await flush();
  assert.equal(refreshes,2);
});

test('concurrent writes share a fresh overview started after the in-flight refresh',async()=>{
  const releases:(()=>void)[]=[];
  let refreshes=0;
  const poll=new PollCoordinator(async()=>{refreshes++;await new Promise<void>(resolve=>releases.push(resolve));},async()=>false,()=>30_000,()=>{});
  try{
    const first=poll.requestRefresh();
    const second=poll.requestRefresh(true);const third=poll.requestRefresh(true);
    assert.equal(refreshes,1);
    releases[0]!();await first;await flush();
    assert.equal(refreshes,2);
    releases[1]!();await Promise.all([second,third]);
    assert.equal(refreshes,2);
  }finally{poll.dispose();}
});

test('reset prevents a new connection from joining or being cleared by an old refresh',async()=>{
  const releases:(()=>void)[]=[];
  let refreshes=0;
  const poll=new PollCoordinator(async()=>{refreshes++;await new Promise<void>(resolve=>releases.push(resolve));},async()=>false,()=>30_000,()=>{});
  try{
    const old=poll.requestRefresh();const oldFollowup=poll.requestRefresh(true);
    poll.reset();const current=poll.requestRefresh();
    assert.equal(refreshes,2);
    releases[0]!();await Promise.all([old,oldFollowup]);
    assert.equal(poll.requestRefresh(),current);assert.equal(refreshes,2);
    releases[1]!();await current;
  }finally{poll.dispose();}
});
