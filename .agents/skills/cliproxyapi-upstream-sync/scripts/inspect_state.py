#!/usr/bin/env python3
"""Read-only state inspection for the ClipProxyAPI upstream sync workflow."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any


def run_git(repo: Path, *args: str, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
    )


def discover_repo(start: Path) -> Path:
    result = run_git(start, "rev-parse", "--show-toplevel")
    if result.returncode != 0:
        raise SystemExit(f"not inside a git repository: {result.stderr.strip()}")
    return Path(result.stdout.strip()).resolve()


def git_state(repo: Path) -> dict[str, Any]:
    if not (repo / ".git").exists():
        return {"exists": repo.exists(), "isGitRepository": False}
    head = run_git(repo, "rev-parse", "HEAD")
    branch = run_git(repo, "branch", "--show-current")
    status = run_git(repo, "status", "--porcelain")
    remotes = run_git(repo, "remote", "-v")
    remote_rows: list[dict[str, str]] = []
    for line in remotes.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            remote_rows.append({"name": parts[0], "url": parts[1], "direction": parts[2].strip("()")})
    return {
        "exists": True,
        "isGitRepository": head.returncode == 0,
        "head": head.stdout.strip() or None,
        "branch": branch.stdout.strip() or None,
        "clean": status.returncode == 0 and not status.stdout.strip(),
        "changedPaths": [line[3:] for line in status.stdout.splitlines() if len(line) > 3],
        "remotes": remote_rows,
    }


def package_source(entry: Any) -> Any:
    if isinstance(entry, dict):
        return entry.get("source")
    return entry


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return {"_error": str(exc)}
    return value if isinstance(value, dict) else {"_error": "expected a JSON object"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="development repository or a path inside it")
    parser.add_argument("--agent-dir", type=Path, default=Path.home() / ".prime" / "agent")
    parser.add_argument("--installed-dir", type=Path)
    args = parser.parse_args()

    repo = discover_repo(args.repo.resolve())
    agent_dir = args.agent_dir.expanduser().resolve()
    installed_dir = (
        args.installed_dir.expanduser().resolve()
        if args.installed_dir
        else agent_dir / "git" / "github.com" / "DukeAnn" / "prime-agent-cliproxyapi-provider"
    )

    settings_path = agent_dir / "settings.json"
    config_path = agent_dir / "cliproxyapi.json"
    settings = read_json(settings_path)
    config = read_json(config_path)

    package_sources: list[Any] = []
    if settings and "_error" not in settings:
        package_sources = [package_source(item) for item in settings.get("packages", [])]

    transport_mode: Any = None
    if config and "_error" not in config:
        transport_mode = config.get("transportMode")

    module_candidates = [
        installed_dir / "node_modules" / "@earendil-works" / "pi-ai" / "dist" / "api" / "openai-codex-responses.js",
        installed_dir / "node_modules" / "@earendil-works" / "pi-ai" / "dist" / "providers" / "openai-codex-responses.js",
    ]

    report = {
        "development": {"path": str(repo), **git_state(repo)},
        "installation": {"path": str(installed_dir), **git_state(installed_dir)},
        "prime": {
            "agentDir": str(agent_dir),
            "settingsPath": str(settings_path),
            "settingsReadable": settings is not None and "_error" not in settings,
            "packageSources": package_sources,
            "configPath": str(config_path),
            "configReadable": config is not None and "_error" not in config,
            "transportMode": transport_mode,
            "compatShimActive": (agent_dir / "extensions" / "cliproxyapi-provider-compat.ts").exists(),
            "compatShimBackup": str(agent_dir / "disabled-extensions" / "cliproxyapi-provider-compat.ts.before-c30882f"),
            "codexPatchSourceAvailable": any(path.exists() for path in module_candidates),
            "codexPatchSourceCandidates": [str(path) for path in module_candidates],
        },
        "knownGoodInitialCommit": "c30882fea3892ee3f3e4b79f077b097236d7b282",
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
