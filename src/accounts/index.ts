import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type AccountProvider = 'zai' | 'bigmodel';
export type AccountHealth = 'unknown' | 'available' | 'cooling' | 'blocked' | 'invalid';
export interface AccountSummary {
  alias: string;
  provider: AccountProvider;
  authMode: 'oauth';
  health: AccountHealth;
  plan?: string;
  quota?: { total?: number; used?: number; remaining?: number; updatedAt?: number };
  quotaRaw?: unknown;
  subscriptionRaw?: unknown;
  quotaResetAt?: number;
  email?: string;
  name?: string;
}

/** Sensitive internal value: never return this object through a public API or a log. */
export interface AccountCredentials {
  alias: string;
  provider: AccountProvider;
  userId: string;
  accessToken: string;
  zcodeJwtToken: string;
  refreshToken?: string;
  userInfo: Record<string, unknown>;
  /** Retains every actual export field, including refresh/expiry fields. */
  raw: Record<string, unknown>;
  health: AccountHealth;
}

export interface AccountImportResult {
  accounts: AccountCredentials[];
  summaries: AccountSummary[];
  recordCount: number;
  duplicateCount: number;
  fileCount: number;
}

/** Claims bind the imported profile to its ZCode token; cloud signature validity still needs a live probe. */
export function checkCredentialIdentity(account: Pick<AccountCredentials, 'userId' | 'zcodeJwtToken'>): 'matching' | 'unavailable' {
  const parts = account.zcodeJwtToken.split('.');
  if (parts.length !== 3) return 'unavailable';
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')); }
  catch { return 'unavailable'; }
  if (!object(payload)) return 'unavailable';
  const identity = string(payload.user_id) ?? string(payload.sub);
  if (!identity) return 'unavailable';
  if (identity !== account.userId) throw new Error('ZCode token identity does not match imported account');
  return 'matching';
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function normalizeAccount(raw: unknown, index: number): AccountCredentials {
  if (!object(raw)) throw new Error(`Account export record ${index} must be an object`);
  const provider = string(raw.provider)?.toLowerCase();
  if (provider !== 'zai' && provider !== 'bigmodel') throw new Error(`Account export record ${index} has unsupported provider`);
  if (raw.auth_mode !== undefined && raw.auth_mode !== 'oauth') throw new Error(`Account export record ${index} must use OAuth; paid API keys are not imported`);
  const profile = object(raw.user_info_raw) ? structuredClone(raw.user_info_raw) : {};
  // Prefer the explicit stable exported identity. Email is only a last-resort identifier.
  const userId = string(raw.user_id) ?? string(profile.id) ?? string(profile.user_id) ?? string(profile.sub) ?? string(raw.email)?.toLowerCase();
  if (!userId) throw new Error(`Account export record ${index} lacks a stable identity`);
  const accessToken = string(raw.access_token);
  const zcodeJwtToken = string(raw.zcode_jwt_token);
  if (!accessToken || !zcodeJwtToken) throw new Error(`Account export record ${index} lacks required OAuth credentials`);
  const alias = `account-${createHash('sha256').update(`${provider}:${userId}`).digest('hex').slice(0, 12)}`;
  const userInfo = Object.keys(profile).length ? profile : {
    user_id: userId,
    email: string(raw.email),
    name: string(raw.display_name),
    avatar: string(raw.avatar_url),
  };
  const account: AccountCredentials = { alias, provider, userId, accessToken, zcodeJwtToken, refreshToken: string(raw.refresh_token), userInfo, raw: structuredClone(raw), health: 'unknown' };
  checkCredentialIdentity(account);
  return account;
}

export function accountSummary(account: AccountCredentials): AccountSummary {
  const quota = {
    total: number(account.raw.quota_total), used: number(account.raw.quota_used),
    remaining: number(account.raw.quota_remaining), updatedAt: number(account.raw.usage_updated_at),
  };
  const quotaRaw = account.raw.quota_raw ?? account.raw.balances;
  const subscriptionRaw = account.raw.subscription_raw ?? account.raw.plans;
  const quotaResetAt = number(account.raw.quota_reset_at);
  const email = string(account.userInfo?.email) ?? string(account.raw?.email);
  const name = string(account.userInfo?.name) ?? string(account.raw?.display_name);
  return {
    alias: account.alias, provider: account.provider, authMode: 'oauth', health: account.health,
    ...(string(account.raw.plan_type) ? { plan: string(account.raw.plan_type) } : {}),
    ...(Object.values(quota).some(value => value !== undefined) ? { quota } : {}),
    ...(quotaRaw !== undefined ? { quotaRaw } : {}),
    ...(subscriptionRaw !== undefined ? { subscriptionRaw } : {}),
    ...(quotaResetAt !== undefined ? { quotaResetAt } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}

/** Input paths and parse errors are deliberately absent from errors: filenames may contain emails. */
export async function loadAccountExports(paths: readonly string[]): Promise<AccountImportResult> {
  const unique = new Map<string, AccountCredentials>();
  let recordCount = 0;
  for (let fileIndex = 0; fileIndex < paths.length; fileIndex++) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(paths[fileIndex]!, 'utf8')); }
    catch { throw new Error(`Unable to read account export file ${fileIndex + 1}`); }
    const records = Array.isArray(parsed) ? parsed : object(parsed) && Array.isArray(parsed.accounts) ? parsed.accounts : [parsed];
    for (const raw of records) {
      const account = normalizeAccount(raw, ++recordCount);
      const previous = unique.get(account.alias);
      // A newer export wins. Do not combine credentials from different export generations.
      const updated = number(account.raw.usage_updated_at) ?? number(account.raw.last_used) ?? number(account.raw.created_at) ?? 0;
      const previousUpdated = previous ? number(previous.raw.usage_updated_at) ?? number(previous.raw.last_used) ?? number(previous.raw.created_at) ?? 0 : -1;
      if (!previous || updated >= previousUpdated) unique.set(account.alias, account);
    }
  }
  const accounts = [...unique.values()];
  return { accounts, summaries: accounts.map(accountSummary), recordCount, duplicateCount: recordCount - accounts.length, fileCount: paths.length };
}

/** Official ZCode/Cockpit format: SHA256(secret), AES-256-GCM, base64url IV/tag/ciphertext. */
export function encryptCredential(plaintext: string, secret: string): string {
  if (!secret) throw new Error('Credential secret is required');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptCredential(value: string, secret: string): string {
  if (!value.startsWith('enc:v1:')) return value;
  try {
    const parts = value.slice(7).split('.');
    if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64url'));
    if (iv!.length !== 12 || tag!.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8');
  } catch { throw new Error('Credential decrypt failed: key mismatch or corrupted ciphertext'); }
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private storage directory must not be a symlink');
  await chmod(path, 0o700);
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/** Encrypted at rest. Public list() returns account health and metadata, never credentials. */
export class AccountVault {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async #secret(): Promise<string> {
    await privateDirectory(this.root);
    const path = join(this.root, '.secret');
    try { await writeFile(path, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Unable to initialize account vault'); }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('Unsafe account vault secret file');
    await chmod(path, 0o600);
    const secret = await readFile(path, 'utf8');
    if (!secret.trim()) throw new Error('Account vault secret is empty');
    return secret;
  }
  async import(paths: readonly string[]): Promise<{ accounts: AccountSummary[]; recordCount: number; duplicateCount: number; fileCount: number }> {
    const result = await loadAccountExports(paths);
    const secret = await this.#secret();
    for (const account of result.accounts) await writePrivateJson(join(this.root, `${account.alias}.json`), { version: 1, encrypted: encryptCredential(JSON.stringify(account), secret) });
    return { accounts: result.summaries, recordCount: result.recordCount, duplicateCount: result.duplicateCount, fileCount: result.fileCount };
  }
  async load(alias: string): Promise<AccountCredentials> {
    if (!/^account-[a-f0-9]{12}$/.test(alias)) throw new Error('Invalid account alias');
    const secret = await this.#secret();
    try {
      const path = join(this.root, `${alias}.json`);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error();
      const stored = JSON.parse(await readFile(path, 'utf8')) as { version: number; encrypted: string };
      if (stored.version !== 1 || typeof stored.encrypted !== 'string' || !stored.encrypted.startsWith('enc:v1:')) throw new Error();
      const account = JSON.parse(decryptCredential(stored.encrypted, secret)) as AccountCredentials;
      if (account.alias !== alias || !account.accessToken || !account.zcodeJwtToken) throw new Error();
      return account;
    } catch { throw new Error('Unable to load encrypted account'); }
  }
  async list(): Promise<AccountSummary[]> {
    await this.#secret();
    const files = (await readdir(this.root)).filter(name => /^account-[a-f0-9]{12}\.json$/.test(name)).sort();
    return Promise.all(files.map(async name => accountSummary(await this.load(name.slice(0, -5)))));
  }
  async setHealth(alias: string, health: AccountHealth): Promise<void> {
    if (!['unknown', 'available', 'cooling', 'blocked', 'invalid'].includes(health)) throw new Error('Invalid account health');
    const account = await this.load(alias);
    account.health = health;
    const secret = await this.#secret();
    await writePrivateJson(join(this.root, `${alias}.json`), { version: 1, encrypted: encryptCredential(JSON.stringify(account), secret) });
  }
}
