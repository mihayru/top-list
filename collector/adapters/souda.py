"""Sōda Kyoto (そうだ 京都、行こう。 — JR Central).

Research notes (2026-11-17):
* Page https://souda-kyoto.jp/guide/season/koyo/index.html lists ~77 spots.
* The page's own data file `modal.json` (same directory) holds, per spot:
  condition label, typical best time, and staff photos whose captions end
  with the exact shooting date ("… 2026/11/16撮影").
* These are first-hand field photographs by local staff => data_type=photo,
  observed_at = newest photo date. Updated several times a week per spot.
* robots.txt: none (404) => no restriction. No API/RSS.
"""
from __future__ import annotations

import json
import re
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin

from .base import Adapter, Observation
from ..statuses import SOUDA, normalise
from ..util import JST, clean, d2s, date_from_ymd, iso

PAGE = "https://souda-kyoto.jp/guide/season/koyo/index.html"
DATA = "https://souda-kyoto.jp/guide/season/koyo/modal.json"

AREAS = {
    1: "京都駅周辺", 2: "祇園・東山", 3: "北野天満宮・二条城", 4: "上賀茂神社・大徳寺",
    5: "嵯峨野・嵐山", 6: "山科・醍醐", 7: "三十三間堂・東福寺", 8: "哲学の道・岡崎",
    9: "下鴨神社・京都御苑", 10: "金閣寺・龍安寺・仁和寺", 11: "宝ヶ池・一乗寺", 12: "伏見・宇治",
    13: "大原・鞍馬・貴船", 14: "大原野・長岡京", 15: "三尾・京北", 16: "京田辺・木津川", 17: "その他",
}

DATE_RE = re.compile(r"\s*(20\d\d)/(\d{1,2})/(\d{1,2})\s*撮影\s*$")


class Souda(Adapter):
    id = "souda"
    name = "Sōda Kyoto (JR Central)"
    home = PAGE
    kind = "Полевые фото сотрудников с датой съёмки"
    description = "Сотрудники «そうだ 京都、行こう。» фотографируют ~77 мест и подписывают дату съёмки."

    def collect(self, fetcher, now):
        raw = fetcher.get(DATA)
        last_mod = fetcher.last_headers.get("Last-Modified")
        published = None
        if last_mod:
            try:
                published = iso(parsedate_to_datetime(last_mod))
            except (TypeError, ValueError):
                published = None
        return self.parse(raw, now, published), {"published_at": published}

    def parse(self, raw: str, now, published_at=None) -> list[Observation]:
        items = json.loads(raw)
        out = []
        for it in items:
            sid = it.get("ID", "")
            slug = (it.get("spot") or "").rstrip("/").split("/")[-1].replace(".html", "")
            area_no = int(sid.split(",")[0]) if sid and sid.split(",")[0].isdigit() else None
            photos, dates, notes = [], [], []
            for im in it.get("images") or []:
                cap = clean(im.get("caption"))
                d = date_from_ymd(cap) if DATE_RE.search(cap) else None
                text = DATE_RE.sub("", cap).strip()
                if d:
                    dates.append(d)
                if text:
                    notes.append(text)
                photos.append({
                    "url": urljoin(PAGE, im.get("img", "")),
                    "caption": text,
                    "date": d2s(d),
                })
            label = clean(it.get("condition")) or None
            n = normalise(SOUDA, label)
            obs_date = max(dates) if dates else None
            out.append(Observation(
                source=self.id,
                source_key=slug or sid,
                name_ja=clean(it.get("title")),
                url=PAGE,
                status_original=label,
                status=n["status"], stage_lo=n["lo"], stage_hi=n["hi"],
                data_type="photo" if obs_date else "field_report",
                fetched_at=iso(now),
                area=AREAS.get(area_no),
                observed_at=d2s(obs_date),
                observed_basis="дата съёмки в подписи к фото" if obs_date else "дата не указана",
                published_at=published_at,
                comment=" / ".join(dict.fromkeys(notes)) or None,
                photos=photos,
                extra={"typical_best": clean(it.get("besttime")) or None,
                       "spot_page": urljoin(PAGE, it.get("spot") or "") if it.get("spot") else None},
            ))
        return out
