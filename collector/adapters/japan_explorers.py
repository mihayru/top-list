"""Japan Explorers 京都府の紅葉見頃予想.

Research notes (2026-11-17):
* https://www.japan-explorers.com/koyo/kyoto/ — 69 spots, server-rendered
  rows `li.jfc-row` with stage (data-st: before/soon/peak/late/done),
  forecast peak window ("11/11〜11/20"), a progress percentage and the basis
  ("標高から推定・気温補正" = altitude/temperature model, "ニュース確認" =
  confirmed by a dated news item / video, linked).
* The percentage is the model's position inside the season window, NOT the
  share of red leaves. We store it with that meaning.
* Page stamp `<time datetime>`: regenerated daily ~05:00 JST and when news
  changes. Also a 3-day JMA weather forecast for the prefecture.
* robots.txt: generic agents allowed (only auth endpoints blocked). It does
  block named AI crawlers; this collector is a personal tool, not an AI
  crawler, and identifies itself honestly as "KoyoRadar".
"""
from __future__ import annotations

import re

from bs4 import BeautifulSoup

from .base import Adapter, Observation
from ..statuses import JAPAN_EXPLORERS, normalise
from ..util import clean, d2s, date_from_md, date_from_ymd, infer_year, iso

PAGE = "https://www.japan-explorers.com/koyo/kyoto/"


def _title_date(title: str, now):
    """Explicit shooting/observation date inside a news title, if any."""
    if not title:
        return None
    d = date_from_ymd(title)
    if d:
        return d
    m = re.search(r"(\d{1,2})\s*[./]\s*(\d{1,2})\s*撮影", title) or \
        re.search(r"(\d{1,2})月(\d{1,2})日", title) or \
        re.search(r"(?<!\d)(\d{1,2})/(\d{1,2})\s*[\(（][月火水木金土日]", title)
    if m:
        try:
            return infer_year(int(m.group(1)), int(m.group(2)), now)
        except ValueError:
            return None
    return None


class JapanExplorers(Adapter):
    id = "japan_explorers"
    name = "Japan Explorers"
    home = PAGE
    kind = "Модель-прогноз (высота+температура), иногда подтверждена датированной новостью"
    description = "Прогнозное окно пика по модели; часть мест подтверждена ссылкой на новость/видео с датой."

    def collect(self, fetcher, now):
        html = fetcher.get(PAGE)
        return self.parse(html, now), self.page_meta(html, now)

    def page_meta(self, html, now):
        s = BeautifulSoup(html, "lxml")
        meta = {}
        t = s.select_one("p.jfc-stamp time")
        if t and t.get("datetime"):
            meta["published_at"] = t["datetime"]
        wx = []
        for li in s.select("ul.jfc-wx-l li"):
            d = date_from_md(clean(li.select_one(".jfc-wx-d").get_text() if li.select_one(".jfc-wx-d") else ""), now)
            w = li.select_one(".jfc-wx")
            pop = None
            if w:
                m = re.search(r"(\d+)%", w.get_text())
                pop = int(m.group(1)) if m else None
                small = w.find("small")
                if small:
                    small.extract()
            wx.append({"date": d2s(d), "weather": clean(w.get_text()) if w else None, "rain_pct": pop})
        if wx:
            meta["weather"] = {"source": "気象庁 (via Japan Explorers)", "days": wx}
        c = s.select_one("section.jfc-ai .jfc-ai-b")
        if c:
            meta["comment"] = clean(c.get_text())
        return meta

    def parse(self, html: str, now) -> list[Observation]:
        s = BeautifulSoup(html, "lxml")
        published = None
        t = s.select_one("p.jfc-stamp time")
        if t and t.get("datetime"):
            published = t["datetime"]
        out = []
        for li in s.select("ul.jfc-rows li.jfc-row"):
            name = clean(li.get("data-name"))
            if not name:
                continue
            st_key = li.get("data-st") or ""
            badge = li.select_one(".jfc-badge")
            label = clean(badge.get_text()).lstrip("◎○●△×").strip() if badge else st_key
            n = normalise(JAPAN_EXPLORERS, st_key) if st_key in JAPAN_EXPLORERS else normalise(JAPAN_EXPLORERS, label)
            prog = li.select_one(".jfc-prog")
            pct = basis = None
            if prog:
                b = prog.find("b")
                if b:
                    m = re.search(r"(\d+(?:\.\d+)?)", b.get_text())
                    pct = float(m.group(1)) if m else None
                sm = prog.find("small")
                basis = clean(sm.get_text()) if sm else None
            rng = li.select_one(".jfc-row-p > span")
            fs = fe = None
            if rng:
                parts = re.findall(r"(\d{1,2})/(\d{1,2})", rng.get_text())
                if len(parts) >= 1:
                    fs = infer_year(int(parts[0][0]), int(parts[0][1]), now)
                if len(parts) >= 2:
                    fe = infer_year(int(parts[1][0]), int(parts[1][1]), now)
            conf = li.select_one(".jfc-conf.is-news")
            news = None
            if conf:
                k = conf.select_one(".jfc-conf-k")
                a = conf.select_one("a.jfc-conf-t")
                news = {
                    "date": d2s(date_from_md(clean(k.get_text()) if k else "", now)),
                    "title": clean(a.get_text()) if a else None,
                    "url": a.get("href") if a else None,
                }
            ai = li.select_one(".jfc-row-ai")
            note = li.select_one(".jfc-row-note")
            link = li.select_one(".jfc-row-n a")
            obs = _title_date(news["title"], now) if news else None
            out.append(Observation(
                source=self.id, source_key=name, name_ja=name,
                url=link["href"] if link and link.get("href") else PAGE,
                status_original=label or st_key or None,
                status=n["status"], stage_lo=n["lo"], stage_hi=n["hi"],
                data_type="news" if news else "model",
                fetched_at=iso(now),
                percent=pct,
                percent_meaning="позиция в прогнозном окне сезона по модели Japan Explorers — НЕ доля красных листьев" if pct is not None else None,
                forecast_start=d2s(fs), forecast_end=d2s(fe),
                observed_at=d2s(obs),
                observed_basis=("дата из заголовка новости/видео" if obs else
                                ("дата наблюдения не указана (есть только дата новости)" if news else "модель, наблюдения нет")),
                published_at=(news or {}).get("date") or published,
                comment=clean(ai.get_text()) if ai else (clean(note.get_text()) if note else None),
                extra={"basis": basis, "news": news, "page_updated": published},
            ))
        return out
