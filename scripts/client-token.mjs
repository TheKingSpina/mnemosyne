import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Mints, lists and revokes the per-client tokens that authenticate an MCP or API
// client. It runs on the machine of the client and talks to the API over the
// tailnet, so the deployment .env is never edited to add or remove a credential.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `usage: node scripts/client-token.mjs --base-url <url> [options]

  --base-url <url>   API root, e.g. https://mac-mini-di-alessandro-2.tail82e37f.ts.net/api/backend
  --name <slug>      mint a token for this client and print it once
  --list             list client tokens with prefix and last use
  --revoke <slug>    revoke a client token by name
  --token-file <p>   file holding the owner token (default: $HOME/.mnemosyne/owner.token)
  --env-file <p>     read the owner token from this env file instead
  --out <p>          also write a freshly minted token to this file (mode 0600)
  --json             print machine readable output
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(usage);
  process.exit(0);
}
if (!args['base-url']) {
  process.stderr.write(usage);
  process.exit(2);
}

const baseUrl = args['base-url'].replace(/\/+$/u, '');
const ownerToken = await resolveOwnerToken(args);
const out = [];

async function call(method, path, body) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ownerToken}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const code = payload?.code ?? response.status;
    throw new Error(`${code}: ${payload?.message ?? text.slice(0, 200)}`);
  }
  return payload;
}

if (args.list) {
  const payload = await call('GET', '/v1/admin/client-tokens');
  out.push(...payload.tokens);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload.tokens, null, 2)}\n`);
  } else if (payload.tokens.length === 0) {
    process.stdout.write('nessun token client emesso\n');
  } else {
    for (const token of payload.tokens) {
      const state = token.revokedAt ? `revocato ${token.revokedAt}` : 'attivo';
      const used = token.lastUsedAt ? `ultimo uso ${token.lastUsedAt}` : 'mai usato';
      process.stdout.write(`${token.name}  ${token.prefix}…  ${token.role}  ${state}  ${used}\n`);
    }
  }
} else if (args.revoke) {
  const revoked = await call(
    'POST',
    `/v1/admin/client-tokens/${encodeURIComponent(args.revoke)}/revoke`,
    {},
  );
  out.push(revoked);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(revoked, null, 2)}\n`);
  } else {
    process.stdout.write(`token "${revoked.name}" revocato\n`);
  }
} else if (args.name) {
  const minted = await call('POST', '/v1/admin/client-tokens', { name: args.name });
  out.push(minted);
  if (args.out) {
    await writeSecret(args.out, `${minted.token}\n`);
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(minted, null, 2)}\n`);
  } else {
    process.stdout.write(`token emesso per "${minted.name}" (${minted.prefix}…)\n`);
    process.stdout.write(`${minted.token}\n`);
    if (args.out) process.stdout.write(`scritto anche in ${args.out}\n`);
    process.stdout.write('il token non viene più riprodotto: conservalo ora\n');
  }
} else {
  process.stderr.write(usage);
  process.exit(2);
}

async function resolveOwnerToken(config) {
  if (config['env-file']) {
    const text = await readFile(resolve(root, config['env-file']), 'utf8');
    const match = /^MNEMOSYNE_OWNER_TOKEN=(.*)$/mu.exec(text);
    if (!match) throw new Error('owner_token_not_found_in_env_file');
    return match[1].trim().replace(/^["']|["']$/gu, '');
  }
  const path = resolve(config['token-file'] ?? resolve(homedir(), '.mnemosyne/owner.token'));
  return (await readFile(path, 'utf8')).trim();
}

async function writeSecret(path, contents) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, contents, { mode: 0o600 });
  await chmod(target, 0o600);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (argument === '--list' || argument === '--json') {
      parsed[argument.slice(2)] = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      throw new Error(`unexpected_argument:${argument}`);
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing_value_for:${key}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}
