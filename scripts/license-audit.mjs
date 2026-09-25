import { readFile } from 'node:fs/promises';
import process from 'node:process';

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const approved = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
]);
const review = /^(?:AGPL|GPL|LGPL|EPL|CDDL|SSPL|OSL|CC-|EUPL)/iu;
const findings = [];
let count = 0;

for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/') || metadata.link) continue;
  count += 1;
  const raw = metadata.license ?? metadata.licenses;
  const license = Array.isArray(raw) ? raw.join(' OR ') : raw;
  if (typeof license !== 'string' || license.trim().length === 0) {
    findings.push({ path, license: 'UNKNOWN' });
    continue;
  }
  const normalized = license.replace(/^\(|\)$/gu, '').trim();
  const expressions = normalized.split(/\s+OR\s+/iu);
  if (expressions.some((expression) => review.test(expression) || !approved.has(expression))) {
    findings.push({ path, license: normalized });
  }
}

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`${finding.path}: ${finding.license}\n`);
  throw new Error(`license_audit_failed:${findings.length}`);
}
process.stdout.write(`License audit passed: ${count} packages\n`);
