"""Adapter contract.

Each source is an independent adapter. `collect()` returns observations; any
exception is caught by the runner, so one broken source never breaks the
others or the site.

Observation fields (all dates in Asia/Tokyo):
  source, source_key, name_ja, name_en, area, lat, lon, url
  status_original      exact label published by the source
  status, stage_lo, stage_hi   normalised status and its stage range
  percent, percent_meaning     only if the source publishes a number
  forecast_start, forecast_end forecast peak window (if any)
  observed_at          date the leaves were actually seen (photo/report date)
  observed_basis       how observed_at was determined
  published_at         when the source published/updated this entry
  fetched_at           when we downloaded it
  data_type            photo | official_report | field_report | news | forecast | model | derived
  comment              source text describing the leaves (original language)
  derived_from         source id if this is a copy of another source's data
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Observation:
    source: str
    source_key: str
    name_ja: str
    url: str
    status_original: str | None
    status: str
    stage_lo: int | None
    stage_hi: int | None
    data_type: str
    fetched_at: str
    name_en: str | None = None
    area: str | None = None
    lat: float | None = None
    lon: float | None = None
    percent: float | None = None
    percent_meaning: str | None = None
    forecast_start: str | None = None
    forecast_end: str | None = None
    observed_at: str | None = None
    observed_basis: str | None = None
    published_at: str | None = None
    comment: str | None = None
    photos: list[dict] = field(default_factory=list)
    derived_from: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self):
        d = asdict(self)
        return {k: v for k, v in d.items() if v not in (None, [], {})}


class Adapter:
    id: str = ""
    name: str = ""
    home: str = ""
    description: str = ""
    kind: str = ""          # what the source really publishes
    independent: bool = True

    def collect(self, fetcher, now) -> tuple[list[Observation], dict]:
        """Return (observations, meta). meta may hold page-level info."""
        raise NotImplementedError
