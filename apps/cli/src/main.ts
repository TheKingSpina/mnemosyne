#!/usr/bin/env node
import { chmod, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  adminCapabilitiesOutputSchema,
  adminJobsOutputSchema,
  adminMemoriesOutputSchema,
  adminOverviewOutputSchema,
  adminSessionsOutputSchema,
  conflictListOutputSchema,
  corpusExportSchema,
  memoryAdminViewSchema,
  pendingProposalsOutputSchema,
  searchMemoriesInputSchema,
} from '@mnemosyne/contracts';
import { z } from 'zod';

const [command, ...args] = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}
if (command === undefined || command === 'help') {
  printHelp();
  process.exit(0);
}
const baseUrl = option('api') ?? process.env.MNEMOSYNE_API_URL ?? 'http://127.0.0.1:3000';
const ownerToken = option('token') ?? process.env.MNEMOSYNE_OWNER_TOKEN;
if (!ownerToken) throw new Error('MNEMOSYNE_OWNER_TOKEN or --token is required');
try {
  await run(command ?? 'help', args);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'cli_failed'}\n`);
  process.exitCode = 1;
}

async function run(name: string, args: string[]): Promise<void> {
  if (name === 'status') {
    printJson(await request('/v1/admin/overview', adminOverviewOutputSchema));
    return;
  }
  if (name === 'capabilities') {
    printJson(await request('/v1/admin/capabilities', adminCapabilitiesOutputSchema));
    return;
  }
  if (name === 'search') {
    const input = searchMemoriesInputSchema.parse({
      sessionId: required(args, 0, 'session ID'),
      query: required(args, 1, 'query'),
      limit: optionalNumber(args, 2, 20),
      offset: optionalNumber(args, 3, 0),
    });
    printJson(
      await request(
        `/v1/memories?${query({
          sessionId: input.sessionId,
          q: input.query,
          limit: input.limit,
          offset: input.offset,
        })}`,
        z.object({ items: z.array(z.unknown()) }),
      ),
    );
    return;
  }
  if (name === 'show') {
    printJson(
      await request(
        `/v1/admin/memories/${encodeURIComponent(required(args, 0, 'memory ID'))}`,
        memoryAdminViewSchema,
      ),
    );
    return;
  }
  if (name === 'memories') {
    printJson(
      await request(
        `/v1/admin/memories?${query({ limit: optionalNumber(args, 0, 50), offset: optionalNumber(args, 1, 0) })}`,
        adminMemoriesOutputSchema,
      ),
    );
    return;
  }
  if (name === 'pending') {
    printJson(
      await request(
        `/v1/proposals?${query({ sessionId: required(args, 0, 'session ID'), limit: optionalNumber(args, 1, 20), offset: optionalNumber(args, 2, 0) })}`,
        pendingProposalsOutputSchema,
      ),
    );
    return;
  }
  if (name === 'sessions') {
    printJson(
      await request(
        `/v1/admin/sessions?${query({ limit: optionalNumber(args, 0, 50), offset: optionalNumber(args, 1, 0) })}`,
        adminSessionsOutputSchema,
      ),
    );
    return;
  }
  if (name === 'jobs') {
    printJson(
      await request(
        `/v1/admin/jobs?${query({ limit: optionalNumber(args, 0, 50), offset: optionalNumber(args, 1, 0) })}`,
        adminJobsOutputSchema,
      ),
    );
    return;
  }
  if (name === 'conflicts') {
    printJson(await request('/v1/admin/conflicts', conflictListOutputSchema));
    return;
  }
  if (name === 'resolve-conflict') {
    const id = required(args, 0, 'conflict ID');
    if (!args.includes('--yes')) await confirm(`Risolvere il conflitto ${id}?`);
    printJson(
      await request(`/v1/admin/conflicts/${encodeURIComponent(id)}/resolution`, z.unknown(), {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    return;
  }
  if (name === 'export') {
    const destination = required(args, 0, 'output path');
    const value = corpusExportSchema.parse(await request('/v1/admin/exports/corpus', z.unknown()));
    await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(destination, 0o600);
    process.stdout.write(`Export scritto in ${destination}\n`);
    return;
  }
  throw new Error(`unknown_command:${name}`);
}

async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${ownerToken}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`invalid_json_response:${response.status}`);
  }
  if (!response.ok) {
    const message =
      typeof value === 'object' && value !== null && 'title' in value
        ? String(value.title)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return schema.parse(value);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

function required(args: string[], index: number, label: string): string {
  const value = args[index];
  if (!value) throw new Error(`missing_${label}`);
  return value;
}

function optionalNumber(args: string[], index: number, fallback: number): number {
  if (args[index] === undefined) return fallback;
  const value = Number(args[index]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_integer_argument');
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(
    [
      'mnemosyne status',
      'mnemosyne capabilities',
      'mnemosyne search <session-id> <query> [limit] [offset]',
      'mnemosyne show <memory-id>',
      'mnemosyne memories [limit] [offset]',
      'mnemosyne pending <session-id> [limit] [offset]',
      'mnemosyne sessions [limit] [offset]',
      'mnemosyne jobs [limit] [offset]',
      'mnemosyne conflicts',
      'mnemosyne resolve-conflict <conflict-id> --yes',
      'mnemosyne export <output.json>',
      '',
      'Options: --api <url> --token <owner-token>',
      '',
    ].join('\n'),
  );
}

async function confirm(message: string): Promise<void> {
  const rl = createInterface({ input, output });
  const answer = await rl.question(`${message} [y/N] `);
  rl.close();
  if (!['y', 'yes'].includes(answer.trim().toLocaleLowerCase()))
    throw new Error('operation_cancelled');
}
