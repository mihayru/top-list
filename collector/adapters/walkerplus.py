"""Walkerplus 紅葉名所2026 (Kyoto prefecture list).

Research notes (2026-11-17):
* https://koyo.walkerplus.com/list/ar0726/ (+ /2.html … /13.html), 125 spots,
  10 per page. Each card has a colour-status class `status sN`
  (s1 青葉, s2 色づき始め, s4 今見頃, s5 色あせ始め, s7 落葉, s0 no data) and
  *typical* (not current) season dates.
* Detail pages state "紅葉色づき情報提供元：JRシステム" — the current status is
  the same JR system feed as JR Odekake. It is therefore NOT an independent
  confirmation; we store it as data_type=derived, derived_from=jr_odekake,
  and the consensus engine does not count it as a separate source.
* No observation date on list pages. robots.txt allows everything.
"""
from __future__ import annotations

import re

from bs4 import BeautifulSoup

from .base import Adapter, Observation
from ..statuses import WALKERPLUS, WALKERPLUS_LABEL, normalise
from ..util import clean, iso

BASE = "https://koyo.walkerplus.com"
FIRST = BASE + "/list/ar0726/"
MAX_PAGES = 20


class Walkerplus(Adapter):
    id = "walkerplus"
    name = "Walkerplus"
    home = FIRST
    kind = "Копия статусов из системы JR (не независимый источник)"
    description = "Статус «提供元：JRシステム» — те же данные, что у JR; без даты наблюдения."
    independent = False

    def collect(self, fetcher, now):
        first = fetcher.get(FIRST)
        pages = [first]
        nums = sorted({int(x) for x in re.findall(r'href="/list/ar0726/(\d+)\.html"', first)})
        last = min(max(nums) if nums else 1, MAX_PAGES)
        for p in range(2, last + 1):
            try:
                pages.append(fetcher.get(f"{FIRST}{p}.html"))
            except Exception:
                break
        out = []
        for html in pages:
            out.extend(self.parse(html, now))
        return out, {"pages": len(pages)}

    def parse(self, html: str, now) -> list[Observation]:
        s = BeautifulSoup(html, "lxml")
        out = []
        for art in s.select("ul.pref_list li.lists article"):
            a = art.find("a", href=True)
            nm = art.select_one("h2.name")
            if not a or not nm:
                continue
            m = re.search(r"/detail/([a-z0-9]+)/", a["href"])
            key = m.group(1) if m else a["href"]
            st_div = art.select_one("div.status")
            cls = next((c for c in (st_div.get("class") or []) if re.fullmatch(r"s\d", c)), "s0") if st_div else "s0"
            n = normalise(WALKERPLUS, cls)
            name = clean(nm.get_text())
            area = art.select_one(".area")
            typ = None
            for det in art.select(".detail"):
                t = clean(det.get_text())
                if "例年の紅葉見頃" in t:
                    typ = t.split("：", 1)[-1]
            out.append(Observation(
                source=self.id, source_key=key,
                name_ja=re.sub(r"の紅葉$", "", name),
                url=BASE + a["href"],
                status_original=WALKERPLUS_LABEL.get(cls, cls),
                status=n["status"], stage_lo=n["lo"], stage_hi=n["hi"],
                data_type="derived", derived_from="jr_odekake",
                fetched_at=iso(now),
                area=clean(area.get_text()) if area else None,
                observed_basis="дата не публикуется; статус из системы JR",
                extra={"typical": typ},
            ))
        return out
