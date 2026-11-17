"""Manual imports (for sources that cannot or must not be scraped).

Japan-Guide (https://www.japan-guide.com/blog/) answers automated requests
with HTTP 403, so it is never fetched automatically. Its dated field reports
(and anything else, e.g. temple websites/Instagram) can be added by hand to
`data/manual/*.json`:

{
  "source": "japan_guide",
  "source_name": "Japan-Guide blog",
  "entries": [
    {"place": "sanzenin", "status": "PEAK", "observed_at": "2026-11-16",
     "published_at": "2026-11-16", "data_type": "field_report",
     "url": "https://www.japan-guide.com/blog/…", "comment": "…",
     "status_original": "best"}
  ]
}

`place` is a place id from data/places.json (or any registered alias).
Use `python -m collector.manual_cli` for a guided add.
"""
from __future__ import annotations

import json
from pathlib import Path

from .base import Adapter, Observation
from ..statuses import GENERIC, normalise
from ..util import iso

MANUAL_DIR = Path(__file__).resolve().parents[2] / "data" / "manual"
ALLOWED_TYPES = {"photo", "official_report", "field_report", "news", "forecast", "model"}


class Manual(Adapter):
    id = "manual"
    name = "Ручной импорт"
    home = ""
    kind = "Записи, добавленные вручную с указанием первоисточника"

    def collect(self, fetcher, now):
        out = []
        files = sorted(MANUAL_DIR.glob("*.json"))
        for f in files:
            if f.name.startswith("_"):
                continue
            doc = json.loads(f.read_text(encoding="utf-8"))
            src = doc.get("source") or f.stem
            for i, e in enumerate(doc.get("entries") or []):
                if not e.get("url"):
                    raise ValueError(f"{f.name}#{i}: manual entry needs a source url")
                n = normalise(GENERIC, e.get("status"))
                dt = e.get("data_type") or "field_report"
                if dt not in ALLOWED_TYPES:
                    raise ValueError(f"{f.name}#{i}: bad data_type {dt}")
                out.append(Observation(
                    source=src,
                    source_key=str(e.get("place")),
                    name_ja=e.get("name_ja") or str(e.get("place")),
                    url=e["url"],
                    status_original=e.get("status_original") or e.get("status"),
                    status=n["status"], stage_lo=n["lo"], stage_hi=n["hi"],
                    data_type=dt, fetched_at=iso(now),
                    observed_at=e.get("observed_at"),
                    observed_basis=e.get("observed_basis") or ("дата из первоисточника" if e.get("observed_at") else "не указана"),
                    published_at=e.get("published_at"),
                    comment=e.get("comment"),
                    percent=e.get("percent"), percent_meaning=e.get("percent_meaning"),
                    forecast_start=e.get("forecast_start"), forecast_end=e.get("forecast_end"),
                    extra={"manual_file": f.name, "source_name": doc.get("source_name"), "place_id": e.get("place")},
                ))
        return out, {"files": [f.name for f in files]}
