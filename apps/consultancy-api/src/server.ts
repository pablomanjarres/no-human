/**
 * Consultancy console server.
 *
 * Serves the static SICK-styled UI and one JSON endpoint. It exists because the
 * static site cannot hold an API key — all reasoning lives in the engine package.
 *
 *   POST /api/consult   { problem_description, industry?, application?, constraints? }
 *   GET  /api/health
 *   GET  /*             static files from apps/sick-clone-ui
 *
 * Run: ANTHROPIC_API_KEY=... pnpm --filter @no-human/consultancy-api dev
 * Without a key it still runs, ranking deterministically and saying so.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { consult, loadCatalog } from '@no-human/consultancy-engine';
import type { ConsultInput } from '@no-human/consultancy-engine';

import { createAnthropicClient } from './anthropic.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const UI_ROOT = resolve(REPO_ROOT, 'apps/sick-clone-ui');
const CATALOG_PATH =
  process.env['SICK_CATALOG_PATH'] ?? resolve(REPO_ROOT, 'sick-catalog-dataset/catalog.enriched.json');

const PORT = Number(process.env['PORT'] ?? 3400);
const MAX_BODY_BYTES = 64 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const catalog = loadCatalog(CATALOG_PATH);

const apiKey = process.env['ANTHROPIC_API_KEY'];
const llm = apiKey ? createAnthropicClient(apiKey) : null;

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectPromise);
  });
}

function parseInput(raw: string): ConsultInput {
  const body: unknown = JSON.parse(raw);
  if (typeof body !== 'object' || body === null) throw new Error('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  const problem = b['problem_description'];
  if (typeof problem !== 'string' || problem.trim() === '') {
    throw new Error('problem_description is required');
  }
  return {
    problem_description: problem.slice(0, 8000),
    industry: typeof b['industry'] === 'string' ? b['industry'] : null,
    application: typeof b['application'] === 'string' ? b['application'] : null,
    constraints:
      typeof b['constraints'] === 'object' && b['constraints'] !== null
        ? (b['constraints'] as Record<string, unknown>)
        : null,
  };
}

/** Resolve a URL path inside the UI root, refusing anything that escapes it. */
function safeStaticPath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const relative = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(join(UI_ROOT, relative));
  // Compare on a path boundary: a bare startsWith would also accept a sibling
  // directory whose name merely begins with the UI root's (…/sick-clone-ui-old).
  return full === UI_ROOT || full.startsWith(UI_ROOT + sep) ? full : null;
}

function sendJson(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer((req, res) => {
  void (async () => {
    const url = req.url ?? '/';

    if (url === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        products: catalog.products.length,
        accessories: catalog.accessories.length,
        model_available: llm !== null,
      });
      return;
    }

    if (url === '/api/consult') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Use POST' });
        return;
      }
      try {
        const input = parseInput(await readBody(req));
        const result = await consult(catalog, input, llm);
        sendJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        sendJson(res, 400, { error: message });
      }
      return;
    }

    const filePath = safeStaticPath(url);
    if (filePath === null) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
    try {
      const file = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  })();
});

server.listen(PORT, () => {
  console.log(`Consultancy console  → http://localhost:${PORT}/consult.html`);
  console.log(`Catalog              → ${catalog.products.length} products, ${catalog.accessories.length} accessories`);
  console.log(
    llm
      ? 'Model                → claude-opus-5 (server-side refusal fallback enabled)'
      : 'Model                → none (ANTHROPIC_API_KEY unset; deterministic ranking only)',
  );
});
