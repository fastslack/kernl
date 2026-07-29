---
description: Stage the files belonging to the current change theme and propose a commit title (does NOT commit)
allowed-tools: Bash, Read, Grep
arguments:
  - name: theme
    description: "Optional theme hint (e.g. 'git', 'triage', 'rss', 'auth'). If omitted, infer from the working tree."
    required: false
---

# title-commit: $ARGUMENTS

Stage the files that belong to the current ongoing change and propose a commit
title for it. **Never run `git commit`** — the user always commits manually.

## Steps

### 1. Map the working tree

Run these in parallel:

- `git status --porcelain=v1` — list every modified, added, deleted, untracked file with its status code.
- `git diff --stat` — magnitude of staged + unstaged changes.
- `git log --oneline -20` — recent commit message style (subject prefixes, casing, length).

### 2. Group changed paths by theme

A "theme" is a coherent unit of change. Detect it from path patterns. Common
groupings in this repo:

- **Module**: anything under `services/kernel/src/modules/<name>/**`. The module name is the theme.
- **Extension**: anything under `assets/extensions/<slug>/**`. The slug is the theme.
- **Cross-module feature**: when many modules + extensions share a topic
  (e.g. `triage` + `github-channel` + `gitlab-channel` + `gitea-channel` + `services/kernel/assets/extensions/{triage,github,gitlab,gitea,*-channel,triage-orchestrator}` all relate to "git/repo triage").
- **Dashboard**: anything under `services/dashboard/src/**`.
- **Tests**: anything under `tests/**` — usually grouped with the feature it tests.
- **Config / chore**: top-level `.env*`, `package.json`, `tsconfig*`, `docker-compose*.yml`, `services/kernel/scripts/**`.

Skip files that are clearly noise:
- Binary build artifacts: `assets/extensions/*/backend/entry.js`, `dist/**` —
  **only stage these if the user explicitly asked, otherwise list them as
  "ignored from staging"**.
- Lock files (`package-lock.json`, `bun.lock`) — include only if the related
  feature touched dependencies.
- Backup files: `*.bak-*`, `*.bak`.

### 3. Pick the dominant theme

- If `$ARGUMENTS` is provided, use that as the theme name and stage only files matching it.
- Otherwise, count files per theme and pick the largest cohesive cluster.
- If two or more themes have similar weight, **stop and ask the user which one
  to stage** — listing each theme with its file count and 3-5 sample paths.

### 4. Stage only the theme's files

- `git add <path>` for each file in the chosen theme. Use explicit paths,
  never `git add -A` or `git add .` (could leak unrelated work or secrets).
- Skip `.env`, `secrets/**`, anything matching `*.key`, `*.pem` unless the user
  explicitly asks. If found, warn loudly and ask before staging.

### 5. Propose a commit title

Format must match the repo's existing style. Looking at recent `git log`:
- Subject prefix like `feat(scope):`, `fix(scope):`, `chore(scope):`, `refactor(scope):`.
- Imperative mood ("add X", not "added X").
- Under ~70 characters.
- Lowercase after the colon.

Pick the prefix from what the change actually does:
- New feature/module/extension → `feat`
- Bug or migration repair → `fix`
- Internal refactor with no behavior change → `refactor`
- Build/config/docs only → `chore`
- Performance work → `perf`

Scope is the theme: the module name, extension slug, or a short noun ("triage",
"extensions", "agents", "config").

If the change is too sprawling for one subject, propose a primary subject and
note 1-2 secondary subjects the user could split into separate commits.

### 6. Output

Print, in this exact order:

1. **Theme detected** — one line
2. **Files staged** — bullet list with status codes (`M`, `A`, `D`, `??`)
3. **Files NOT staged** (working tree leftovers from other themes) — bullet list, with their themes if any
4. **Proposed commit title** — single line, ready to paste

Example output:

```
Theme: triage (cross-module: services/kernel/src/modules/{triage,github-channel,gitlab-channel,gitea-channel}, services/kernel/assets/extensions/{triage,github,gitlab,gitea,*-channel,triage-orchestrator})

Staged (32 files):
- M services/kernel/src/modules/triage/service.ts
- A services/kernel/src/modules/gitea-channel/provider.ts
- A assets/extensions/gitea/extension.json
- ...

Not staged (other themes):
- M services/dashboard/src/lib/stores.ts                    [theme: dashboard]
- M tests/chat.test.ts                              [theme: tests/chat]

Proposed title:
feat(triage): add github/gitlab/gitea channels with provider-agnostic registry
```

Stop after printing the title. **Do not run `git commit`**. The user will run it.
