import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(root, 'artifacts');
const outputPath = resolve(outputDirectory, 'mnemosyne-sbom.cdx.json');
const sbom = execFileSync(
  'npm',
  ['sbom', '--package-lock-only', '--sbom-format', 'cyclonedx', '--omit', 'dev'],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
JSON.parse(sbom);
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${sbom.trim()}\n`, { mode: 0o644 });
process.stdout.write(`SBOM written: ${outputPath}\n`);
