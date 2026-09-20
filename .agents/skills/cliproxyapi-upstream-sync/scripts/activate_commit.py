#!/usr/bin/env python3
"""Safely activate one pushed ClipProxyAPI compatibility commit for Prime Agent."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LEGACY_SOURCES = {
    "npm:@router-for-me/pi-cliproxyapi-provider",
    "./extensions/cliproxyapi-provider-compat.ts",
    "./local-packages/pi-cliproxyapi-provider/extensions/tps.ts",
}


def run(command: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if check and result.returncode != 0:
        tail = "\n".join(result.stdout.splitlines()[-80:])
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{tail}")
    return result


def git(repo: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(repo), *args], check=check).stdout.strip()


def discover_repo(start: Path) -> Path:
    result = run(["git", "-C", str(start), "rev-parse", "--show-toplevel"], check=False)
    if result.returncode != 0:
        raise RuntimeError(f"not inside a git repository: {result.stdout.strip()}")
    return Path(result.stdout.strip()).resolve()


def read_object(path: Path, *, allow_missing: bool = False) -> dict[str, Any]:
    if not path.exists():
        if allow_missing:
            return {}
        raise RuntimeError(f"required JSON file does not exist: {path}")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise RuntimeError(f"expected a JSON object: {path}")
    return value


def atomic_write_json(path: Path, value: dict[str, Any], mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(raw_temp)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def source_of(entry: Any) -> Any:
    return entry.get("source") if isinstance(entry, dict) else entry


def should_remove_source(source: Any, installed_source: str, installed_dir: Path) -> bool:
    if source in LEGACY_SOURCES or source in {installed_source, str(installed_dir)}:
        return True
    if not isinstance(source, str):
        return False
    return "DukeAnn/prime-agent-cliproxyapi-provider" in source


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="clean development repository")
    parser.add_argument("--commit", required=True, help="exact pushed commit or an unambiguous local revision")
    parser.add_argument("--agent-dir", type=Path, default=Path.home() / ".prime" / "agent")
    parser.add_argument("--installed-dir", type=Path)
    parser.add_argument("--remote-url", help="fork URL; defaults to the development repository origin")
    parser.add_argument("--transport-mode", choices=["auto", "native", "codex"], default="auto")
    parser.add_argument("--apply", action="store_true", help="perform activation; otherwise print a dry-run plan")
    args = parser.parse_args()

    repo = discover_repo(args.repo.resolve())
    agent_dir = args.agent_dir.expanduser().resolve()
    installed_dir = (
        args.installed_dir.expanduser().resolve()
        if args.installed_dir
        else agent_dir / "git" / "github.com" / "DukeAnn" / "prime-agent-cliproxyapi-provider"
    )
    commit = git(repo, "rev-parse", f"{args.commit}^{{commit}}")
    if len(commit) != 40:
        raise RuntimeError(f"could not resolve a full commit SHA: {args.commit}")
    repo_status = git(repo, "status", "--porcelain")
    remote_url = args.remote_url or git(repo, "remote", "get-url", "origin")
    old_commit = None
    installed_clean = None
    if (installed_dir / ".git").exists():
        old_commit = git(installed_dir, "rev-parse", "HEAD")
        installed_status = git(installed_dir, "status", "--porcelain")
        installed_clean = not installed_status

    try:
        installed_source = f"./{installed_dir.relative_to(agent_dir).as_posix()}"
    except ValueError:
        installed_source = str(installed_dir)

    plan = {
        "apply": args.apply,
        "developmentRepo": str(repo),
        "developmentClean": not repo_status,
        "targetCommit": commit,
        "remoteUrl": remote_url,
        "agentDir": str(agent_dir),
        "installedDir": str(installed_dir),
        "installedSource": installed_source,
        "previousInstalledCommit": old_commit,
        "installedClean": installed_clean,
        "transportMode": args.transport_mode,
        "actions": [
            "clone target commit into a staging directory",
            "run npm ci in staging",
            "back up settings.json and cliproxyapi.json",
            "atomically swap the installed clone",
            "preserve unrelated package settings",
            "disable the obsolete auto-discovered compat shim",
            "leave the current Prime daemon running",
        ],
    }
    if not args.apply:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0

    if repo_status:
        raise RuntimeError("development repository is not clean; commit or stash intentional changes before activation")
    if installed_dir.exists() and not (installed_dir / ".git").exists():
        raise RuntimeError("installed path exists but is not a git repository; refuse to replace it")
    if installed_clean is False:
        raise RuntimeError("installed clone has tracked changes; refuse to replace it")
    if not agent_dir.exists():
        raise RuntimeError(f"Prime agent directory does not exist: {agent_dir}")

    settings_path = agent_dir / "settings.json"
    config_path = agent_dir / "cliproxyapi.json"
    settings = read_object(settings_path)
    config = read_object(config_path, allow_missing=True)
    settings_mode = settings_path.stat().st_mode & 0o777
    config_mode = config_path.stat().st_mode & 0o777 if config_path.exists() else 0o600

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    short = commit[:12]
    staging_dir = installed_dir.parent / f".{installed_dir.name}.staging-{short}-{timestamp}"
    rollback_dir = None
    settings_backup = settings_path.with_name(f"settings.json.before-cliproxyapi-{short}-{timestamp}")
    config_backup = config_path.with_name(f"cliproxyapi.json.before-cliproxyapi-{short}-{timestamp}")
    disabled_dir = agent_dir / "disabled-extensions"
    active_shim = agent_dir / "extensions" / "cliproxyapi-provider-compat.ts"
    disabled_shim = disabled_dir / f"cliproxyapi-provider-compat.ts.before-{short}-{timestamp}"

    if staging_dir.exists():
        raise RuntimeError(f"staging path already exists: {staging_dir}")
    installed_dir.parent.mkdir(parents=True, exist_ok=True)

    swapped_install = False
    try:
        run(["git", "clone", "--no-checkout", remote_url, str(staging_dir)])
        run(["git", "-C", str(staging_dir), "checkout", "--detach", commit])
        staged_head = git(staging_dir, "rev-parse", "HEAD")
        if staged_head != commit:
            raise RuntimeError(f"staging checkout mismatch: expected {commit}, got {staged_head}")
        run(["npm", "ci"], cwd=staging_dir)
        codex_sources = [
            staging_dir / "node_modules" / "@earendil-works" / "pi-ai" / "dist" / "api" / "openai-codex-responses.js",
            staging_dir / "node_modules" / "@earendil-works" / "pi-ai" / "dist" / "providers" / "openai-codex-responses.js",
        ]
        if not any(path.exists() for path in codex_sources):
            raise RuntimeError("npm ci completed but no compatible openai-codex-responses.js was installed")

        shutil.copy2(settings_path, settings_backup)
        if config_path.exists():
            shutil.copy2(config_path, config_backup)

        if installed_dir.exists():
            previous_short = (old_commit or "unknown")[:12]
            rollback_dir = installed_dir.parent / f"{installed_dir.name}.rollback-{previous_short}-{timestamp}"
            if rollback_dir.exists():
                raise RuntimeError(f"rollback path already exists: {rollback_dir}")
            os.replace(installed_dir, rollback_dir)
        os.replace(staging_dir, installed_dir)
        swapped_install = True

        packages = []
        for entry in settings.get("packages", []):
            if not should_remove_source(source_of(entry), installed_source, installed_dir):
                packages.append(entry)
        packages.append(installed_source)
        settings["packages"] = packages
        config["transportMode"] = args.transport_mode

        atomic_write_json(settings_path, settings, settings_mode)
        atomic_write_json(config_path, config, config_mode)

        if active_shim.exists():
            disabled_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.move(str(active_shim), str(disabled_shim))

    except Exception:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        if rollback_dir and rollback_dir.exists():
            if installed_dir.exists():
                shutil.rmtree(installed_dir, ignore_errors=True)
            os.replace(rollback_dir, installed_dir)
        elif swapped_install and installed_dir.exists():
            shutil.rmtree(installed_dir, ignore_errors=True)
        if settings_backup.exists():
            shutil.copy2(settings_backup, settings_path)
        if config_backup.exists():
            shutil.copy2(config_backup, config_path)
        raise

    result = {
        **plan,
        "activated": True,
        "settingsBackup": str(settings_backup),
        "configBackup": str(config_backup) if config_backup.exists() else None,
        "rollbackDirectory": str(rollback_dir) if rollback_dir else None,
        "disabledShimBackup": str(disabled_shim) if disabled_shim.exists() else None,
        "next": "run verify_prime_install.py before deleting the rollback directory",
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2), file=sys.stderr)
        raise SystemExit(1)
