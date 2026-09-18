"""Fatal, user-facing errors.

Only genuinely unusable input raises. Everything ambiguous is a report entry
(DoD 5: unclassified / ambiguous / isolated items never stop the run).
"""


class Cad2locError(Exception):
    """Input the tool cannot process at all. Printed without a traceback."""

    def __init__(self, message: str, hint: str = ""):
        super().__init__(message)
        self.message = message
        self.hint = hint

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.message + (f"\n  → {self.hint}" if self.hint else "")
