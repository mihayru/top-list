"""Time and text helpers. All dates are Asia/Tokyo."""
from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")


def now_jst() -> datetime:
    return datetime.now(timezone.utc).astimezone(JST)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(JST).isoformat(timespec="seconds")


def infer_year(month: int, day: int, ref: datetime | None = None) -> date:
    """Resolve a month/day without year to the closest date around `ref`.

    Sites print "11/16" without a year. A date more than ~6 months in the
    future is assumed to belong to the previous year (e.g. "12/30" seen on
    Jan 2), and vice versa.
    """
    ref = ref or now_jst()
    best = None
    for y in (ref.year - 1, ref.year, ref.year + 1):
        try:
            d = date(y, month, day)
        except ValueError:
            continue
        diff = abs((d - ref.date()).days)
        if best is None or diff < best[0]:
            best = (diff, d)
    return best[1]


def date_from_md(text: str, ref: datetime | None = None) -> date | None:
    m = re.search(r"(\d{1,2})\s*[/月]\s*(\d{1,2})", text or "")
    if not m:
        return None
    return infer_year(int(m.group(1)), int(m.group(2)), ref)


def date_from_ymd(text: str) -> date | None:
    m = re.search(r"(20\d\d)\s*[/年.\-]\s*(\d{1,2})\s*[/月.\-]\s*(\d{1,2})", text or "")
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def d2s(d: date | None) -> str | None:
    return d.isoformat() if d else None


def norm_name(s: str) -> str:
    """Normalise a place name for exact alias comparison (no fuzzy matching)."""
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = re.sub(r"[\s　・･\-‐–—_'\".,()（）\[\]［］「」『』【】〈〉]", "", s)
    s = s.replace("の紅葉", "") if s.endswith("の紅葉") else s
    return s


def clean(s: str | None) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s or "")).strip()


def days_between(a: date, b: date) -> int:
    return (b - a).days


def add_days(d: date, n: int) -> date:
    return d + timedelta(days=n)
