# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

This repository hosts **`toki`**, a small, dependency-free CLI that estimates
the LLM token usage of text and files. It is implemented in pure Python (3.9+)
using only the standard library. The remote is `yato-san-cloud/ClaudeCode` on a
local proxy.

## Architecture

- `toki/estimator.py` — the heuristic core. `estimate(text) -> Estimate` groups
  text into runs (words, CJK characters, punctuation, whitespace) and scores
  each. This is the only place token logic lives; keep it dependency-free.
- `toki/cli.py` — argument parsing and output rendering (table + `--json`).
  Reads files or stdin; returns exit code `1` if any file fails to read.
- `toki/__main__.py` — enables `python3 -m toki`.
- `tests/` — `unittest` suites for the estimator and the CLI.

## Commands

```bash
# Run all tests (no third-party deps needed)
python3 -m unittest discover -s tests -v

# Run a single test
python3 -m unittest tests.test_estimator.EstimatorTest.test_cjk_counted_per_character

# Run the tool without installing
python3 -m toki <file>...        # or pipe text via stdin

# Editable install (exposes the `toki` command)
pip install -e .
```

## Conventions

- No runtime dependencies — standard library only. Tests use `unittest`.
- The token count is a deliberate heuristic, not an exact tokenizer; document
  any change to the scoring model in `estimator.py` and `README.md` together.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/add-claude-documentation-oNCDe`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
