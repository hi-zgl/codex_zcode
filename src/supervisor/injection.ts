import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { checkCredentialIdentity, decryptCredential, encryptCredential, privateDirectory, writePrivateJson, type AccountCredentials } from '../accounts/index.js';

export interface InjectedIdentity {
  alias: string;
  provider: 'zai' | 'bigmodel';
  matched: boolean;
  source: 'injected-credentials';
  /** Only a live runtime/remote probe can establish credential validity or plan availability. */
  credentialValidity: 'unknown';
  tokenIdentity: 'matching' | 'unavailable';
}

/**
 * Official sourceHeaders.ts requires the existing physical-machine deviceMid from this
 * state file. The headless Server does not create it. Keep the real machine identity
 * consistent across Workers; account credentials, sessions and databases remain isolated.
 * Never invent or rotate device identities to get around an account or service restriction.
 */
export async function initializeMachineIdentity(workerRoot: string, sourceFile = join(homedir(), '.zcode/v2/telemetry-state.json')): Promise<boolean> {
  let state: Record<string, unknown>;
  try { state = JSON.parse(await readFile(sourceFile, 'utf8')) as Record<string, unknown>; }
  catch { return false; }
  if (typeof state.deviceMid !== 'string' || !state.deviceMid.trim() || state.deviceMid.length > 256 || !/^[\x20-\x7e]+$/.test(state.deviceMid)) throw new Error('Existing machine identity state is invalid');
  const targetRoot = join(workerRoot, 'data/.zcode/v2');
  for (const path of [workerRoot, join(workerRoot, 'data'), join(workerRoot, 'data/.zcode'), targetRoot]) await privateDirectory(path);
  await writePrivateJson(join(targetRoot, 'telemetry-state.json'), { deviceMid: state.deviceMid });
  return true;
}

/** Matches Cockpit's write_account_to_credentials_path and write_auth_mode_to_settings_path. */
export async function injectAccount(workerRoot: string, account: AccountCredentials, secret: string): Promise<InjectedIdentity> {
  if (!secret || secret !== secret.trim()) throw new Error('A nonblank credential secret without surrounding whitespace is required');
  if (!account.accessToken || !account.zcodeJwtToken) throw new Error('Required OAuth credentials are missing');
  checkCredentialIdentity(account);
  for (const path of [workerRoot, join(workerRoot, 'data'), join(workerRoot, 'data/.zcode'), join(workerRoot, 'data/.zcode/v2')]) await privateDirectory(path);
  const path = join(workerRoot, 'data/.zcode/v2/credentials.json');
  // A Worker has exactly one account. Replace the whole credentials file to prevent stale credentials.
  const values: Record<string, string> = {
    'oauth:active_provider': encryptCredential(account.provider, secret),
    [`oauth:${account.provider}:access_token`]: encryptCredential(account.accessToken, secret),
    [`oauth:${account.provider}:user_info`]: encryptCredential(JSON.stringify(account.userInfo), secret),
    zcodejwttoken: encryptCredential(account.zcodeJwtToken, secret),
  };
  if (account.refreshToken) values[`oauth:${account.provider}:refresh_token`] = encryptCredential(account.refreshToken, secret);
  await writePrivateJson(path, values);
  await writePrivateJson(join(workerRoot, 'data/.zcode/v2/setting.json'), {
    providerFamilyDomain: account.provider,
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
    modelProviderFamilyModes: { [account.provider]: 'oauth' },
    // Current Server understands this explicit selection; never choose a paid plan by fallback.
    providerFamilyConnectionSelections: { [account.provider]: { kind: 'start-plan' } },
  });
  return verifyInjectedIdentity(workerRoot, account, secret);
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyInjectedIdentity(workerRoot: string, account: AccountCredentials, secret: string): Promise<InjectedIdentity> {
  try {
    const values = JSON.parse(await readFile(join(workerRoot, 'data/.zcode/v2/credentials.json'), 'utf8')) as Record<string, string>;
    const get = (key: string): string => decryptCredential(values[key] ?? '', secret);
    const user = JSON.parse(get(`oauth:${account.provider}:user_info`)) as Record<string, unknown>;
    const identity = user.id ?? user.user_id ?? user.sub;
    const importedIdentity = account.userInfo.id ?? account.userInfo.user_id ?? account.userInfo.sub ?? account.userId;
    const settings = JSON.parse(await readFile(join(workerRoot, 'data/.zcode/v2/setting.json'), 'utf8'));
    const match = get('oauth:active_provider') === account.provider && identity === importedIdentity &&
      equal(get(`oauth:${account.provider}:access_token`), account.accessToken) && equal(get('zcodejwttoken'), account.zcodeJwtToken) &&
      settings.providerFamilyDomain === account.provider && settings.modelProviderFamilyModes?.[account.provider] === 'oauth' &&
      settings.providerFamilyConnectionSelections?.[account.provider]?.kind === 'start-plan';
    if (!match) throw new Error();
    return { alias: account.alias, provider: account.provider, matched: true, source: 'injected-credentials', credentialValidity: 'unknown', tokenIdentity: checkCredentialIdentity(account) };
  } catch { throw new Error('Injected account identity or provider settings do not match'); }
}
