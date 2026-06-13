#!/usr/bin/env python3
"""Scrape a timestamped odds snapshot for the web app.

Pulls the outright "Winner 2026" plus the per-stage "To Reach …" markets and
writes web/data/odds_latest.json, rotating the previous snapshot to
odds_prev.json so the frontend can diff the two for green/red movement arrows.

Reuses scrape_sportsbet_wc.py (event discovery + HTTP fetch + Markets API).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil

import scrape_sportsbet_wc as sb

DATA_DIR = os.environ.get("WC_DATA_DIR", "docs/data")
LATEST = os.path.join(DATA_DIR, "odds_latest.json")
PREV = os.path.join(DATA_DIR, "odds_prev.json")
FIXTURES = os.path.join(DATA_DIR, "fixtures.json")
HISTORY = os.path.join(DATA_DIR, "odds_history.json")

# committed seed (Mac-era real snapshots) used to backfill a fresh Pi history
REPO_DIR = os.path.dirname(os.path.abspath(__file__))
SEED_HISTORY = os.path.join(REPO_DIR, "docs", "data", "odds_history.json")
HISTORY_RETAIN_DAYS = 45      # keep the whole tournament so drift stays visible
HISTORY_BUCKET_SECS = 3600    # downsample to ~1 odds point per hour (bounds size)

# Men's World Cup competition (for the fixtures list with kickoff times)
COMP_ID = 23109
COMP_EVENTS_API = f"{sb.BASE}/apigw/sportsbook-sports/Sportsbook/Sports/Competitions/{COMP_ID}/Events"
FIX_NAME_MAP = {"Bosnia and Herzegovina": "Bosnia & Herzegovina"}

# Sportsbet market name -> snapshot key
MARKETS = {
    "Winner 2026": "winner",
    "To Reach Final": "reach_final",
    "To Reach Semi-Final": "reach_sf",
    "To Reach Quarter-Final": "reach_qf",
}


def write_fixtures():
    """Fetch the match list (teams + kickoff times) -> web/data/fixtures.json."""
    try:
        events = sb.fetch(COMP_EVENTS_API, as_json=True)
    except Exception as exc:  # noqa: BLE001
        print(f"! Fixtures fetch failed ({exc}); leaving fixtures.json as-is.")
        return
    fixtures = []
    for e in events:
        a, b, ts = e.get("participant1"), e.get("participant2"), e.get("startTime")
        if a and b and ts:
            fixtures.append({"ts": ts, "a": FIX_NAME_MAP.get(a, a), "b": FIX_NAME_MAP.get(b, b)})
    fixtures.sort(key=lambda x: x["ts"])
    with open(FIXTURES, "w") as f:
        json.dump(fixtures, f, ensure_ascii=False)
    print(f"Wrote {FIXTURES} — {len(fixtures)} fixtures.")


def downsample(hist, now):
    """Keep at most one (the latest) odds point per hour and drop anything older
    than the retention window. Bounds the file while leaving plenty of resolution
    for the frontend's 24h-ago baseline, and banks drift across the tournament."""
    cutoff = now - HISTORY_RETAIN_DAYS * 86400
    buckets = {}
    for h in sorted(hist, key=lambda x: x.get("ts", 0)):
        ts = h.get("ts", 0)
        if ts >= cutoff and h.get("winner"):
            buckets[ts // HISTORY_BUCKET_SECS] = h   # later ts in a bucket wins
    return [buckets[k] for k in sorted(buckets)]


def main():
    event_id = sb.discover_event_id()
    markets = sb.fetch(sb.MARKETS_API.format(event_id=event_id), as_json=True)
    if not isinstance(markets, list):
        raise SystemExit(f"Unexpected API response: {str(markets)[:200]}")

    by_name = {m.get("name"): m for m in markets}
    snapshot = {
        "timestamp": int(dt.datetime.now().timestamp()),
        "iso_time": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "event_id": event_id,
    }
    for market_name, key in MARKETS.items():
        prices = {}
        for sel in by_name.get(market_name, {}).get("selections", []):
            price = (sel.get("price") or {}).get("winPrice")
            if price:
                prices[sel["name"]] = price
        snapshot[key] = prices

    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(LATEST):
        shutil.copyfile(LATEST, PREV)
    with open(LATEST, "w") as f:
        json.dump(snapshot, f, ensure_ascii=False)

    # rolling history of winner odds, so the frontend can show 24h movement
    try:
        with open(HISTORY) as f:
            hist = json.load(f)
    except Exception:
        hist = []
    # while the live history is still thin (e.g. just after the Pi came online),
    # backfill from the committed Mac-era seed so the 24h baseline works from day
    # one. Self-limiting: stops once the Pi has ~a day of its own snapshots.
    span_h = (hist[-1]["ts"] - hist[0]["ts"]) / 3600 if hist else 0
    if span_h < 24 and os.path.abspath(SEED_HISTORY) != os.path.abspath(HISTORY):
        try:
            with open(SEED_HISTORY) as f:
                hist = json.load(f) + hist
        except Exception:
            pass
    hist.append({"ts": snapshot["timestamp"], "winner": snapshot["winner"]})
    hist = downsample(hist, snapshot["timestamp"])
    with open(HISTORY, "w") as f:
        json.dump(hist, f, ensure_ascii=False)

    n = len(snapshot["winner"])
    print(f"Wrote {LATEST} @ {snapshot['iso_time']} — {n} teams priced "
          f"(reach_final={len(snapshot['reach_final'])}, "
          f"reach_sf={len(snapshot['reach_sf'])}, reach_qf={len(snapshot['reach_qf'])})")
    if os.path.exists(PREV):
        print(f"Rotated previous snapshot -> {PREV}")

    write_fixtures()


if __name__ == "__main__":
    main()
