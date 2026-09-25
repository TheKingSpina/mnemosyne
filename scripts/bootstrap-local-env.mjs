import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { resolve } from 'node:path';

const root = resolve('.');
const envPath = resolve(root, '.env');
try {
  await stat(envPath);
  throw new Error('local_env_already_exists');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const example = await readFile(resolve(root, '.env.example'), 'utf8');
const password = randomBytes(32).toString('hex');
const values = new Map([
  ['POSTGRES_PASSWORD', password],
  ['DATABASE_URL', `postgresql://mnemosyne:${password}@127.0.0.1:5432/mnemosyne`],
  ['MNEMOSYNE_OWNER_TOKEN', randomBytes(32).toString('hex')],
  ['MNEMOSYNE_HARNESS_TOKEN', randomBytes(32).toString('hex')],
  ['MNEMOSYNE_FORGET_SECRET', randomBytes(32).toString('hex')],
  ['NEO4J_PASSWORD', randomBytes(32).toString('hex')],
  ['WEB_BIND_HOST', '127.0.0.1'],
  ['EXTRACTION_PROVIDER', 'local'],
  ['OPENROUTER_API_KEY', ''],
  ['OPENROUTER_MODEL', ''],
]);
const content = `${example
  .split('\n')
  .map((line) => {
    const separator = line.indexOf('=');
    if (separator < 0) return line;
    const key = line.slice(0, separator);
    const value = values.get(key);
    return value === undefined ? line : `${key}=${value}`;
  })
  .join('\n')}\n`;
await writeFile(envPath, content, { mode: 0o600, flag: 'wx' });
process.stdout.write(`Local environment created: ${envPath}\n`);
