// Local web UI server. Binds to 127.0.0.1 only and checks the Host header
// so other websites cannot drive it through the browser.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  doctor, routerCheck, listModels, createJob, startJob, listJobs,
  showJob, mergeJob, cleanJob,
} from './core.js';

const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const MAX_BODY = 64 * 1024;

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type === 'application/json' ? 'application/json; charset=utf-8' : type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function hostOk(req, port) {
  const host = (req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function startServer(port = 7331) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req, port)) return send(res, 403, { error: 'Forbidden host' });

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const p = url.pathname;

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return send(res, 200, fs.readFileSync(UI_FILE, 'utf8'), 'text/html; charset=utf-8');
      }

      if (req.method === 'GET' && p === '/api/jobs') {
        return send(res, 200, { jobs: listJobs() });
      }

      if (req.method === 'GET' && p === '/api/job') {
        const id = url.searchParams.get('id');
        return send(res, 200, showJob(id));
      }

      if (req.method === 'GET' && p === '/api/doctor') {
        const checks = doctor();
        checks.push(await routerCheck());
        return send(res, 200, { checks });
      }

      if (req.method === 'GET' && p === '/api/models') {
        return send(res, 200, { models: listModels() });
      }

      if (req.method === 'POST' && p === '/api/jobs') {
        const body = await readBody(req);
        const job = createJob({ repo: body.repo, model: body.model, task: body.task });
        startJob(job.id, { background: true });
        return send(res, 200, { id: job.id });
      }

      if (req.method === 'POST' && p === '/api/merge') {
        const body = await readBody(req);
        const job = mergeJob(body.id);
        return send(res, 200, { ok: true, job });
      }

      if (req.method === 'POST' && p === '/api/clean') {
        const body = await readBody(req);
        const job = cleanJob(body.id, { force: Boolean(body.force) });
        return send(res, 200, { ok: true, job });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`orc-gents UI: http://localhost:${port}`);
    console.log('Press Ctrl+C to stop.');
  });
  return server;
}
