"""Daily "slow data": opening hours, prices, official sites and 2026 evening light-ups.

Sources (researched 2026-11-17):
* Sōda Kyoto «秋の夜間特別拝観と紅葉ライトアップ»
  https://souda-kyoto.jp/event/detail/lightup-autumn.html — JR Central's 2026
  list (stated "information as of August 2026"): dates, hours, last entry,
  price per light-up; spot links map to our Sōda place keys.
* Walkerplus detail pages (koyo.walkerplus.com/detail/<id>/ and /data.html):
  2026 light-up period & hours ("ライトアップ情報"), regular hours ("時間"),
  price ("料金"), official website link ("公式サイト"). The /light/ar0726/ list
  says which spots have a light-up.

Refreshed at most once per ~20 h (hours/prices rarely change). Light-up facts
are never inferred from past years: only 2026-dated text is accepted.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

from bs4 import BeautifulSoup

from .hours import nf, parse_period, parse_time_range, price_yen, reservation
from .util import clean, iso

SOUDA_LU = "https://souda-kyoto.jp/event/detail/lightup-autumn.html"
WALKER = "https://koyo.walkerplus.com"
LIGHT_LIST = WALKER + "/light/ar0726/"


def parse_souda_lightups(html: str, now) -> list[dict]:
    s = BeautifulSoup(html, "lxml")
    out = []
    as_of = None
    m = re.search(r"(20\d\d)年(\d{1,2})月時点", nf(s.get_text()))
    if m:
        as_of = f"{m.group(1)}-{int(m.group(2)):02d}"
    for h4 in s.select("h4.c-article__table-title"):
        name = clean(h4.get_text())
        box = h4.find_next_sibling("div")
        if not box:
            continue
        rows = {}
        for dl in box.select("dl"):
            dt, dd = dl.find("dt"), dl.find("dd")
            if dt and dd:
                rows[clean(dt.get_text())] = dd.get_text("\n", strip=True)
        sched = rows.get("日程", "")
        lines = [l for l in sched.split("\n") if l.strip()]
        period = parse_period(sched)
        times = parse_time_range("\n".join(lines[1:]) if len(lines) > 1 else sched)
        link = box.select_one("p.btn a[href*='spot/']")
        slug = link["href"].rstrip("/").split("/")[-1].replace(".html", "") if link else None
        body = box.select_one("p.body")
        out.append({
            "source": "souda", "source_url": SOUDA_LU, "as_of": as_of, "fetched_at": iso(now),
            "name_ja": name, "souda_slug": slug, "schedule_raw": nf(sched), "price_raw": nf(rows.get("料金", "")),
            "description": clean(body.get_text()) if body else None,
            **period, **{k: v for k, v in times.items() if k != "raw"},
            "price_yen": price_yen(rows.get("料金", "")),
            "reservation": reservation(sched + rows.get("料金", "") + (body.get_text() if body else "")),
        })
    return out


def _walker_table(html: str) -> dict:
    s = BeautifulSoup(html, "lxml")
    rows = {}
    for tr in s.select("table.s_table tr"):
        th, td = tr.find("th"), tr.find("td")
        if th and td:
            a = td.find("a", href=re.compile(r"^https?://"))
            rows[clean(th.get_text())] = {"text": nf(td.get_text(" ", strip=True)), "href": a["href"] if a else None}
    return rows


def _walker_lightup_block(html: str) -> str | None:
    s = BeautifulSoup(html, "lxml")
    for h in s.select("h4.textmore_title"):
        if "ライトアップ情報" in h.get_text():
            p = h.find_next("p")
            return nf(p.get_text(" ", strip=True)) if p else None
    return None


def collect_details(fetcher, now, walker_ids: dict[str, str], log=print) -> dict:
    """walker_ids: walker detail id -> place id. Returns {hours:{pid:...}, lightups_raw:[...]}"""
    res = {"fetched_at": iso(now), "hours": {}, "souda_lightups": [], "walker_lightups": [], "errors": []}
    try:
        res["souda_lightups"] = parse_souda_lightups(fetcher.get(SOUDA_LU), now)
        log(f"[ok] souda lightups: {len(res['souda_lightups'])}")
    except Exception as e:  # noqa: BLE001
        res["errors"].append(f"souda lightups: {e}")
    light_ids = set()
    try:
        first = fetcher.get(LIGHT_LIST)
        pages = [first]
        nums = sorted({int(x) for x in re.findall(r'href="/light/ar0726/(\d+)\.html"', first)})
        for p in range(2, (max(nums) if nums else 1) + 1):
            pages.append(fetcher.get(f"{LIGHT_LIST}{p}.html"))
        for h in pages:
            light_ids |= set(re.findall(r'href="/detail/(ar0726e\d+)/"', h))
        log(f"[ok] walker lightup list: {len(light_ids)}")
    except Exception as e:  # noqa: BLE001
        res["errors"].append(f"walker light list: {e}")
    for wid, pid in walker_ids.items():
        try:
            rows = _walker_table(fetcher.get(f"{WALKER}/detail/{wid}/data.html"))
        except Exception as e:  # noqa: BLE001
            res["errors"].append(f"{wid}: {e}")
            continue
        t = rows.get("時間", {}).get("text")
        res["hours"][pid] = {
            "source": "walkerplus", "source_url": f"{WALKER}/detail/{wid}/data.html", "fetched_at": iso(now),
            "hours_raw": t, **({k: v for k, v in parse_time_range(t).items() if k != "raw"} if t else {}),
            "price_raw": rows.get("料金", {}).get("text"), "price_yen": price_yen(rows.get("料金", {}).get("text", "")),
            "official_url": rows.get("公式サイト", {}).get("href"),
            "festival_raw": rows.get("紅葉祭り", {}).get("text"),
            "has_lightup": (rows.get("ライトアップ", {}).get("text", "").startswith("あり")) or wid in light_ids,
        }
        if wid in light_ids or res["hours"][pid]["has_lightup"]:
            try:
                block = _walker_lightup_block(fetcher.get(f"{WALKER}/detail/{wid}/"))
            except Exception as e:  # noqa: BLE001
                block = None
                res["errors"].append(f"{wid} main: {e}")
            text = block or ""
            fest = res["hours"][pid]["festival_raw"] or ""
            if "2026" not in text and "2026" in fest and re.search(r"\d{1,2}:\d{2}", fest):
                text = fest  # e.g. Umekoji: light-up is the 紅葉まつり evening event
            if "2026" in text:
                period = parse_period(text + "。" + (rows.get("例年の紅葉見頃", {}).get("text") or ""))
                times = parse_time_range(text)
                res["walker_lightups"].append({
                    "source": "walkerplus", "source_url": f"{WALKER}/detail/{wid}/", "fetched_at": iso(now),
                    "walker_id": wid, "place_id": pid, "schedule_raw": text[:300],
                    **period, **{k: v for k, v in times.items() if k != "raw"},
                    "price_raw": res["hours"][pid]["price_raw"], "official_url": res["hours"][pid]["official_url"],
                    "reservation": reservation(text),
                })
            elif text:
                res["walker_lightups"].append({"source": "walkerplus", "place_id": pid, "walker_id": wid,
                                               "schedule_raw": text[:300], "not_2026": True,
                                               "source_url": f"{WALKER}/detail/{wid}/"})
    log(f"[ok] details: hours {len(res['hours'])}, walker lightups {len(res['walker_lightups'])}, errors {len(res['errors'])}")
    return res


def needs_refresh(snapshot: dict | None, now, hours: float = 20) -> bool:
    if not snapshot or not snapshot.get("fetched_at"):
        return True
    try:
        t = datetime.fromisoformat(snapshot["fetched_at"])
    except ValueError:
        return True
    return (now - t).total_seconds() > hours * 3600
