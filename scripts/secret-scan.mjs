import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const history = execFileSync('git', ['log', '--all', '-p', '--no-ext-diff'], {
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
});
const workingTree = execFileSync('git', ['diff', 'HEAD', '--no-ext-diff'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const patterns = [
  { name: 'private-key', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
  { name: 'api-key', expression: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { name: 'github-token', expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu },
  { name: 'aws-access-key', expression: /\bAKIA[0-9A-Z]{16}\b/gu },
];
const allowedFixtures = new Set(['sk-12345678901234567890']);
const findings = [];

for (const source of [history, workingTree]) {
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern.expression)) {
      if (!allowedFixtures.has(match[0])) findings.push({ name: pattern.name, value: match[0] });
    }
  }
}
const trackedFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
).split('\0');
for (const path of trackedFiles) {
  if (!path) continue;
  const content = await readFile(path, 'utf8');
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern.expression)) {
      if (!allowedFixtures.has(match[0]))
        findings.push({ name: pattern.name, value: match[0], path });
    }
  }
}
if (findings.length > 0) {
  for (const finding of findings)
    process.stderr.write(`${finding.name}:${finding.path ?? 'history'}\n`);
  throw new Error(`secret_scan_failed:${findings.length}`);
}
process.stdout.write('Secret scan passed\n');
