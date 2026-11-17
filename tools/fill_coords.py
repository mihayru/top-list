"""One-off helper: fill missing coordinates in data/places.json from source pages.

Only coordinates published by a source are used (never guessed):
  * Walkerplus map page  /detail/<id>/map.html
  * Japan Explorers spot page JSON-LD (latitude/longitude)
The source is recorded in `coord_source`. Run: python -m tools.fill_coords
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from collector.http import Fetcher

ROOT = Path(__file__).resolve().parents[1]
PLACES = ROOT / "data" / "places.json"
SNAP = ROOT / "data" / "snapshots"


def main():
    doc = json.loads(PLACES.read_text(encoding="utf-8"))
    je = {o["source_key"]: o["url"] for o in json.loads((SNAP / "japan_explorers.json").read_text())["observations"]}
    have = set()
    for src in ("jr_odekake", "weathernews"):
        for o in json.loads((SNAP / f"{src}.json").read_text())["observations"]:
            if o.get("lat") is not None:
                have.add((src, o["source_key"]))
    f = Fetcher()
    for p in doc["places"]:
        if p.get("lat") is not None:
            continue
        m = p.get("match", {})
        if any((s, k) in have for s in ("jr_odekake", "weathernews") for k in m.get(s, [])):
            continue
        got = None
        for wid in m.get("walkerplus", []):
            try:
                html = f.get(f"https://koyo.walkerplus.com/detail/{wid}/map.html")
                mm = re.search(r"(3[3-6]\.\d{4,})\s*,\s*(13[4-6]\.\d{4,})", html)
                if mm:
                    got = (float(mm.group(1)), float(mm.group(2)), "walkerplus_map")
            except Exception as e:  # noqa: BLE001
                print("walker fail", p["id"], e, file=sys.stderr)
        if not got:
            for name in m.get("japan_explorers", []):
                url = je.get(name)
                if not url:
                    continue
                try:
                    html = f.get(url)
                    la = re.search(r'"latitude"\s*:\s*"?(3[3-6]\.\d+)', html)
                    lo = re.search(r'"longitude"\s*:\s*"?(13[4-6]\.\d+)', html)
                    if la and lo:
                        got = (float(la.group(1)), float(lo.group(1)), "japan_explorers_spot_page")
                except Exception as e:  # noqa: BLE001
                    print("je fail", p["id"], e, file=sys.stderr)
        if got:
            p["lat"], p["lon"], p["coord_source"] = round(got[0], 6), round(got[1], 6), got[2]
            print("ok", p["id"], got)
        else:
            print("none", p["id"])
    PLACES.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
