"""JR Odekake 紅葉だより (JR West).

Research notes (2026-11-17):
* https://kisetsu.jr-odekake.net/result/MMJ/A1005?lang=ja — one HTML table,
  ~48 venues in Kyoto prefecture. Columns: venue, status (5 levels), station,
  address (+ Google Maps link with exact coordinates), contact, short comment,
  observation point, "情報更新日" (date the venue reported).
* Reports are submitted by the venues/tourist associations themselves =>
  data_type=official_report. Most rows are updated daily in season.
* `?lang=en` gives official English venue names (same row ids).
* robots.txt: `Disallow: /` + `Allow: /result/` => only /result/ pages are
  fetched (RFC 9309 longest-match).
"""
from __future__ import annotations

import re

from bs4 import BeautifulSoup

from .base import Adapter, Observation
from ..statuses import JR, normalise
from ..util import clean, d2s, date_from_ymd, iso

URL_JA = "https://kisetsu.jr-odekake.net/result/MMJ/A1005?lang=ja"
URL_EN = "https://kisetsu.jr-odekake.net/result/MMJ/A1005?lang=en"

KANJI_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
PCT_RE = re.compile(r"([0-9０-９一二三四五六七八九十]{1,2})(?:\s*[～〜~\-]\s*([0-9０-９一二三四五六七八九十]{1,2}))?\s*(割|分|部)\s*(程|ほど|程度|くらい|位)?")


def _num(s):
    if s is None:
        return None
    s = s.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    if s.isdigit():
        return int(s)
    return KANJI_NUM.get(s)


def extract_percent(comment: str | None):
    """'4割ほど' -> 40, '5～6割程度' -> 55, 'カエデは五分程度' -> 50. Only explicit numbers."""
    if not comment:
        return None
    m = PCT_RE.search(comment)
    if not m:
        return None
    if m.group(3) == "部" and not m.group(4):
        return None  # '一部見頃' etc. is not a number
    a, b = _num(m.group(1)), _num(m.group(2))
    if a is None or a > 10 or (b is not None and b > 10):
        return None
    v = (a + b) / 2 if b else a
    return v * 10


class JROdekake(Adapter):
    id = "jr_odekake"
    name = "JR Odekake 紅葉だより"
    home = URL_JA
    kind = "Официальные отчёты самих храмов/парков (через JR West)"
    description = "Храмы и турассоциации сами сообщают статус и дату обновления."

    def collect(self, fetcher, now):
        ja = fetcher.get(URL_JA)
        try:
            en = fetcher.get(URL_EN)
        except Exception:  # English names are optional
            en = None
        return self.parse(ja, en, now), {}

    @staticmethod
    def _rows(html, min_cols=8):
        s = BeautifulSoup(html, "lxml")
        for tr in s.select("tbody#list tr"):
            tds = tr.find_all("td")
            if len(tds) < min_cols:
                continue
            key = tds[0].get("data-db-order")
            yield key, tds

    def parse(self, ja_html: str, en_html: str | None, now) -> list[Observation]:
        en_names = {}
        if en_html:
            for key, tds in self._rows(en_html, min_cols=2):
                en_names[key] = clean(tds[0].get_text())
        out = []
        for key, tds in self._rows(ja_html):
            name = clean(tds[0].get_text())
            status_cell = tds[1]
            label = clean(status_cell.get_text())
            past = status_cell.find("a", href=re.compile("pastinfo"))
            maplink = tds[3].find("a", href=re.compile(r"maps"))
            lat = lon = None
            if maplink:
                m = re.search(r"q=([0-9.]+),([0-9.]+)", maplink["href"])
                if m:
                    lat, lon = round(float(m.group(1)), 6), round(float(m.group(2)), 6)
            comment = clean(tds[5].get_text())
            comment = None if comment in ("-", "--", "") else comment
            point = clean(tds[6].get_text()) or None
            d = date_from_ymd(clean(tds[7].get_text()))
            n = normalise(JR, label)
            pct = extract_percent(comment)
            out.append(Observation(
                source=self.id, source_key=name, name_ja=name, name_en=en_names.get(key),
                url=URL_JA, status_original=label or None,
                status=n["status"], stage_lo=n["lo"], stage_hi=n["hi"],
                data_type="official_report", fetched_at=iso(now),
                area=clean(tds[3].get_text()) or None, lat=lat, lon=lon,
                observed_at=d2s(d), observed_basis="дата отчёта места («情報更新日»)",
                published_at=d2s(d),
                comment=comment,
                percent=pct,
                percent_meaning=("доля окрашенных листьев со слов самого места (из комментария)" if pct is not None else None),
                extra={"db_order": key, "observation_point": point,
                       "history_url": ("https://kisetsu.jr-odekake.net" + past["href"]) if past else None,
                       "station": clean(tds[2].get_text()) or None},
            ))
        return out
