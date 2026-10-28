#!/usr/bin/env node
/**
 * Mnemosyne Lazy LLM Manager
 *
 * Runs as a lightweight host daemon (~15 MB RAM) exposing ports 8081 (instruct)
 * and 8082 (reranker). Underlying llama-server instances consume 0 MB RAM/VRAM
 * when idle. When an incoming request arrives:
 * 1. Spawns the required llama-server with Apple Silicon Metal acceleration.
 * 2. Holds/queues incoming requests until /health reports {"status":"ok"} (~2-3s).
 * 3. Proxies requests and streams responses.
 * 4. Resets an idle timer. After LLAMA_IDLE_TIMEOUT_SECONDS (default: 300s / 5 min)
 *    of inactivity, terminates llama-server, freeing 100% of RAM/VRAM.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const home = homedir();
const LLAMA_SERVER_BIN = process.env.LLAMA_SERVER_BIN ?? '/opt/homebrew/bin/llama-server';
const GEMMA_MODEL_PATH =
  process.env.GEMMA_MODEL_PATH ?? resolve(home, '.mnemosyne/models/gemma-3-4b-it-Q4_K_M.gguf');
const RERANK_MODEL_PATH =
  process.env.RERANK_MODEL_PATH ??
  resolve(home, '.mnemosyne/models/bge-reranker-v2-m3-Q4_K_M.gguf');

const INSTRUCT_PUBLIC_PORT = Number(process.env.LLAMA_INSTRUCT_PORT ?? '8081');
const INSTRUCT_INTERNAL_PORT = Number(process.env.LLAMA_INSTRUCT_INTERNAL_PORT ?? '8181');
const RERANK_PUBLIC_PORT = Number(process.env.LLAMA_RERANK_PORT ?? '8082');
const RERANK_INTERNAL_PORT = Number(process.env.LLAMA_RERANK_INTERNAL_PORT ?? '8182');

const IDLE_TIMEOUT_MS = Number(process.env.LLAMA_IDLE_TIMEOUT_SECONDS ?? '300') * 1000;

class ManagedModel {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.process = null;
    this.idleTimer = null;
    this.startingPromise = null;
    this.isReady = false;
    this.activeRequests = 0;
  }

  touch() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (IDLE_TIMEOUT_MS > 0 && this.activeRequests === 0) {
      this.idleTimer = setTimeout(() => {
        if (this.activeRequests === 0) {
          this.stop('idle_timeout');
        }
      }, IDLE_TIMEOUT_MS);
      if (this.idleTimer.unref) this.idleTimer.unref();
    }
  }

  beginRequest() {
    this.activeRequests += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  endRequest() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.touch();
  }

  async ensureRunning() {
    this.touch();
    if (this.isReady && this.process) {
      return;
    }
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = (async () => {
      if (!existsSync(this.config.modelPath)) {
        throw new Error(`model_file_not_found: ${this.config.modelPath}`);
      }
      if (!existsSync(LLAMA_SERVER_BIN)) {
        throw new Error(`llama_server_binary_not_found: ${LLAMA_SERVER_BIN}`);
      }

      console.log(
        `[${this.name}] Spawning llama-server on internal port ${this.config.internalPort}...`,
      );
      const args = [
        '-m',
        this.config.modelPath,
        '--port',
        String(this.config.internalPort),
        '--host',
        '127.0.0.1',
        '--n-gpu-layers',
        '99',
        '--alias',
        this.config.alias,
        ...this.config.extraArgs,
      ];

      const child = spawn(LLAMA_SERVER_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line.length > 0) console.log(`[${this.name}:out] ${line}`);
      });
      child.stderr.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line.length > 0) console.error(`[${this.name}:err] ${line}`);
      });

      child.on('exit', (code, signal) => {
        console.log(`[${this.name}] llama-server exited (code=${code}, signal=${signal}).`);
        this.process = null;
        this.isReady = false;
        this.startingPromise = null;
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
      });

      this.process = child;

      // Poll until /health returns {"status":"ok"}
      const start = Date.now();
      const maxWaitMs = 60_000;
      while (Date.now() - start < maxWaitMs) {
        if (!this.process) {
          throw new Error(`[${this.name}] llama-server crashed during startup`);
        }
        try {
          const res = await fetch(`http://127.0.0.1:${this.config.internalPort}/health`);
          if (res.ok) {
            const body = await res.json();
            if (body.status === 'ok') {
              this.isReady = true;
              console.log(
                `[${this.name}] llama-server is healthy and ready in ${Date.now() - start}ms.`,
              );
              return;
            }
          }
        } catch {
          // Retry
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      this.stop('startup_timeout');
      throw new Error(`[${this.name}] startup timed out after ${maxWaitMs}ms`);
    })();

    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  stop(reason = 'manual') {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.process) {
      console.log(`[${this.name}] Stopping llama-server (reason: ${reason})...`);
      const p = this.process;
      this.process = null;
      this.isReady = false;
      p.kill('SIGTERM');
      setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          // Ignored
        }
      }, 5000).unref();
    }
  }
}

const instructModel = new ManagedModel('instruct', {
  modelPath: GEMMA_MODEL_PATH,
  internalPort: INSTRUCT_INTERNAL_PORT,
  alias: 'gemma-3-4b-it',
  extraArgs: ['--ctx-size', '2048'],
});

const rerankModel = new ManagedModel('rerank', {
  modelPath: RERANK_MODEL_PATH,
  internalPort: RERANK_INTERNAL_PORT,
  alias: 'bge-reranker',
  extraArgs: ['--reranking'],
});

function createProxy(name, managedModel, publicPort, internalPort) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${publicPort}`);

    // If caller just checks health passively and model is idle, answer without waking
    if (
      url.pathname === '/health' &&
      url.searchParams.get('wake') !== 'true' &&
      !managedModel.isReady
    ) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'idle',
          manager: 'mnemosyne-lazy-manager',
          model: managedModel.name,
          ready: false,
        }),
      );
      return;
    }

    try {
      await managedModel.ensureRunning();
    } catch (error) {
      console.error(`[${name}] Failed to activate model:`, error?.message ?? error);
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: `model_activation_failed: ${error?.message ?? error}`,
            type: 'service_unavailable',
          },
        }),
      );
      return;
    }

    managedModel.beginRequest();
    let ended = false;
    const finishRequest = () => {
      if (ended) return;
      ended = true;
      managedModel.endRequest();
    };
    res.on('close', finishRequest);
    res.on('finish', finishRequest);

    const proxyReq = httpRequest(
      {
        hostname: '127.0.0.1',
        port: internalPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      finishRequest();
      console.error(`[${name}] Proxy error:`, err?.message ?? err);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'proxy_error', cause: err.message } }));
      }
    });

    req.pipe(proxyReq);
  });

  server.listen(publicPort, '127.0.0.1', () => {
    console.log(
      `[${name}] Lazy proxy listening on 127.0.0.1:${publicPort} (target port: ${internalPort}, idle timeout: ${IDLE_TIMEOUT_MS / 1000}s)`,
    );
  });

  return server;
}

const instructServer = createProxy(
  'instruct',
  instructModel,
  INSTRUCT_PUBLIC_PORT,
  INSTRUCT_INTERNAL_PORT,
);
const rerankServer = createProxy('rerank', rerankModel, RERANK_PUBLIC_PORT, RERANK_INTERNAL_PORT);

function shutdown() {
  console.log('\nShutting down Mnemosyne Lazy LLM Manager...');
  instructServer.close();
  rerankServer.close();
  instructModel.stop('manager_shutdown');
  rerankModel.stop('manager_shutdown');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
