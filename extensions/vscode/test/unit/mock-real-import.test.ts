import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadMockFixture, MockTransport } from '../../src/host/mock.js';

const fixturePath = resolve(__dirname, '../fixtures/pool-demo.json');
const realAccountsPath = '/home/zgl/.local/share/zcode-pool/imports/zcode_accounts_2026-11-01.json';

test('MockTransport imports real account files and parses real quota structures', async () => {
  const fixture = await loadMockFixture(fixturePath);
  const transport = new MockTransport(fixture);

  // 1. Initial overview should have the 3 default sample accounts
  const initialOverview = (await transport.request('overview', {})) as any;
  assert.equal(initialOverview.accounts.length, 3);
  assert.equal(initialOverview.accounts[0].email, 'pjsc45sv1w@xenveroes.pro');
  assert.equal(initialOverview.accounts[0].plan, 'ZCODE WEEKEND BUILD');
  assert.equal(initialOverview.accounts[0].quota.total, 500_000_000);

  // 2. Import the real 28-account JSON export file
  const importResult = (await transport.request('import_accounts', {
    files: [realAccountsPath],
  })) as any;

  assert.equal(importResult.fileCount, 1);
  assert.equal(importResult.recordCount, 28);
  assert.equal(importResult.duplicateCount, 0);
  assert.equal(importResult.summaries.length, 28);

  // Verify first summary
  const firstSummary = importResult.summaries[0];
  assert.equal(firstSummary.email, 'pjsc45sv1w@xenveroes.pro');
  assert.equal(firstSummary.name, 'pjsc45sv1w@xenveroes.pro');
  assert.equal(firstSummary.provider, 'zai');
  assert.equal(firstSummary.health, 'available');
  assert.equal(firstSummary.plan, 'ZCODE WEEKEND BUILD');

  // Verify second summary
  const secondSummary = importResult.summaries[1];
  assert.equal(secondSummary.email, 'iloveyou@globalsmv.com');
  assert.equal(secondSummary.name, 'iloveyou');
  assert.equal(secondSummary.provider, 'zai');

  // 3. Check updated overview accounts in transport fixture
  const updatedOverview = (await transport.request('overview', {})) as any;
  // 3 initial + 28 imported = 31 accounts
  assert.equal(updatedOverview.accounts.length, 31);

  // Verify imported account details in overview
  const importedAcc = updatedOverview.accounts.find(
    (a: any) => a.email === 'pjsc45sv1w@xenveroes.pro' && a.alias !== 'account-demo'
  );
  assert.ok(importedAcc, 'Imported account should exist in overview');
  assert.equal(importedAcc.quota.total, 500_000_000);
  assert.equal(importedAcc.quota.used, 0);
  assert.equal(importedAcc.quota.remaining, 500_000_000);
  assert.ok(Array.isArray(importedAcc.quota.quota_raw));
  assert.equal(importedAcc.quota.quota_raw.length, 1);
  assert.equal(importedAcc.quota.quota_raw[0].show_name, 'GLM-5.3-Flash');
});

test('MockTransport deduplicates accounts on re-importing the same file', async () => {
  const fixture = await loadMockFixture(fixturePath);
  const transport = new MockTransport(fixture);

  // First import
  await transport.request('import_accounts', { files: [realAccountsPath] });

  // Second import with the same file
  const reimportResult = (await transport.request('import_accounts', {
    files: [realAccountsPath],
  })) as any;

  assert.equal(reimportResult.fileCount, 1);
  assert.equal(reimportResult.recordCount, 28);
  assert.equal(reimportResult.duplicateCount, 28);

  const overview = (await transport.request('overview', {})) as any;
  assert.equal(overview.accounts.length, 31, 'Deduplication must not create duplicate accounts');
});

test('MockTransport ui_get_quota and ui_probe_quota extract GLM-5.3-Flash token pool and fluctuate dynamically', async () => {
  const fixture = await loadMockFixture(fixturePath);
  const transport = new MockTransport(fixture);

  // Import real accounts
  const importResult = (await transport.request('import_accounts', { files: [realAccountsPath] })) as any;
  const importedAlias = importResult.summaries[0].alias;

  // 1. ui_get_quota (offline / imported snapshot)
  const getRes = (await transport.request('ui_get_quota', { account_id: importedAlias })) as any;
  const snap = getRes.data.imported;
  assert.ok(snap);
  assert.equal(snap.accountAlias, importedAlias);
  assert.equal(snap.tier, 'start');
  assert.equal(snap.tierName, 'ZCODE WEEKEND BUILD');
  assert.equal(snap.unit, 'tokens');
  assert.equal(snap.total, 500_000_000);
  assert.equal(snap.remaining, 500_000_000);
  assert.equal(snap.windows.length, 1);
  assert.equal(snap.windows[0].name, 'GLM-5.3-Flash');
  assert.equal(snap.windows[0].windowType, 'token_pool');
  assert.equal(snap.windows[0].total, 500_000_000);
  assert.equal(snap.windows[0].unit, 'tokens');

  // 2. First ui_probe_quota (live probe)
  const probe1 = (await transport.request('ui_probe_quota', { account_id: importedAlias })) as any;
  const live1 = probe1.data.live;
  assert.ok(live1);
  assert.equal(live1.tier, 'pro');
  assert.equal(live1.unit, 'requests');
  assert.equal(live1.windows.length, 2);
  assert.equal(live1.windows[0].name, '5小时周期');
  assert.equal(live1.windows[0].unit, '次');
  assert.equal(live1.windows[1].name, 'GLM-5.3-Flash');
  assert.equal(live1.windows[1].unit, 'tokens');
  assert.equal(live1.windows[1].total, 500_000_000);

  const tokenRemaining1 = live1.windows[1].remaining;

  // 3. Second ui_probe_quota: tokens should dynamically fluctuate
  const probe2 = (await transport.request('ui_probe_quota', { account_id: importedAlias })) as any;
  const live2 = probe2.data.live;
  const tokenRemaining2 = live2.windows[1].remaining;
  assert.notEqual(tokenRemaining1, tokenRemaining2, 'Live probe should dynamically update remaining token count');

  // 4. Third ui_probe_quota: tokens continue fluctuating
  const probe3 = (await transport.request('ui_probe_quota', { account_id: importedAlias })) as any;
  const live3 = probe3.data.live;
  const tokenRemaining3 = live3.windows[1].remaining;
  assert.notEqual(tokenRemaining2, tokenRemaining3, 'Live probe should continue dynamic fluctuation on subsequent calls');
});
