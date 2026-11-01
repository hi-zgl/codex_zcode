import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexMcpConfig, codexSetupDocument } from '../../src/host/codex-setup.js';

test('Codex setup emits only the stable STDIO server and shared profile configuration', () => {
  const config = codexMcpConfig({ nodePath: '/opt/node24/bin/node', cliPath: '/storage/runtime/bin/zcode-pool.mjs', profilePath: '/storage/connection.json' });
  assert.equal(config, `[mcp_servers.zcode_pool]
command = "/opt/node24/bin/node"
args = ["/storage/runtime/bin/zcode-pool.mjs", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.zcode_pool.env]
ZCODE_POOL_CONNECTION_FILE = "/storage/connection.json"
`);
  assert.doesNotMatch(config, /approval_policy|auto_approve|sandbox_mode|full.access|dangerously|bypass|ZCODE_POOL_HOME|node_modules|--import/i);
});

test('quotes, backslashes, Unicode and newline injection remain literal path values', () => {
  const paths = {
    nodePath: '/opt/node "quoted" \\ 好 $(touch nope);/node',
    cliPath: '/storage/line\n[mcp_servers.injected]\ncommand = "bad"/zcode-pool.mjs',
    profilePath: "/storage/tab\treturn\r ' ${HOME} 你好/connection.json",
  };
  const config = codexMcpConfig(paths);
  const command = /^command = (.+)$/m.exec(config)?.[1];
  const args = /^args = (.+)$/m.exec(config)?.[1];
  const profile = /^ZCODE_POOL_CONNECTION_FILE = (.+)$/m.exec(config)?.[1];
  assert.ok(command && args && profile);
  assert.equal(JSON.parse(command), paths.nodePath);
  assert.deepEqual(JSON.parse(args), [paths.cliPath, 'mcp']);
  assert.equal(JSON.parse(profile), paths.profilePath);
  assert.equal(config.split('\n').filter(line => line.startsWith('[')).length, 2, 'path content must not create another TOML table');
  assert.equal(config.split('\n').filter(line => line.startsWith('command =')).length, 1);
});

test('invalid execution-side paths are rejected before a configuration can be generated', () => {
  const paths = { nodePath: '/node', cliPath: '/runtime/bin/zcode-pool.mjs', profilePath: '/connection.json' };
  for (const key of ['nodePath', 'cliPath', 'profilePath'] as const) {
    for (const value of ['', 'relative/path', '~/.codex/config.toml', '"/quoted/path"', '/nul\0path']) {
      assert.throws(() => codexMcpConfig({ ...paths, [key]: value }), { code: 'INVALID_ARGUMENT' });
    }
  }
});

test('setup document presents a manual configuration step without claiming registration or approval', () => {
  const config = codexMcpConfig({ nodePath: '/node24', cliPath: '/stable/bin/zcode-pool.mjs', profilePath: '/shared/connection.json' });
  const document = codexSetupDocument({ config, host: 'linux-execution-host', poolHome: '/pool', version: '0.1.0' });
  assert.ok(document.includes('```toml\n' + config + '```'));
  assert.match(document, /此文档仅生成配置，没有修改你的 Codex 设置，也不能证明 Codex 已连接/);
  assert.match(document, /已经存在 mcp_servers\.zcode_pool.*不要重复追加/);
  assert.match(document, /关闭 VS Code 后仍可使用/);
  assert.match(document, /不会自动启动账号实例或模型任务/);
  assert.match(document, /新的 MCP 工具调用也会读取该目录/);
  assert.match(document, /Node\.js 24\+/);
  assert.doesNotMatch(document, /approval_policy|auto_approve|sandbox_mode|dangerously|bypass|自动批准/i);
});
