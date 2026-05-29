# toki

A tiny, **offline** LLM token estimator for text and files. No model downloads,
no network, no third-party dependencies — just the Python standard library.

`toki` answers the everyday question *"roughly how many tokens is this prompt?"*
It is a **heuristic**, not an exact tokenizer: it won't match a specific model's
vocabulary to the token, but it's fast, dependency-free, and good enough for
sizing prompts and spotting "this is 5k tokens, not 500" mistakes.

## How the estimate works

The text is grouped into runs and scored:

| Run type            | Cost                                          |
| ------------------- | --------------------------------------------- |
| Latin word          | `ceil(chars / 4)` tokens (min 1)              |
| CJK character        | ~1 token each (Chinese, Japanese, Korean)     |
| Punctuation/symbol  | 1 token per character                         |
| Whitespace          | free                                          |

The 4-characters-per-token ratio mirrors what byte-pair encodings like
`cl100k_base` typically produce for English prose; CJK scripts are counted more
densely because they tokenize that way in practice.

## Install

```bash
pip install -e .
```

This exposes a `toki` command. You can also run it without installing:

```bash
python3 -m toki ...
```

## Usage

```bash
toki prompt.md                 # estimate one file
toki notes.txt prompt.md       # estimate several files (prints a TOTAL row)
toki                           # estimate text from stdin
echo "hello world" | toki      # estimate piped text
toki --json prompt.md          # machine-readable JSON
```

Example:

```
$ toki notes.txt prompt.md
FILE        TOKENS  WORDS  CHARS
----------  ------  -----  -----
notes.txt       42     31    180
prompt.md      210    160    900
TOTAL          252    191   1080
```

Exit code is `0` on success and `1` if any file could not be read (the readable
files are still reported).

## Library use

```python
from toki import estimate

est = estimate("Hello, world!")
print(est.tokens, est.words, est.characters)
print(est.as_dict())
```

## Development

Tests use the standard library `unittest` (no extra packages required):

```bash
python3 -m unittest discover -s tests -v
```

## License

MIT
