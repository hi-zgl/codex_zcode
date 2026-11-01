import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import { AccountVault, checkCredentialIdentity, decryptCredential, encryptCredential, loadAccountExports } from '../../src/accounts/index.js';

const fixture = (overrides: Record<string, unknown> = {}) => ({
  provider: 'zai', auth_mode: 'oauth', user_id: 'user-123', email: 'private@example.test',
  access_token: 'private-access-token', zcode_jwt_token: 'private-jwt-token', refresh_token: 'private-refresh-token',
  expires_at: 1890000000, usage_updated_at: 100, quota_remaining: 42,
  user_info_raw: { id: 'user-123', email: 'private@example.test', name: 'private name' }, ...overrides,
});

test('a mislabeled account cannot inject a ZCode JWT belonging to another imported identity', () => {
  const token = `header.${Buffer.from(JSON.stringify({ user_id: 'user-123', sub: 'user-123' })).toString('base64url')}.signature`;
  assert.equal(checkCredentialIdentity({ userId: 'user-123', zcodeJwtToken: token }), 'matching');
  assert.throws(() => checkCredentialIdentity({ userId: 'another-user', zcodeJwtToken: token }), /identity does not match/);
  assert.equal(checkCredentialIdentity({ userId: 'user-123', zcodeJwtToken: 'opaque-token' }), 'unavailable');
});

test('exports deduplicate provider plus stable identity and retain actual refresh/expiry fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-account-'));
  try {
    await writeFile(join(root, 'one.json'), JSON.stringify([fixture(), fixture({ user_id: 'other-user', user_info_raw: { id: 'other-user' } })]));
    await writeFile(join(root, 'two.json'), JSON.stringify({ accounts: [fixture({ access_token: 'updated-token', usage_updated_at: 200 })] }));
    const result = await loadAccountExports([join(root, 'one.json'), join(root, 'two.json')]);
    assert.equal(result.recordCount, 3);
    assert.equal(result.accounts.length, 2);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.accounts[0]!.accessToken, 'updated-token');
    assert.equal(result.accounts[0]!.refreshToken, 'private-refresh-token');
    assert.equal(result.accounts[0]!.raw.expires_at, 1890000000);
    const publicJson = JSON.stringify(result.summaries);
    for (const secret of ['private@example.test', 'private-access-token', 'updated-token', 'private-jwt-token', 'user-123']) assert.equal(publicJson.includes(secret), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('official AES-GCM envelope interoperates with the official crypto recipe and rejects wrong keys', () => {
  const encrypted = encryptCredential('fixture token', 'dedicated-secret');
  const [iv, tag, content] = encrypted.slice('enc:v1:'.length).split('.').map(part => Buffer.from(part, 'base64url'));
  const official = createDecipheriv('aes-256-gcm', createHash('sha256').update('dedicated-secret').digest(), iv!);
  official.setAuthTag(tag!);
  assert.equal(Buffer.concat([official.update(content!), official.final()]).toString('utf8'), 'fixture token');
  assert.equal(decryptCredential(encrypted, 'dedicated-secret'), 'fixture token');
  assert.throws(() => decryptCredential(encrypted, 'wrong-key'), /key mismatch/);
  assert.throws(() => decryptCredential('enc:v1:malformed', 'dedicated-secret'), /Credential decrypt failed/);
});

test('vault persists only ciphertext and returns credential-free public account health', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-vault-'));
  try {
    const exportFile = join(root, 'source.json');
    await writeFile(exportFile, JSON.stringify([fixture()]));
    const vault = new AccountVault(join(root, 'vault'));
    const imported = await vault.import([exportFile]);
    const alias = imported.accounts[0]!.alias;
    const stored = await readFile(join(root, 'vault', `${alias}.json`), 'utf8');
    assert.equal(stored.includes('private'), false);
    assert.equal(stored.includes('user-123'), false);
    assert.equal((await stat(join(root, 'vault'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'vault', '.secret'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'vault', `${alias}.json`))).mode & 0o777, 0o600);
    assert.equal((await vault.load(alias)).accessToken, 'private-access-token');
    await vault.setHealth(alias, 'cooling');
    assert.equal((await vault.list())[0]!.health, 'cooling');
    assert.equal(JSON.stringify(await vault.list()).includes('private'), false);
    await assert.rejects(vault.load('../escape'), /Invalid account alias/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid exports never echo paths, emails, tokens or JSON parser payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-invalid-'));
  try {
    const path = join(root, 'private@example.test.json');
    await writeFile(path, '{ "private-token": broken');
    await assert.rejects(loadAccountExports([path]), error => {
      assert.equal(String(error).includes('private'), false);
      return true;
    });
    await writeFile(path, JSON.stringify([fixture({ auth_mode: 'api_key', access_token: 'SECRET' })]));
    await assert.rejects(loadAccountExports([path]), /must use OAuth/);
    await writeFile(path, JSON.stringify([fixture({ user_id: '', user_info_raw: {}, email: '' })]));
    await assert.rejects(loadAccountExports([path]), /stable identity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
