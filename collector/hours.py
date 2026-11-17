"""Parsing of Japanese opening-hours / event-period strings.

Examples handled:
  "17：30～21：00（受付終了）"                  -> open 17:30, close 21:00, last entry 21:00
  "17：00（点灯）～22：00（受付終了21：30）"      -> 17:00, 22:00, last 21:30
  "日没～20：00（受付終了19：40）"               -> open at sunset, 20:00, last 19:40
  "入場時間9:00～17:00(最終入場16:30)"           -> 9:00, 17:00, last 16:30
  "2026年11月21日（土）～30日（月）"             -> 2026-11-21 .. 2026-11-30
  "2026年10月24日（土）～12月29日（火） ※12月16日（水）除く" -> except 2026-12-16
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date

T = r"(\d{1,2})\s*[:：]\s*(\d{2})"
DASH = r"\s*(?:[～〜~\-－–]|から)\s*"


def nf(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "")


def _hm(h, m):
    h, m = int(h), int(m)
    if not (0 <= h <= 29 and 0 <= m < 60):
        return None
    return f"{h}:{m:02d}"


JP_TIME = re.compile(r"(午前|午後)?\s*(\d{1,2})\s*時\s*(?:(\d{1,2})\s*分|半)?")


def _jp_times(s: str) -> str:
    """'午後5時半' -> '17:30', '17時30分' -> '17:30', '18時' -> '18:00'."""
    def rep(m):
        h = int(m.group(2)); mi = int(m.group(3)) if m.group(3) else (30 if m.group(0).endswith("半") else 0)
        if m.group(1) == "午後" and h < 12:
            h += 12
        return f"{h}:{mi:02d}"
    return JP_TIME.sub(rep, s)


def parse_time_range(text: str) -> dict:
    s = _jp_times(nf(text))
    out = {"raw": (text or "").strip()[:200]}
    sunset = re.search(r"(日没|日の入り|夕暮れ|夕刻|点灯時間?)\s*[～〜~\-－–]", s)
    m = re.search(T + r"[^0-9～〜~\-－–]{0,8}" + DASH + T, s)
    if m:
        out["open"] = _hm(m.group(1), m.group(2))
        out["close"] = _hm(m.group(3), m.group(4))
        tail = s[m.end(): m.end() + 30]
        if re.match(r"\s*[\(（]?\s*(受付終了|最終受付)\s*[\)）]", tail):
            out["last_entry"] = out["close"]
    elif sunset:
        m2 = re.search(r"(日没|日の入り|夕暮れ|夕刻)" + DASH + T, s)
        if m2:
            out["open"] = None
            out["open_note"] = "закат (~16:50)"
            out["open_sunset"] = True
            out["close"] = _hm(m2.group(2), m2.group(3))
    if sunset and not out.get("open"):
        out["open_sunset"] = True
        out.setdefault("open_note", "закат (~16:50)")
    le = re.search(r"(?:最終入場|最終入園|最終受付|受付終了|受付は?)\s*[:：]?\s*" + T, s) or \
        re.search(T + r"\s*(?:受付終了|最終受付|まで受付)", s)
    if le:
        out["last_entry"] = _hm(le.group(1), le.group(2))
    if out.get("close") and not out.get("last_entry"):
        out["last_entry_assumed"] = True
    return out


DATE_FULL = r"(20\d\d)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"


WEEKDAY = {"月": 0, "火": 1, "水": 2, "木": 3, "金": 4, "土": 5, "日": 6}
HOLIDAYS_2026 = ["2026-11-03", "2026-11-23"]  # 文化の日, 勤労感謝の日


def parse_period(text: str, default_year: int = 2026) -> dict:
    """First date range in text plus excluded days ('除く', '休園', '休み'),
    discrete dates ('14日(土)・15日(日)') and weekday limits ('金土日祝')."""
    s = nf(text)
    out = {}
    wd = re.search(r"(?:の|期間中の|毎週)([月火水木金土日]{2,7})(祝)?(?=\s*\d|のみ|に開催|開催|曜)", s)
    if wd and len(set(wd.group(1))) == len(wd.group(1)):
        out["weekdays"] = sorted(WEEKDAY[c] for c in wd.group(1))
        out["holidays_too"] = bool(wd.group(2))
    m = re.search(DATE_FULL + r"[^～〜~\-－–]{0,6}" + DASH + r"(?:(20\d\d)\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y2 = int(m.group(4)) if m.group(4) else y
        mo2 = int(m.group(5)) if m.group(5) else mo
        d2 = int(m.group(6))
        try:
            out["start"] = date(y, mo, d).isoformat()
            out["end"] = date(y2, mo2, d2).isoformat()
        except ValueError:
            pass
    if not m:
        # discrete dates: "2026年11月14日(土)・15日(日)、21日(土)・22日(日)・23日(祝)"
        dm = re.search(DATE_FULL, s)
        if dm:
            y, mo = int(dm.group(1)), int(dm.group(2))
            seg = s[dm.start(): dm.start() + 120]
            seg = re.split(r"[0-9]{1,2}\s*[:：]\s*[0-9]{2}|\(1\)|①", seg)[0]
            days = []
            for mm in re.finditer(r"(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日", seg[len(dm.group(0)) - len(dm.group(3)) - 1 - 0:]):
                if mm.group(1):
                    mo = int(mm.group(1))
                try:
                    days.append(date(y, mo, int(mm.group(2))).isoformat())
                except ValueError:
                    pass
            days = sorted(set(days))
            if days:
                out["dates"] = days
                out["start"], out["end"] = days[0], days[-1]
    year = int(out["start"][:4]) if out.get("start") else default_year
    exc = set()
    for seg in re.split(r"[。\n]", s):
        if not re.search(r"除く|休園|休み|休館|休止|中止", seg):
            continue
        for mm in re.finditer(r"(\d{1,2})\s*月\s*(\d{1,2})\s*日", seg):
            if m and seg.find(mm.group(0)) >= 0 and mm.start() < 0:
                continue
            try:
                exc.add(date(year, int(mm.group(1)), int(mm.group(2))).isoformat())
            except ValueError:
                pass
        # "16日(月)・24日(火)は休園" (day only, month from previous mention)
        last_month = None
        for mm in re.finditer(r"(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日", seg):
            if mm.group(1):
                last_month = int(mm.group(1))
            elif last_month:
                try:
                    exc.add(date(year, last_month, int(mm.group(2))).isoformat())
                except ValueError:
                    pass
    if out.get("start"):
        exc.discard(out["start"])
        exc.discard(out.get("end"))
    out["except"] = sorted(exc)
    return out


def price_yen(text: str):
    m = re.search(r"([\d,]{3,6})\s*円", nf(text or ""))
    if m:
        return int(m.group(1).replace(",", ""))
    if re.search(r"無料", text or ""):
        return 0
    return None


def reservation(text: str):
    s = nf(text or "")
    if re.search(r"予約不要|予約なし", s):
        return False
    if re.search(r"事前予約|予約制|要予約|完全予約|日時指定", s):
        return True
    return None
