"""Parser + engine tests against real pages saved on 2026-11-17."""
import json
from datetime import date, datetime
from pathlib import Path

from collector.adapters.japan_explorers import JapanExplorers
from collector.adapters.jr_odekake import JROdekake, extract_percent
from collector.adapters.souda import Souda
from collector.adapters.walkerplus import Walkerplus
from collector.adapters.weathernews import Weathernews
from collector.http import Robots
from collector.merge import assess
from collector.places import Registry
from collector.util import JST

F = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 11, 17, 12, 0, tzinfo=JST)
TODAY = NOW.date()


def read(n):
    return (F / n).read_text(encoding="utf-8")


def test_souda_photo_dates():
    obs = Souda().parse(read("souda_modal.json"), NOW)
    assert len(obs) == 77
    toji = next(o for o in obs if o.source_key == "toji")
    assert toji.status_original == "色づきはじめ" and toji.status == "STARTING"
    assert toji.observed_at == "2026-11-16" and toji.data_type == "photo"
    assert all(p["date"] for p in toji.photos)


def test_jr_rows_coords_and_percent():
    obs = JROdekake().parse(read("jr_kyoto_ja.html"), read("jr_kyoto_en.html"), NOW)
    assert len(obs) == 53
    j = next(o for o in obs if o.name_ja == "高雄山神護寺")
    assert j.status == "PEAK" and j.observed_at == "2026-11-17" and j.lat and j.lon
    assert j.name_en == "Kyoto Takaosan Jingoji"
    z = next(o for o in obs if o.name_ja == "隨心院")
    assert z.percent == 40


def test_percent_extraction_is_strict():
    assert extract_percent("4割ほど") == 40
    assert extract_percent("色づきが5～6割程度進んできました") == 55
    assert extract_percent("カエデは五分程度(一部見頃)") == 50
    assert extract_percent("一部見頃です") is None
    assert extract_percent("12月初旬まで見頃の見込み") is None


def test_weathernews_nuxt():
    obs = Weathernews().parse(read("weathernews_kyoto.html"), NOW)
    assert len(obs) == 95
    a = next(o for o in obs if o.source_key == "26101")
    assert a.name_ja == "嵐山" and a.status == "PEAK" and a.observed_at == "2026-11-14"
    assert a.extra["peak_began"] == "2026-11-14"


def test_japan_explorers_percent_is_not_redness():
    obs = JapanExplorers().parse(read("japan_explorers_kyoto.html"), NOW)
    assert len(obs) == 69
    s = next(o for o in obs if o.name_ja == "三千院")
    assert s.percent == 87 and "НЕ доля" in s.percent_meaning
    assert s.data_type == "model" and s.observed_at is None
    t = next(o for o in obs if o.name_ja == "天龍寺")
    assert t.data_type == "news" and t.observed_at == "2026-11-14"


def test_walkerplus_marked_derived():
    obs = Walkerplus().parse(read("walkerplus_list_p1.html"), NOW)
    assert obs and all(o.data_type == "derived" and o.derived_from == "jr_odekake" for o in obs)


def test_robots_longest_match():
    r = Robots("User-Agent:*\nDisallow:/\nAllow: /result/\n")
    assert r.allowed("KoyoRadar", "/result/MMJ/A1005?lang=ja")
    assert not r.allowed("KoyoRadar", "/MMJ/legend")


def test_registry_strict_and_unique():
    reg = Registry()
    assert reg.match("jr_odekake", "正法寺") == "shohoji_wazuka"
    assert reg.match("walkerplus", "ar0726e366296") == "shohoji_oharano"
    assert reg.match("japan_explorers", "光明寺") == "komyoji"
    assert reg.match("japan_explorers", "瑠璃光院") == "rurikoin"
    assert reg.match("souda", "unknown-temple") is None
    for alias in ("Jingoji", "Jingō-ji", "神護寺"):
        assert reg.match("manual", "x", manual_place=alias) == "jingoji"


def _o(src, status, lo, hi, typ, obs):
    return {"source": src, "status": status, "stage_lo": lo, "stage_hi": hi, "data_type": typ,
            "observed_at": obs, "fetched_at": "2026-11-17T12:00:00+09:00"}


def test_conflict_and_confirmation():
    ind = {"souda", "jr_odekake", "weathernews"}
    a = assess([_o("souda", "PEAK", 4, 4, "photo", "2026-11-16"),
                _o("weathernews", "STARTING", 1, 1, "field_report", "2026-11-16")], TODAY, ind)
    assert a["status"] == "CONFLICT"
    b = assess([_o("souda", "PEAK", 4, 4, "photo", "2026-11-16"),
                _o("jr_odekake", "PEAK", 3, 4, "official_report", "2026-11-17")], TODAY, ind)
    assert b["status"] == "PEAK" and b["verification"] == "confirmed"
    # old observation + fresh one two stages later is NOT a conflict (leaves progressed)
    c = assess([_o("souda", "STARTING", 1, 2, "photo", "2026-11-09"),
                _o("jr_odekake", "PEAK", 3, 4, "official_report", "2026-11-17")], TODAY, ind)
    assert c["status"] != "CONFLICT"
    m = assess([_o("japan_explorers", "PEAK", 3, 4, "model", None)], TODAY, ind)
    assert m["verification"] == "model"
