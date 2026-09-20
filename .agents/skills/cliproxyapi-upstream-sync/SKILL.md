---
name: cliproxyapi-upstream-sync
description: Safely synchronize official router-for-me/pi-cliproxyapi-provider upgrades into this Prime Agent compatibility fork. Use when the upstream provider releases a version, asks to merge or compare upstream, update the installed Prime plugin, preserve Prime 0.9.5 tool routing, or roll back a failed provider upgrade.
---

# ClipProxyAPI Upstream Sync

Synchronize upstream without replacing the last known-good Prime installation until the merged code passes automated, independent, and live checks.

## Paths and sources

Resolve the repository root with `git rev-parse --show-toplevel`; do not assume the current directory.

Defaults:

- Official upstream: `https://github.com/router-for-me/pi-cliproxyapi-provider.git`
- Compatibility fork: the repository's existing `origin`
- Prime agent dir: `~/.prime/agent`
- Installed clone: `~/.prime/agent/git/github.com/DukeAnn/prime-agent-cliproxyapi-provider`
- Installed package source: `./git/github.com/DukeAnn/prime-agent-cliproxyapi-provider`

Run `scripts/inspect_state.py` first. It reports only non-secret state.

## Safety rules

- Never run `prime-agent package update` as the synchronization method. The active installation is a pinned local clone.
- Never merge directly into the installed clone.
- Stop if the development repository or installed clone has unexpected tracked changes.
- Do not use `git reset --hard`, force-push, or discard user changes.
- Do not print `cliproxyapi.json`, `auth.json`, URLs containing userinfo/query tokens, prompts, request bodies, or credentials.
- Keep `package.json`'s `pi` manifest. Prime 0.9.5 accepts the inherited `pi` key.
- Treat provider routing, authentication, tool schemas, retries, and installation activation as high-risk compatibility code. Require an independent review before activation.
- Do not activate, commit, or push unless the user requested that action.
- Keep the previous installed commit until the new installed smoke test passes.

Read `references/compatibility-contract.md` before resolving conflicts or accepting upstream changes.

## Workflow

### 1. Inspect

```bash
python3 .agents/skills/cliproxyapi-upstream-sync/scripts/inspect_state.py
```

Record:

- development HEAD and branch
- development and installed worktree cleanliness
- official upstream remote and target tag/commit
- installed HEAD
- active package source
- transport mode
- whether the obsolete compat shim is active
- whether the local Codex patch source dependency exists

Use exact commit IDs. Do not use a floating `latest` ref in evidence or activation.

### 2. Fetch and compare

Add the official remote only if absent:

```bash
git remote add upstream https://github.com/router-for-me/pi-cliproxyapi-provider.git
```

Then fetch and resolve the official default branch instead of assuming its name:

```bash
git fetch origin --prune
git fetch upstream --tags --prune
git remote set-head upstream --auto
git symbolic-ref --short refs/remotes/upstream/HEAD
```

Use the returned ref, such as `upstream/main`, in the comparison:

```bash
git log --oneline --left-right HEAD...<upstream-default-ref>
git diff --stat HEAD...<upstream-default-ref>
git diff HEAD...<upstream-default-ref> -- package.json extensions test README.md
```

If the requested upgrade is a release, resolve its exact tag and commit first. Review release notes and diff; never infer compatibility from the version number alone.

### 3. Merge in a development branch

Start from the current compatibility branch, not `origin/main` unless it already contains the compatibility work:

```bash
git switch -c sync/upstream-<version-or-date>
git merge --no-commit --no-ff <exact-upstream-tag-or-commit>
```

Resolve conflicts semantically. Do not choose all `ours` or all `theirs`. Preserve every applicable contract item in `references/compatibility-contract.md`.

Before encoding any upstream claim, verify it in the current tree with targeted searches. Name files explicitly in format or rewrite commands.

### 4. Validate the merged tree

Run:

```bash
npm ci
npm run check
git diff --check
```

Also verify:

```bash
git diff -- package.json
```

The `pi` manifest must remain. Review new dependencies and lockfile changes. Scan the staged or proposed diff for credentials and token-like strings without printing any discovered secret.

### 5. Live-test the development tree

Load only the development package and run the nonce verifier:

```bash
python3 .agents/skills/cliproxyapi-upstream-sync/scripts/verify_prime_install.py --extension-dir "$PWD" --model cliproxyapi/gpt-5.5
```

A plain natural-language answer is not evidence. The verifier asserts the actual selected provider, model, API id, command registration, outbound tool names, and secret nonce read through `ipython`.

Test the model families affected by the upstream diff. For routing changes, cover GPT, Astra, Claude, Gemini, Grok, and a forced Codex mode. For WebSocket changes, cover WebSocket success, finite retry, and SSE fallback.

### 6. Review

Obtain an independent reviewer from a different model family than the implementation author. Ask it to inspect:

- upstream requirement coverage
- conflicts and deleted compatibility code
- tool schema retention
- authentication and URL/log safety
- native/Codex/Fast routing
- Prime default-host detection
- tests and rollback path

Do not activate with an unresolved blocker.

### 7. Commit and push

Only when explicitly requested:

```bash
git add <explicit-file-list>
git commit -m "chore: sync upstream ClipProxyAPI provider <version>"
git push -u origin HEAD
```

Record the full pushed commit SHA. Activation must use that exact commit, not a branch name.

### 8. Dry-run activation

```bash
python3 .agents/skills/cliproxyapi-upstream-sync/scripts/activate_commit.py   --repo "$PWD"   --commit <full-pushed-sha>
```

Review the JSON plan. The script must report a clean source tree and an exact commit available from the installed clone's origin.

### 9. Activate

Only when explicitly requested:

```bash
python3 .agents/skills/cliproxyapi-upstream-sync/scripts/activate_commit.py   --repo "$PWD"   --commit <full-pushed-sha>   --apply
```

The script:

- backs up `settings.json` and `cliproxyapi.json`
- updates the installed clone in detached-HEAD mode
- runs `npm ci` because Prime's production Git install omits required peer/dev compatibility modules
- keeps unrelated Prime settings
- points Prime at the installed local clone
- sets `transportMode` to `auto`
- moves the obsolete compat shim out of the auto-discovered extensions directory
- does not terminate the current Prime daemon

### 10. Verify the formal installation

```bash
python3 .agents/skills/cliproxyapi-upstream-sync/scripts/verify_prime_install.py   --model cliproxyapi/gpt-5.5
```

Require all assertions:

- selected provider is `cliproxyapi`
- selected model is the requested model
- API id is `cliproxyapi-codex-responses`
- outbound payload contains `ipython`
- `/cliproxyapi-fast` is registered
- the model returns a nonce that was only available by reading a local file through the tool
- no provider, compat, module-resolution, or command-conflict error is emitted

A fallback to the Prime default model is a failure even if the prompt succeeds.

### 11. Roll back

Use the previous installed commit recorded by inspection or activation:

```bash
python3 .agents/skills/cliproxyapi-upstream-sync/scripts/activate_commit.py   --repo "$PWD"   --commit <previous-known-good-full-sha>   --apply
```

Then rerun `verify_prime_install.py`. Restore a settings/config backup only if the package source or transport configuration itself was damaged.

## Deliverable

Report:

- official source tag and commit
- compatibility base and resulting commit
- conflict decisions
- compatibility anchors retained or intentionally changed
- automated test totals
- live-tested models and endpoints
- independent review verdict
- activated commit and previous rollback commit
- backup paths
- remaining non-blocking risks
