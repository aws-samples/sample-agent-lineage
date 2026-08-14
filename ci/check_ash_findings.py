#!/usr/bin/env python3
"""CI gate for ASH scan results.

Fails (exit 1) when the scan contains MEDIUM+ findings that are not in the
reviewed allowlist (.security/ash-allowlist.json). Line numbers are ignored on
purpose -- findings are keyed by (scanner, rule, file) so ordinary edits don't
break the gate, while any NEW rule/file pairing must be triaged and either
fixed or explicitly allowlisted with a reason.

Usage: check_ash_findings.py <ash.flat.json> <allowlist.json>
"""
import json
import sys

BLOCKING = {"CRITICAL", "HIGH", "MEDIUM"}


def key_of(item: dict) -> tuple:
    return (
        str(item.get("scanner", "")),
        str(item.get("rule_id") or item.get("ruleId") or ""),
        str(item.get("file_path") or item.get("location") or ""),
    )


def main() -> int:
    flat_path, allowlist_path = sys.argv[1], sys.argv[2]
    data = json.load(open(flat_path))
    findings = data if isinstance(data, list) else data.get("findings", data.get("results", []))
    allow = {
        (e["scanner"], e["rule"], e["file"])
        for e in json.load(open(allowlist_path))["allowlist"]
    }

    unknown = []
    for f in findings:
        if not isinstance(f, dict):
            continue
        if str(f.get("severity", "")).upper() not in BLOCKING:
            continue
        path = str(f.get("file_path") or "")
        if "node_modules/" in path or path.startswith(".venv") or "/.venv/" in path:
            continue  # third-party/dev tooling: tracked via dependency updates
        if path.startswith((".ash-ci", ".ash-output")) or "__zip/" in path:
            continue  # ASH's own output dirs and extracted archives (e.g. the
            # committed evidence bundle): scan reports mention the word
            # "secret" by nature; findings there are self-referential noise
        if key_of(f) not in allow:
            unknown.append(f)

    if unknown:
        print(f"FAIL: {len(unknown)} unreviewed MEDIUM+ finding(s):")
        for f in unknown:
            print(f"  [{f.get('severity')}] {key_of(f)[0]} {key_of(f)[1]} {key_of(f)[2]}:{f.get('line_start', '?')}")
        print("Fix the finding, or add it to .security/ash-allowlist.json with a reason after review.")
        return 1
    print("OK: no unreviewed MEDIUM+ findings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
