"""Command-line interface for ``toki``.

Usage examples::

    toki notes.txt prompt.md      # estimate one or more files
    toki                          # estimate text read from stdin
    echo "hello world" | toki     # estimate piped text
    toki --json prompt.md         # machine-readable output
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass

from .estimator import Estimate, estimate


@dataclass
class Row:
    name: str
    estimate: Estimate


def _read_stdin() -> str:
    return sys.stdin.read()


def _gather(paths: list[str]) -> tuple[list[Row], list[str]]:
    """Return (rows, errors) for the given paths, or stdin when empty."""
    rows: list[Row] = []
    errors: list[str] = []

    if not paths:
        rows.append(Row("<stdin>", estimate(_read_stdin())))
        return rows, errors

    for path in paths:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                rows.append(Row(path, estimate(fh.read())))
        except OSError as exc:
            errors.append(f"{path}: {exc.strerror or exc}")
    return rows, errors


def _render_table(rows: list[Row]) -> str:
    headers = ("FILE", "TOKENS", "WORDS", "CHARS")
    table = [headers]
    for row in rows:
        est = row.estimate
        table.append((row.name, str(est.tokens), str(est.words), str(est.characters)))

    if len(rows) > 1:
        total = Estimate(
            tokens=sum(r.estimate.tokens for r in rows),
            characters=sum(r.estimate.characters for r in rows),
            words=sum(r.estimate.words for r in rows),
        )
        table.append(("TOTAL", str(total.tokens), str(total.words), str(total.characters)))

    widths = [max(len(r[c]) for r in table) for c in range(len(headers))]
    lines = []
    for i, row in enumerate(table):
        cells = [row[0].ljust(widths[0])] + [
            row[c].rjust(widths[c]) for c in range(1, len(headers))
        ]
        lines.append("  ".join(cells))
        if i == 0:
            lines.append("  ".join("-" * widths[c] for c in range(len(headers))))
    return "\n".join(lines)


def _render_json(rows: list[Row]) -> str:
    payload = {row.name: row.estimate.as_dict() for row in rows}
    if len(rows) > 1:
        payload["__total__"] = {
            "tokens": sum(r.estimate.tokens for r in rows),
            "characters": sum(r.estimate.characters for r in rows),
            "words": sum(r.estimate.words for r in rows),
        }
    return json.dumps(payload, indent=2, ensure_ascii=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="toki",
        description="Estimate the LLM token usage of text or files (heuristic, offline).",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        metavar="FILE",
        help="files to estimate; reads stdin when omitted",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit machine-readable JSON instead of a table",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    rows, errors = _gather(args.paths)

    if rows:
        out = _render_json(rows) if args.json else _render_table(rows)
        print(out)

    for err in errors:
        print(f"toki: {err}", file=sys.stderr)

    return 1 if errors else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
