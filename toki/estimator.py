"""Heuristic token estimation.

This module estimates how many LLM tokens a piece of text is likely to use.
It is a *heuristic* — not an exact tokenizer. It does not depend on any model's
vocabulary and works fully offline with the Python standard library.

The approach groups the text into runs and scores each run:

* Latin/word characters are estimated at ~4 characters per token (the rough
  ratio seen with byte-pair encodings like cl100k_base for English prose).
* CJK characters (Chinese, Japanese, Korean) are counted close to one token
  each, which matches the denser tokenization those scripts receive.
* Runs of punctuation/symbols are counted one token per character.
* Whitespace is free.

The estimate is intentionally conservative and meant for quick "is this prompt
roughly 500 or 5000 tokens?" checks, not billing-grade accuracy.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

# Average characters per token for latin-script word runs.
_CHARS_PER_TOKEN = 4

# A run is one of: a word (letters/digits/underscore/apostrophe), a single
# whitespace blob, or any other single character (punctuation/symbol).
_WORD_RE = re.compile(r"[^\W_]+(?:['_][^\W_]+)*", re.UNICODE)
_SPACE_RE = re.compile(r"\s+", re.UNICODE)


@dataclass(frozen=True)
class Estimate:
    """Result of estimating a string."""

    tokens: int
    characters: int
    words: int

    def as_dict(self) -> dict[str, int]:
        return {"tokens": self.tokens, "characters": self.characters, "words": self.words}


def _is_cjk(char: str) -> bool:
    """Return True for Chinese/Japanese/Korean ideographs and kana."""
    code = ord(char)
    return (
        0x4E00 <= code <= 0x9FFF  # CJK Unified Ideographs
        or 0x3040 <= code <= 0x30FF  # Hiragana + Katakana
        or 0x3400 <= code <= 0x4DBF  # CJK Extension A
        or 0xAC00 <= code <= 0xD7A3  # Hangul syllables
        or 0xF900 <= code <= 0xFAFF  # CJK Compatibility Ideographs
    )


def _word_tokens(word: str) -> int:
    """Estimate tokens for a single word-like run.

    CJK characters in the run are counted individually; the remaining latin
    characters are charged at roughly ``_CHARS_PER_TOKEN`` characters each.
    """
    cjk = sum(1 for ch in word if _is_cjk(ch))
    latin = len(word) - cjk
    tokens = cjk
    if latin:
        tokens += max(1, math.ceil(latin / _CHARS_PER_TOKEN))
    return tokens


def estimate(text: str) -> Estimate:
    """Estimate the token usage of ``text``."""
    characters = len(text)
    words = len(_WORD_RE.findall(text))

    tokens = 0
    pos = 0
    length = len(text)
    while pos < length:
        space = _SPACE_RE.match(text, pos)
        if space:
            pos = space.end()
            continue
        word = _WORD_RE.match(text, pos)
        if word:
            tokens += _word_tokens(word.group())
            pos = word.end()
            continue
        # Lone punctuation / symbol character.
        char = text[pos]
        if not unicodedata.category(char).startswith("C"):  # skip control chars
            tokens += 1
        pos += 1

    return Estimate(tokens=tokens, characters=characters, words=words)
