import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import { AccountVault, accountSummary, checkCredentialIdentity, decryptCredential, encryptCredential, loadAccountExports } from '../../src/accounts/index.js';

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
    assert.equal(result.summaries[0]!.email, 'private@example.test');
    assert.equal(result.summaries[0]!.name, 'private name');
    const publicJson = JSON.stringify(result.summaries);
    for (const secret of ['private-access-token', 'updated-token', 'private-jwt-token', 'user-123']) assert.equal(publicJson.includes(secret), false);
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
    assert.equal((await vault.list())[0]!.email, 'private@example.test');
    assert.equal((await vault.list())[0]!.name, 'private name');
    const vaultListJson = JSON.stringify(await vault.list());
    for (const secret of ['private-access-token', 'private-jwt-token', 'user-123']) assert.equal(vaultListJson.includes(secret), false);
    await assert.rejects(vault.load('../escape'), /Invalid account alias/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('vault keeps newer stored exports, health and snapshots across old and repeated imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-reimport-'));
  try {
    const exportFile = join(root, 'source.json');
    const latest = fixture({
      usage_updated_at: 200, access_token: 'new-access', zcode_jwt_token: 'new-jwt', refresh_token: 'new-refresh',
      quota_remaining: 7, quota_raw: [{ remaining_units: 7 }], subscription_raw: [{ name: 'current-plan' }],
    });
    await writeFile(exportFile, JSON.stringify([latest, fixture({ user_id: 'other-user', user_info_raw: { id: 'other-user' } })]));
    const vault = new AccountVault(join(root, 'vault'));
    const imported = await vault.import([exportFile]);
    const alias = imported.accounts[0]!.alias;
    const otherAlias = imported.accounts[1]!.alias;
    await vault.setHealth(alias, 'cooling');
    const stored = await vault.load(alias);
    const ciphertext = await readFile(join(root, 'vault', `${alias}.json`), 'utf8');
    const other = await vault.load(otherAlias);

    await writeFile(exportFile, JSON.stringify([fixture(), fixture()]));
    const old = await vault.import([exportFile]);
    assert.deepEqual(old, { accounts: [accountSummary(stored)], recordCount: 2, duplicateCount: 1, fileCount: 1 });
    assert.deepEqual(await vault.load(alias), stored);
    assert.equal(await readFile(join(root, 'vault', `${alias}.json`), 'utf8'), ciphertext);
    assert.deepEqual(await vault.load(otherAlias), other);
    assert.equal((await vault.list()).length, 2);

    await writeFile(exportFile, JSON.stringify([latest]));
    const repeated = await vault.import([exportFile]);
    assert.deepEqual(repeated.accounts, [accountSummary(stored)]);
    assert.equal(repeated.duplicateCount, 0);
    assert.deepEqual(await vault.load(alias), stored);
    assert.equal(await readFile(join(root, 'vault', `${alias}.json`), 'utf8'), ciphertext);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('newer metadata preserves health while a new credential generation needs another probe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-update-'));
  try {
    const exportFile = join(root, 'source.json');
    await writeFile(exportFile, JSON.stringify([fixture()]));
    const vault = new AccountVault(join(root, 'vault'));
    const alias = (await vault.import([exportFile])).accounts[0]!.alias;
    await vault.setHealth(alias, 'available');

    const metadata = fixture({ usage_updated_at: 200, quota_remaining: 12, user_info_raw: { id: 'user-123', name: 'updated name' } });
    await writeFile(exportFile, JSON.stringify([metadata]));
    const updated = await vault.import([exportFile]);
    const sameCredentials = await vault.load(alias);
    assert.equal(sameCredentials.health, 'available');
    assert.deepEqual(sameCredentials.raw, metadata);
    assert.deepEqual(updated.accounts, [accountSummary(sameCredentials)]);
    assert.equal(updated.accounts[0]!.quota!.remaining, 12);

    const credentials = fixture({
      usage_updated_at: 300, access_token: 'next-access', zcode_jwt_token: 'next-jwt',
      refresh_token: undefined, expires_at: undefined, quota_remaining: 3,
    });
    await writeFile(exportFile, JSON.stringify([credentials]));
    const replaced = await vault.import([exportFile]);
    const saved = await vault.load(alias);
    assert.equal(replaced.accounts[0]!.alias, alias);
    assert.equal(saved.health, 'unknown');
    assert.equal(saved.accessToken, 'next-access');
    assert.equal(saved.zcodeJwtToken, 'next-jwt');
    assert.equal(saved.refreshToken, undefined);
    assert.deepEqual(saved.raw, JSON.parse(JSON.stringify(credentials)));
    assert.deepEqual(replaced.accounts, [accountSummary(saved)]);

    await vault.setHealth(alias, 'invalid');
    await writeFile(exportFile, JSON.stringify([fixture({ ...credentials, usage_updated_at: 400, refresh_token: 'next-refresh' })]));
    await vault.import([exportFile]);
    assert.equal((await vault.load(alias)).health, 'unknown');
    assert.equal((await vault.load(alias)).refreshToken, 'next-refresh');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('equal or missing export times cannot replace a stored credential generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-ambiguous-import-'));
  try {
    const cases = [
      { existing: { usage_updated_at: 100 }, incoming: { usage_updated_at: 100 } },
      { existing: { usage_updated_at: 100 }, incoming: { usage_updated_at: undefined } },
      { existing: { usage_updated_at: undefined }, incoming: { usage_updated_at: undefined } },
    ];
    for (const [index, times] of cases.entries()) {
      const exportFile = join(root, `source-${index}.json`);
      const vault = new AccountVault(join(root, `vault-${index}`));
      await writeFile(exportFile, JSON.stringify([fixture(times.existing)]));
      const alias = (await vault.import([exportFile])).accounts[0]!.alias;
      await vault.setHealth(alias, 'blocked');
      const stored = await vault.load(alias);
      await writeFile(exportFile, JSON.stringify([fixture({ ...times.incoming, access_token: 'unproven-access', quota_remaining: 1 })]));
      const result = await vault.import([exportFile]);
      assert.deepEqual(await vault.load(alias), stored);
      assert.deepEqual(result.accounts, [accountSummary(stored)]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('export recency compares quota milliseconds with account use and creation seconds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-import-times-'));
  try {
    const quotaFile = join(root, 'quota.json');
    const useFile = join(root, 'use.json');
    const creationFile = join(root, 'creation.json');
    await writeFile(quotaFile, JSON.stringify([fixture({ usage_updated_at: 1_700_000_000_000, last_used: 1_700_000_300 })]));
    await writeFile(useFile, JSON.stringify([fixture({ access_token: 'later-use', usage_updated_at: undefined, last_used: 1_700_000_100 })]));
    await writeFile(creationFile, JSON.stringify([fixture({ access_token: 'later-creation', usage_updated_at: undefined, created_at: 1_700_000_200 })]));
    const batch = await loadAccountExports([creationFile, useFile, quotaFile]);
    assert.equal(batch.accounts[0]!.accessToken, 'later-creation');

    const vault = new AccountVault(join(root, 'vault'));
    const alias = (await vault.import([quotaFile])).accounts[0]!.alias;
    await vault.import([useFile]);
    assert.equal((await vault.load(alias)).accessToken, 'later-use');
    await vault.import([creationFile]);
    assert.equal((await vault.load(alias)).accessToken, 'later-creation');
    const beforeOldImport = await vault.load(alias);
    await vault.import([quotaFile]);
    assert.deepEqual(await vault.load(alias), beforeOldImport);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unreadable stored account is not treated as absent during import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-corrupt-import-'));
  try {
    const exportFile = join(root, 'source.json');
    await writeFile(exportFile, JSON.stringify([fixture()]));
    const vault = new AccountVault(join(root, 'vault'));
    const alias = (await vault.import([exportFile])).accounts[0]!.alias;
    const accountFile = join(root, 'vault', `${alias}.json`);
    await writeFile(accountFile, '{invalid ciphertext');
    await writeFile(exportFile, JSON.stringify([fixture({ usage_updated_at: 200 })]));
    await assert.rejects(vault.import([exportFile]), /Unable to load encrypted account/);
    assert.equal(await readFile(accountFile, 'utf8'), '{invalid ciphertext');
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

test('accountSummary retains quota_raw, subscription_raw and quota_reset_at', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-summary-'));
  try {
    const rawAccount = fixture({
      quota_total: 500000000,
      quota_remaining: 500000000,
      quota_reset_at: 1793581200,
      plan_type: 'ZCODE WEEKEND BUILD',
      subscription_raw: [{ name: 'ZCODE WEEKEND BUILD', plan_id: 'zcode-v3-start-plan-1030-wk' }],
      quota_raw: [{ show_name: 'GLM-5.3-Flash', total_units: 500000000, unit_type: 'token' }],
    });
    const path = join(root, 'accounts.json');
    await writeFile(path, JSON.stringify([rawAccount]));
    const result = await loadAccountExports([path]);
    assert.equal(result.summaries.length, 1);
    const summary = result.summaries[0]!;
    assert.equal(summary.plan, 'ZCODE WEEKEND BUILD');
    assert.equal(summary.quotaResetAt, 1793581200);
    assert.deepEqual(summary.subscriptionRaw, [{ name: 'ZCODE WEEKEND BUILD', plan_id: 'zcode-v3-start-plan-1030-wk' }]);
    assert.deepEqual(summary.quotaRaw, [{ show_name: 'GLM-5.3-Flash', total_units: 500000000, unit_type: 'token' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

