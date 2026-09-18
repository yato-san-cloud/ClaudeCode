"""Wall clock -> elapsed seconds since t0 (WHSIM_CONTRACTS v1.0 §3, §5).

t0 is recorded in meta.json; every t in orders.json / events.jsonl is a number of
seconds relative to it. Timestamps are treated as naive local wall clocks: a WMS
export carries no timezone, and inventing one would shift every event.
"""

from __future__ import annotations

import math
import unicodedata
from datetime import date, datetime, timedelta

# Only used when mapping.yaml omits time.formats.
DEFAULT_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
    "%Y%m%d%H%M%S",
)

# Excel's serial-date origin (the 1900 leap-year bug is why it is Dec 30, 1899).
EXCEL_EPOCH = datetime(1899, 12, 30)


def parse_wallclock(value, formats: list[str] | tuple[str, ...] = ()) -> datetime | None:
    """Parse a cell into a naive datetime, or None if it is not a timestamp."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    if hasattr(value, "to_pydatetime"):  # pandas.Timestamp
        try:
            converted = value.to_pydatetime()
        except (ValueError, OverflowError):
            return None
        if isinstance(converted, datetime):
            return converted.replace(tzinfo=None) if converted.tzinfo else converted
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if math.isnan(value) or value <= 0:  # non-finite / non-positive serial
            return None
        return EXCEL_EPOCH + timedelta(days=float(value))

    text = unicodedata.normalize("NFKC", str(value)).strip()
    if not text or text.lower() in ("nan", "nat", "none", "null", "-"):
        return None
    for fmt in tuple(formats) or DEFAULT_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    try:  # last resort: ISO 8601
        return datetime.fromisoformat(text.replace("Z", ""))
    except ValueError:
        return None


def to_elapsed(when: datetime, t0: datetime, ndigits: int = 3) -> float:
    """Seconds since t0, rounded so that repeated runs are byte-identical."""
    return round((when - t0).total_seconds(), ndigits)


def iso(when: datetime | None) -> str | None:
    return None if when is None else when.isoformat(sep=" ")
