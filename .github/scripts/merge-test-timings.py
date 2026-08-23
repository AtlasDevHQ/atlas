#!/usr/bin/env python3
"""Merge per-shard `bun test --update-timings` maps into one balancer input (#5383).

Under `--shard`, `--update-timings` writes ONLY the files that shard ran, so the
inputs are disjoint and their union is the whole suite. This script does the
union, and — more importantly — REFUSES the two merges that would quietly
produce a worse balancer than the stale file they replace:

  - **A shard that measured nothing.** An empty or missing map means that leg
    died before any test body ran. Merging it contributes no entries, so the
    result silently keeps the baseline's numbers for a quarter of the suite and
    reads as a full refresh.
  - **A collision between shards.** Disjointness is the whole premise. If two
    shards claim the same file, the shard composition did not match the one the
    durations are being measured under, and last-writer-wins would pick an
    arbitrary number.

A file present in the baseline but absent from every shard is REPORTED and
carried over, not dropped: dropping it makes the balancer treat it as unknown,
and coverage loss should be visible rather than inferred from a smaller file.
"""

from __future__ import annotations

import argparse
import glob
import json
import pathlib
import sys


def load(path: pathlib.Path) -> dict[str, int]:
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as err:
        sys.exit(f"error: {path}: unreadable ({err})")
    files = payload.get("files")
    if not isinstance(files, dict):
        sys.exit(f"error: {path}: no 'files' object — not a bun timings file")
    return files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("shards", nargs="+", help="per-shard measured timings JSON")
    ap.add_argument("--out", required=True)
    ap.add_argument("--baseline", required=True)
    args = ap.parse_args()

    paths: list[pathlib.Path] = []
    for pattern in args.shards:
        # The workflow passes a glob; a shell that found no match hands it
        # through verbatim, which must be an error rather than an empty merge.
        matched = [pathlib.Path(p) for p in sorted(glob.glob(pattern))]
        if not matched:
            sys.exit(f"error: no file matched {pattern!r}")
        paths.extend(matched)

    merged: dict[str, int] = {}
    owner: dict[str, str] = {}
    for path in paths:
        files = load(path)
        if not files:
            sys.exit(
                f"error: {path} measured 0 files. That leg produced no durations, so a "
                f"quarter of the suite would silently keep the stale baseline. Re-run the "
                f"refresh rather than committing a partial map."
            )
        for name, ms in files.items():
            if name in merged:
                sys.exit(
                    f"error: {name} was measured by both {owner[name]} and {path}. The shards "
                    f"were not disjoint, so the composition did not match the one being "
                    f"measured under and the merge would be arbitrary."
                )
            merged[name] = ms
            owner[name] = str(path)
        print(f"  {path.name}: {len(files)} files")

    baseline = load(pathlib.Path(args.baseline))
    missing = sorted(set(baseline) - set(merged))
    for name in missing:
        merged[name] = baseline[name]

    print(f"\nmerged {len(merged)} files from {len(paths)} shard(s)")
    if missing:
        print(
            f"⚠️  {len(missing)} file(s) were in the baseline and measured by no shard — "
            f"their OLD durations are carried over:"
        )
        for name in missing[:20]:
            print(f"     {name}")
        if len(missing) > 20:
            print(f"     … and {len(missing) - 20} more")

    out = pathlib.Path(args.out)
    out.write_text(
        json.dumps({"version": 1, "files": dict(sorted(merged.items()))}, indent=2) + "\n"
    )
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
