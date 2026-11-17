"""Weathernews 紅葉情報 Kyoto.

Research notes (2026-11-17):
* https://weathernews.jp/koyo/area/kyoto/ is a Nuxt page; the full spot data
  (95 spots) is embedded in `__NUXT_DATA__`: status label (rank_txt) with a
  fine scale (rank_detail 0 … 1.2 … 1.6 … 2 …), `obsmon/obsday` = date of the
  latest observation report, `migoromon/migoroday` + `hasPassed` = date peak
  began (past) or forecast peak date (future), exact coordinates.
* Status comes from Weathernews users' on-site reports ("ウェザーリポート")
  => data_type=field_report; forecast peak date => separate forecast field.
* robots.txt does not restrict /koyo/ for generic agents.
"""
from __future__ import annotations

from .base import Adapter, Observation
from .nuxt import extract, walk
from ..statuses import WEATHERNEWS, normalise
from ..util import clean, d2s, infer_year, iso

PAGE = "https://weathernews.jp/koyo/area/kyoto/"


def _md(mon, day, now):
    try:
        mon, day = int(mon), int(day)
    except (TypeError, ValueError):
        return None
    if not (1 <= mon <= 12 and 1 <= day <= 31):
        return None
    return infer_year(mon, day, now)


class Weathernews(Adapter):
    id = "weathernews"
    name = "Weathernews"
    home = PAGE
    kind = "Репорты пользователей с места + прогноз даты пика"
    description = "Статус по отчётам «ウェザーリポーター» с датой последнего наблюдения; отдельно — прогноз даты пика."

    def collect(self, fetcher, now):
        return self.parse(fetcher.get(PAGE), now), {}

    def parse(self, html: str, now) -> list[Observation]:
        data = extract(html)
        best: dict[str, dict] = {}
        for s in walk(data, lambda x: "spotid" in x and "pointname" in x):
            sid = str(s.get("spotid"))
            cur = best.get(sid)
            if cur is None or (not cur.get("rank_txt") and s.get("rank_txt")):
                best[sid] = s
        out = []
        for sid, s in best.items():
            label = clean(s.get("rank_txt")) or "情報なし"
            n = normalise(WEATHERNEWS, label)
            obs = _md(s.get("obsmon"), s.get("obsday"), now)
            mig = _md(s.get("migoromon"), s.get("migoroday"), now)
            passed = bool(s.get("hasPassed"))
            fstart = None
            peak_began = None
            if mig:
                if passed:
                    peak_began = mig
                else:
                    fstart = mig
            try:
                lat, lon = round(float(s.get("latd")), 6), round(float(s.get("lond")), 6)
            except (TypeError, ValueError):
                lat = lon = None
            has_obs = obs is not None and n["status"] != "UNKNOWN"
            out.append(Observation(
                source=self.id, source_key=sid, name_ja=clean(s.get("pointname")),
                url=f"https://weathernews.jp/koyo/spot/{sid}/",
                status_original=label,
                status=n["status"], stage_lo=n["lo"], stage_hi=n["hi"],
                data_type="field_report" if has_obs else ("forecast" if fstart else "field_report"),
                fetched_at=iso(now),
                area=clean(s.get("kyotoAreaJP")) or clean(s.get("cityname")) or None,
                lat=lat, lon=lon,
                observed_at=d2s(obs) if has_obs else None,
                observed_basis="дата последнего репорта (obs)" if has_obs else "нет репортов",
                forecast_start=d2s(fstart),
                comment=clean(s.get("headComment")) or None,
                extra={"rank_detail": s.get("rank_detail") or None,
                       "peak_began": d2s(peak_began),
                       "typical": clean(s.get("reinen")) or None,
                       "kana": clean(s.get("pointname_kana")) or None,
                       "address": clean(s.get("address")) or None},
            ))
        return out
