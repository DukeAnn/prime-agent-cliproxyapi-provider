#!/usr/bin/env python3
"""Verify that the formal Prime installation selects ClipProxyAPI and executes ipython."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ERROR_MARKERS = (
    "failed to load patched codex protocol",
    "failed to register compat api provider",
    "command conflict",
    "refusing to send a tool-less request",
)


def log_offsets(log_dir: Path) -> dict[Path, int]:
    result: dict[Path, int] = {}
    if not log_dir.exists():
        return result
    for path in log_dir.glob("*.log"):
        try:
            result[path] = path.stat().st_size
        except OSError:
            pass
    return result


def appended_log_errors(log_dir: Path, offsets: dict[Path, int]) -> list[str]:
    findings: list[str] = []
    if not log_dir.exists():
        return findings
    for path in log_dir.glob("*.log"):
        try:
            start = offsets.get(path, 0)
            with path.open("rb") as handle:
                handle.seek(start)
                text = handle.read().decode(errors="ignore")
        except OSError:
            continue
        for line in text.splitlines():
            lower = line.lower()
            if any(marker in lower for marker in ERROR_MARKERS):
                findings.append(f"{path.name}: {line[:1000]}")
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="cliproxyapi/gpt-5.5")
    parser.add_argument("--agent-dir", type=Path, default=Path.home() / ".prime" / "agent")
    parser.add_argument("--extension-dir", type=Path, help="load only this development package plus the trace extension")
    parser.add_argument("--prime-agent-bin", default="prime-agent")
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()

    if "/" not in args.model:
        raise RuntimeError("--model must use provider/model syntax")
    expected_provider, expected_model = args.model.split("/", 1)
    if expected_provider != "cliproxyapi":
        raise RuntimeError("this verifier requires a cliproxyapi/* model")

    agent_dir = args.agent_dir.expanduser().resolve()
    nonce = secrets.token_hex(20)
    with tempfile.TemporaryDirectory(prefix="cliproxyapi-skill-verify-") as raw_temp:
        temp = Path(raw_temp)
        nonce_path = temp / "nonce.txt"
        nonce_path.write_text(nonce)
        os.chmod(nonce_path, 0o600)
        trace_path = temp / "trace.ts"
        trace_output = temp / "trace.jsonl"
        trace_source = chr(10).join(
            [
                'import { appendFileSync } from "node:fs";',
                f'const out={json.dumps(str(trace_output))};',
                'const wr=(x:any)=>appendFileSync(out,JSON.stringify(x)+String.fromCharCode(10));',
                'export default function(pi:any){',
                ' pi.on("before_agent_start",async(_e:any,ctx:any)=>wr({event:"before_agent_start",provider:ctx.model?.provider,model:ctx.model?.id,api:ctx.model?.api,commands:pi.getCommands().filter((c:any)=>["fast","cliproxyapi-fast"].includes(c.name)).map((c:any)=>c.name)}));',
                ' pi.on("before_provider_request",async(e:any,ctx:any)=>wr({event:"before_provider_request",provider:ctx.model?.provider,model:ctx.model?.id,api:ctx.model?.api,toolNames:Array.isArray(e.payload?.tools)?e.payload.tools.map((t:any)=>t.name??t.function?.name??t.type):[]}));',
                '}',
            ]
        ) + chr(10)
        trace_path.write_text(trace_source)
        marker = f"CLIPROXYAPI_SYNC_OK={nonce}"
        prompt = (
            "You must call ipython. In ipython execute exactly: "
            f"from pathlib import Path; print('CLIPROXYAPI_SYNC_OK='+Path({str(nonce_path)!r}).read_text()) "
            "Then repeat the exact printed line as the final answer. Do not guess or skip the tool call."
        )
        env = os.environ.copy()
        default_agent_dir = (Path.home() / ".prime" / "agent").resolve()
        if agent_dir == default_agent_dir:
            env.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
        else:
            env["PRIME_AGENT_CODING_AGENT_DIR"] = str(agent_dir)
        env["CLIPROXYAPI_DEBUG"] = "true"
        offsets = log_offsets(agent_dir / "logs")
        command = [args.prime_agent_bin, "--offline", "--no-session"]
        if args.extension_dir:
            command.extend(["--no-extensions", "-e", str(args.extension_dir.expanduser().resolve())])
        command.extend([
            "-e",
            str(trace_path),
            "--tools",
            "ipython",
            "--model",
            args.model,
            "-p",
            prompt,
        ])
        try:
            completed = subprocess.run(
                command,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                timeout=args.timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"Prime verification timed out after {args.timeout}s") from exc

        events: list[dict[str, Any]] = []
        if trace_output.exists():
            for line in trace_output.read_text().splitlines():
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    events.append(value)

        starts = [event for event in events if event.get("event") == "before_agent_start"]
        payloads = [event for event in events if event.get("event") == "before_provider_request"]
        selected = starts[-1] if starts else {}
        tool_names = sorted({name for event in payloads for name in event.get("toolNames", []) if isinstance(name, str)})
        commands = selected.get("commands") if isinstance(selected.get("commands"), list) else []
        log_errors = appended_log_errors(agent_dir / "logs", offsets)

        assertions = {
            "exitCodeZero": completed.returncode == 0,
            "providerExact": selected.get("provider") == expected_provider,
            "modelExact": selected.get("model") == expected_model,
            "apiExact": selected.get("api") == "cliproxyapi-codex-responses",
            "ipythonInPayload": "ipython" in tool_names,
            "cliproxyapiFastRegistered": "cliproxyapi-fast" in commands,
            "nonceReturned": marker in completed.stdout,
            "noKnownLogErrors": not log_errors,
        }
        report = {
            "ok": all(assertions.values()),
            "requestedModel": args.model,
            "extensionDir": str(args.extension_dir.expanduser().resolve()) if args.extension_dir else None,
            "selected": {
                "provider": selected.get("provider"),
                "model": selected.get("model"),
                "api": selected.get("api"),
            },
            "toolNames": tool_names,
            "commands": commands,
            "assertions": assertions,
            "logErrors": log_errors,
        }
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0 if report["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2), file=sys.stderr)
        raise SystemExit(1)
