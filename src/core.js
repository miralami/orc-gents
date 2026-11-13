// Core logic for orc-gents: jobs, git worktrees, running OpenCode, merge and cleanup.
// No dependencies beyond Node.js built-ins.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.ORC_GENTS_HOME || path.join(os.homedir(), '.orc-gents');
export const JOBS_DIR = path.join(HOME, 'jobs');
export const WT_DIR = path.join(HOME, 'worktrees');
export const CLI_PATH = fileURLToPath(new URL('../bin/orc-gents.js', import.meta.url));

const IS_WIN = process.platform === 'win32';
const GIT_ID = ['-c', 'user.name=orc-gents', '-c', 'user.email=orc-gents@localhost'];

// ---------- small helpers ----------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

function gitTry(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function now() { return new Date().toISOString(); }

const jobDir = (id) => path.join(JOBS_DIR, id);
const jobFile = (id) => path.join(jobDir(id), 'job.json');
const logFile = (id) => path.join(jobDir(id), 'log.txt');
const taskFile = (id) => path.join(jobDir(id), 'task.md');

function writeJob(job) {
  fs.mkdirSync(jobDir(job.id), { recursive: true });
  fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
}

// ---------- environment checks ----------

export function doctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('Node.js', true, process.version);

  const g = gitTry(['--version'], process.cwd());
  add('git', g.ok, g.ok ? g.out : 'git not found on PATH');

  const oc = spawnSync('opencode --version', { encoding: 'utf8', shell: true, windowsHide: true, timeout: 30000 });
  const ocOk = oc.status === 0;
  add('opencode', ocOk, ocOk ? (oc.stdout || '').trim() : 'opencode not found or failed to start');

  add('data folder', true, HOME);
  return checks;
}

export async function routerCheck() {
  const url = 'http://localhost:20128/v1/models';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { name: '9Router', ok: r.ok, detail: r.ok ? `answering at ${url}` : `HTTP ${r.status} at ${url}` };
  } catch {
    return { name: '9Router', ok: false, detail: `not answering at ${url} (optional)` };
  }
}

export function listModels() {
  const r = spawnSync('opencode models', { encoding: 'utf8', shell: true, windowsHide: true, timeout: 60000 });
  if (r.status !== 0) return [];
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('ServiceUnavailable') && !s.startsWith('at '));
}

// ---------- jobs ----------

export function newId() {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function alivePidFix(job) {
  if (job.status === 'running' || job.status === 'queued') {
    if (!alive(job.pid)) {
      job.status = 'failed';
      job.note = 'runner stopped before finishing';
      job.endedAt = job.endedAt || now();
      writeJob(job);
    }
  }
  return job;
}

export function readJob(id) {
  const f = jobFile(id);
  if (!fs.existsSync(f)) throw new Error(`No job with id ${id}`);
  return alivePidFix(JSON.parse(fs.readFileSync(f, 'utf8')));
}

export function listJobs() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs.readdirSync(JOBS_DIR)
    .filter((d) => fs.existsSync(jobFile(d)))
    .map((d) => readJob(d))
    .sort((a, b) => b.id.localeCompare(a.id));
}

export function createJob({ repo, model, task }) {
  if (!model) throw new Error('A model is required, for example 9router/Cheap');
  if (!/^[A-Za-z0-9._/:#-]+$/.test(model)) {
    throw new Error('Model names may contain only letters, digits, and . _ / : # -');
  }
  if (!task || !task.trim()) throw new Error('A task description is required');
  const repoDir = path.resolve(repo || process.cwd());
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel'], repoDir);
  } catch {
    throw new Error(`Not a git repository: ${repoDir}`);
  }
  let base;
  try {
    base = git(['rev-parse', 'HEAD'], root);
  } catch {
    throw new Error('The repository has no commits yet. Make at least one commit first.');
  }
  const id = newId();
  const job = {
    id,
    repo: root,
    model,
    task,
    branch: `job/${id}`,
    worktree: path.join(WT_DIR, id),
    base,
    status: 'created',
    createdAt: now(),
    startedAt: null,
    endedAt: null,
    exitCode: null,
    pid: null,
    merged: false,
    cleaned: false,
  };
  fs.mkdirSync(jobDir(id), { recursive: true });
  fs.writeFileSync(taskFile(id), task);
  writeJob(job);
  return job;
}

// Runs one job in the current process. Blocks until OpenCode exits.
function runJobNow(id) {
  const job = readJob(id);
  job.status = 'running';
  job.pid = process.pid;
  job.startedAt = now();
  writeJob(job);

  const fail = (note) => {
    job.status = 'failed';
    job.note = note;
    job.endedAt = now();
    writeJob(job);
  };

  try {
    fs.mkdirSync(WT_DIR, { recursive: true });
    git(['worktree', 'add', '-b', job.branch, job.worktree, job.base], job.repo);
  } catch (e) {
    return fail(`could not create worktree: ${e.message}`);
  }

  const out = fs.openSync(logFile(id), 'a');
  // The model comes from user input and the shell is needed for the opencode shim on Windows,
  // so build one fixed command line. The model name was validated in createJob.
  const cmdLine = `opencode run --auto -m ${job.model} --file "${taskFile(id)}" "Follow the attached task file."`;
  const child = spawnSync(cmdLine, {
    cwd: job.worktree,
    stdio: ['ignore', out, out],
    shell: true,
    windowsHide: true,
  });
  fs.closeSync(out);

  job.exitCode = child.status ?? -1;

  // Save whatever OpenCode changed as a commit on the job branch, so merge works.
  const dirty = gitTry(['status', '--porcelain'], job.worktree).out;
  if (dirty) {
    gitTry(['add', '-A'], job.worktree);
    gitTry([...GIT_ID, 'commit', '-q', '-m', `orc-gents job ${id}`], job.worktree);
  }

  job.status = job.exitCode === 0 ? 'done' : 'failed';
  job.endedAt = now();
  writeJob(job);
}

// Starts a job. Background mode re-launches this CLI as a detached runner.
export function startJob(id, { background = false } = {}) {
  if (!background) return runJobNow(id);

  const out = fs.openSync(logFile(id), 'a');
  const child = spawn(process.execPath, [CLI_PATH, '_run', id], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);

  const job = readJob(id);
  job.status = 'queued';
  job.pid = child.pid;
  writeJob(job);
  return job;
}

export function logTail(id, lines = 30) {
  const f = logFile(id);
  if (!fs.existsSync(f)) return '';
  const text = fs.readFileSync(f, 'utf8');
  return text.split(/\r?\n/).slice(-lines).join('\n');
}

export function showJob(id) {
  const job = readJob(id);
  const diff = gitTry(['diff', '--stat', job.base, job.branch], job.repo).out;
  return { job, diffStat: diff, logTail: logTail(id, 30) };
}

export function mergeJob(id) {
  const job = readJob(id);
  if (job.status === 'running' || job.status === 'queued') throw new Error('Job is still running');
  const r = gitTry(['merge', '--no-ff', '-m', `Merge ${job.branch}`, job.branch], job.repo);
  if (!r.ok) {
    gitTry(['merge', '--abort'], job.repo);
    throw new Error(`Merge failed and was aborted. Resolve it by hand.\n${r.err || r.out}`);
  }
  job.merged = true;
  writeJob(job);
  return job;
}

export function cleanJob(id, { force = false } = {}) {
  const job = readJob(id);
  if (job.status === 'running' || job.status === 'queued') throw new Error('Job is still running');
  if (!job.merged && !force) {
    throw new Error('This job is not merged. Its changes would be lost. Merge it first, or clean with force.');
  }
  if (fs.existsSync(job.worktree)) gitTry(['worktree', 'remove', '--force', job.worktree], job.repo);
  gitTry(['worktree', 'prune'], job.repo);
  gitTry(['branch', '-D', job.branch], job.repo);
  job.cleaned = true;
  writeJob(job);
  return job;
}
