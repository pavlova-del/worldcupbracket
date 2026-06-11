#!/usr/bin/env python3
"""Scrape World Cup outright (winner) odds from Sportsbet.

Sportsbet renders odds client-side, but the underlying data is served as JSON
from its public sportsbook API. This script:

  1. Discovers the "World Cup Outrights" event id from the landing page
     (falls back to a known id if discovery fails).
  2. Fetches all markets for that event.
  3. Extracts the outright "Winner" market and writes a tidy CSV plus the
     raw markets JSON for reference.

Stdlib only — no third-party packages required.

Usage:
    python3 scrape_sportsbet_wc.py
    python3 scrape_sportsbet_wc.py --event-id 7009197
    python3 scrape_sportsbet_wc.py --market "Golden Boot Winner"
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import math
import re
import sys
import urllib.request
import urllib.error

BASE = "https://www.sportsbet.com.au"
LANDING_PAGE = f"{BASE}/betting/soccer/world-cup"
MARKETS_API = f"{BASE}/apigw/sportsbook-sports/Sportsbook/Sports/Events/{{event_id}}/Markets"

# Fallback if dynamic discovery fails (the 2026 World Cup outrights event).
FALLBACK_EVENT_ID = 7009197

# Pattern like ".../world-cup-2026-outrights-7009197"
OUTRIGHT_ID_RE = re.compile(r"world-cup[a-z0-9-]*outrights?-(\d+)", re.I)

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


def fetch(url: str, *, as_json: bool) -> str | dict | list:
    """GET a URL with browser-ish headers, transparently handling gzip."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
            "Accept-Encoding": "gzip",
            "Accept-Language": "en-AU,en;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    text = raw.decode("utf-8", errors="replace")
    return json.loads(text) if as_json else text


def discover_event_id() -> int:
    """Find the outright event id from the landing page, or fall back."""
    try:
        html = fetch(LANDING_PAGE, as_json=False)
        match = OUTRIGHT_ID_RE.search(html)
        if match:
            return int(match.group(1))
        print("  ! Could not find outright id on page; using fallback.", file=sys.stderr)
    except urllib.error.URLError as exc:
        print(f"  ! Landing page fetch failed ({exc}); using fallback.", file=sys.stderr)
    return FALLBACK_EVENT_ID


def fractional(num: int | None, den: int | None) -> str:
    """Reduce Sportsbet's *1000-scaled fractional odds to e.g. '9/2'."""
    if not num or not den:
        return "-"
    g = math.gcd(num, den)
    return f"{num // g}/{den // g}"


def extract_market(markets: list, market_name: str) -> dict:
    """Return the named market (case-insensitive), or raise with options."""
    for m in markets:
        if m.get("name", "").lower() == market_name.lower():
            return m
    names = ", ".join(repr(m.get("name")) for m in markets)
    raise SystemExit(f"Market {market_name!r} not found. Available markets: {names}")


def build_rows(market: dict) -> list[dict]:
    rows = []
    for sel in market.get("selections", []):
        price = sel.get("price") or {}
        dec = price.get("winPrice")
        rows.append(
            {
                "selection": sel.get("name"),
                "decimal_odds": dec,
                "fractional_odds": fractional(price.get("winPriceNum"), price.get("winPriceDen")),
                "implied_prob_pct": round(100 / dec, 2) if dec else None,
                "status": sel.get("statusCode"),
            }
        )
    # Sort by best (lowest decimal) odds first; suspended/None last.
    rows.sort(key=lambda r: (r["decimal_odds"] is None, r["decimal_odds"] or math.inf))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event-id", type=int, help="Outright event id (skips discovery).")
    ap.add_argument("--market", default="Winner 2026", help="Market name to extract (default: 'Winner 2026').")
    ap.add_argument("--csv", default="world_cup_outright_odds.csv", help="Output CSV path.")
    ap.add_argument("--raw", default="sportsbet_markets_raw.json", help="Where to dump raw markets JSON.")
    ap.add_argument("--top", type=int, default=20, help="How many rows to print to console.")
    args = ap.parse_args()

    event_id = args.event_id or discover_event_id()
    print(f"Event id: {event_id}")

    url = MARKETS_API.format(event_id=event_id)
    print(f"Fetching: {url}")
    markets = fetch(url, as_json=True)
    if not isinstance(markets, list):
        raise SystemExit(f"Unexpected API response: {str(markets)[:200]}")

    with open(args.raw, "w") as fh:
        json.dump(markets, fh)
    print(f"Saved raw markets -> {args.raw} ({len(markets)} markets)")

    market = extract_market(markets, args.market)
    rows = build_rows(market)

    fieldnames = ["selection", "decimal_odds", "fractional_odds", "implied_prob_pct", "status"]
    with open(args.csv, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Saved odds   -> {args.csv} ({len(rows)} selections)")

    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"\n{market.get('name')}  (scraped {stamp})")
    print(f"{'#':>2}  {'Selection':<24}{'Dec':>7}{'Frac':>8}{'Prob%':>8}  St")
    print("-" * 56)
    for i, r in enumerate(rows[: args.top], 1):
        dec = r["decimal_odds"]
        prob = r["implied_prob_pct"]
        print(
            f"{i:>2}  {str(r['selection']):<24}"
            f"{(dec if dec is not None else '-'):>7}"
            f"{r['fractional_odds']:>8}"
            f"{(prob if prob is not None else '-'):>8}  {r['status']}"
        )
    if len(rows) > args.top:
        print(f"... and {len(rows) - args.top} more (see {args.csv})")


if __name__ == "__main__":
    main()
