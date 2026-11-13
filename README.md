# orc-gents

Hand coding tasks to [OpenCode](https://opencode.ai) workers, one git worktree per job, with a small local web UI.

Use it from Claude Code (or from the browser) to send work to cheaper models, such as those behind [9Router](https://github.com/decolua/9Router), and review the results before anything reaches your branch.

## What it does

- Each job gets its own **git worktree and branch** (`job/<id>`), so parallel jobs never edit the same files.
- OpenCode runs in that worktree. Its changes are committed to the job branch.
- You see a **diff stat** and the **last log lines** instead of the full output, which keeps the calling model's context small.
- **Merge** is a normal `git merge --no-ff`. If it conflicts, it is aborted and reported. Nothing is resolved automatically.
- **Clean** removes the worktree and branch. It refuses to delete unmerged work unless you force it.

It has no dependencies beyond Node.js.

## Requirements

- Node.js 18 or newer
- git
- [OpenCode](https://opencode.ai) on your PATH, with at least one model working (`opencode models`)
- Optional: 9Router on `http://localhost:20128`

## Install

```bash
npm i -g github:miralami/orc-gents
orc-gents doctor
```

## Use the web UI

```bash
orc-gents ui
```

Open `http://localhost:7331`. The UI listens on `127.0.0.1` only. Pick a repository folder, a model, and a task, then start the job. It runs in the background and the list updates on its own. Select a job to see its changes and log, then merge or clean it up.

## Use the command line

```bash
orc-gents run --repo ~/code/my-app --model 9router/Cheap --task "Add a /health endpoint that returns 200 OK"
orc-gents run --repo ~/code/my-app --model 9router/Cheap --task-file task.md --bg
orc-gents status
orc-gents show <id>
orc-gents merge <id>
orc-gents clean <id>
```

`--bg` starts the job in a detached process and returns at once. Without it, the command waits and prints the diff stat.

## Notes and limits

- **Worktrees only see committed code.** A job starts from the repository's last commit. Commit any changes you want the worker to see first.
- **The repository needs at least one commit.**
- **Jobs run with `--auto`**, which auto-approves OpenCode's permission prompts. Only run tasks you would accept without review, and review the diff before you merge.
- Data lives in `~/.orc-gents` (override with `ORC_GENTS_HOME`): job records, logs, and worktrees.
- Logins and API keys are never read or stored by orc-gents. Each tool (Claude Code, OpenCode, 9Router) keeps its own.

## How it fits with Claude Code

Claude Code can call the CLI through its Bash tool, for example `orc-gents run ... --bg`, then `orc-gents show <id>` once the job is done. The model that writes the task decides when to delegate. Keep a short rule for this in your `CLAUDE.md`.

## License

MIT. See [LICENSE](LICENSE).
