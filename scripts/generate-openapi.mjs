import { openApiDocument } from '../apps/api/dist/openapi.js';
import { format, resolveConfig } from 'prettier';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';

const outputPath = path.resolve(import.meta.dirname, '../docs/openapi.yaml');
const prettierConfig = (await resolveConfig(outputPath)) ?? {};
const output = await format(stringify(openApiDocument), { ...prettierConfig, parser: 'yaml' });
await writeFile(outputPath, output, 'utf8');
