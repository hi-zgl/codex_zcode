import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRpc } from '../../src/daemon/server.js';
import { rpcCall } from '../../src/shared/rpc.js';

test('daemon serves multiple stateless clients and prevents second owner', async () => {
  const root = await mkdtemp(join(tmpdir(),'zpool-rpc-'));
  const service = await serveRpc(root, async (method,params) => {
    if(method === 'fail') throw new Error('Expected failure');
    return {method,params};
  });
  try {
    assert.deepEqual(await rpcCall('ping',{value:'你好'}, {root}), {method:'ping', params:{value:'你好'}});
    await assert.rejects(rpcCall('fail',{}, {root}), /Expected failure/);
    await assert.rejects(serveRpc(root,async()=>null), /already running/);
    assert.deepEqual(await rpcCall('again',{}, {root}), {method:'again',params:{}});
  } finally {await service.close(); await rm(root,{recursive:true,force:true});}
});
