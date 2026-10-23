import { fileURLToPath } from 'node:url';
import { createWebServer } from './server.js';

const port = Number(process.env.WEB_PORT ?? 8080);
const host = process.env.WEB_HOST ?? '127.0.0.1';
const apiOrigin = process.env.WEB_API_ORIGIN ?? 'http://127.0.0.1:3000';
const indexPath = fileURLToPath(new URL('./index.html', import.meta.url));

const server = createWebServer({ apiOrigin, indexPath });
server.keepAliveTimeout = Number(process.env.WEB_KEEP_ALIVE_TIMEOUT_MS ?? 120_000);
server.headersTimeout = server.keepAliveTimeout + 5_000;
server.timeout = Number(process.env.WEB_REQUEST_TIMEOUT_MS ?? 300_000);
server.listen(port, host, () => {
  process.stdout.write(`Mnemosyne web listening on ${host}:${port}\n`);
});
