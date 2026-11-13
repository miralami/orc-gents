#!/usr/bin/env node
// orc-gents command-line entry point.

import fs from 'node:fs';
import {
  doctor, routerCheck, listModels, createJob, startJob, listJobs,
  showJob, mergeJob, cleanJob, readJob, HOME,
} from '../src/core.js';
import { startServer } from '../src/server.js';

const HELP = `orc-gents: hand tasks to OpenCode workers, one git worktree per job.

Usage:
  orc-gents ui [--port 7331]                       Open the local web UI
  orc-gents doctor                                 Check git, opencode and 9Router
  orc-gents models                                 List models OpenCode can use
  orc-gents run --model <m> (--task <text> | --task-file <f>) [--repo <dir>] [--bg]
  orc-gents status                                 List jobs
  orc-gents show <id>                              Diff stat and last log lines
  orc-gents merge <id>                             Merge a finished job (--no-ff)
  orc-gents clean <id> [--force]                   Remove the worktree and branch

Data folder: ${HOME}  (set ORC_GENTS_HOME to change it)
`;

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printJob(j) {
  const flags = [j.merged ? 'merged' : '', j.cleaned ? 'cleaned' : ''].filter(Boolean).join(',');
  console.log(`${j.id}  ${j.status.padEnd(8)} ${String(j.exitCode ?? '-').padEnd(4)} ${j.model.padEnd(24)} ${flags}`);
  console.log(`    ${j.task.split(/\r?\n/)[0].slice(0, 100)}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parse(rest);
  const id = args._[0];

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return;

    case 'ui': {
      const port = Number(args.port || 7331);
      startServer(port);
      return;
    }

    case 'doctor': {
      for (const c of doctor()) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}`);
      const r = await routerCheck();
      console.log(`${r.ok ? 'OK  ' : 'WARN'} ${r.name}: ${r.detail}`);
      return;
    }

    case 'models':
      for (const m of listModels()) console.log(m);
      return;

    case 'run': {
      let task = args.task;
      if (args['task-file']) task = fs.readFileSync(args['task-file'], 'utf8');
      const job = createJob({ repo: args.repo, model: args.model, task });
      startJob(job.id, { background: Boolean(args.bg) });
      if (args.bg) {
        console.log(`Started ${job.id} in the background. Check it with: orc-gents status`);
      } else {
        const done = readJob(job.id);
        console.log(`Finished ${job.id}: ${done.status} (exit ${done.exitCode})`);
        const shown = showJob(job.id);
        console.log(shown.diffStat || '(no file changes)');
        console.log(`Merge with: orc-gents merge ${job.id}`);
      }
      return;
    }

    case '_run':
      // Internal: the detached runner started by "run --bg".
      startJob(id, { background: false });
      return;

    case 'status':
      for (const j of listJobs()) printJob(j);
      return;

    case 'show': {
      const s = showJob(id);
      printJob(s.job);
      console.log(s.diffStat || '(no file changes)');
      console.log('--- log (last 30 lines)');
      console.log(s.logTail || '(empty)');
      return;
    }

    case 'merge': {
      const j = mergeJob(id);
      console.log(`Merged ${j.branch} into ${j.repo}`);
      return;
    }

    case 'clean': {
      const j = cleanJob(id, { force: Boolean(args.force) });
      console.log(`Cleaned ${j.id}`);
      return;
    }

    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
