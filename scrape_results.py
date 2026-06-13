#!/usr/bin/env python3
"""Scrape live 2026 World Cup results + standings from ESPN's public API.

ESPN (unlike Sportsbet) doesn't block cloud IPs, and it carries group tables,
match scores/state, and qualification notes. Writes docs/data/results.json:

    {
      "updated": <unix>,
      "groups": { "A": [ {team,rank,P,W,D,L,GF,GA,GD,Pts,out,note}, ... ], ... },
      "matches": [ {ts,a,b,sa,sb,state,completed}, ... ]
    }

Team names are normalised to the canonical spellings used in tournament.json.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import urllib.request

STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings"
SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260601-20260720"
OUT = "docs/data/results.json"

NAME = {  # ESPN spelling -> canonical (tournament.json) spelling
    "Bosnia-Herzegovina": "Bosnia & Herzegovina",
    "Congo DR": "DR Congo",
    "Curaçao": "Curacao",
    "United States": "USA",
}


def norm(n):
    return NAME.get(n, n)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def stat(entry, name, default=0):
    for s in entry.get("stats", []):
        if s.get("name") == name:
            v = s.get("value")
            return v if v is not None else default
    return default


def to_ts(iso):
    for fmt in ("%Y-%m-%dT%H:%M%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return int(dt.datetime.strptime(iso.replace("Z", "+0000"), fmt).timestamp())
        except ValueError:
            continue
    return 0


def main():
    groups = {}
    st = fetch(STANDINGS)
    for g in st.get("children", []):
        letter = g.get("name", "").replace("Group ", "").strip()
        rows = []
        for e in g.get("standings", {}).get("entries", []):
            P = int(stat(e, "gamesPlayed"))
            rank = int(stat(e, "rank", 0))
            rows.append({
                "team": norm(e["team"]["displayName"]),
                "rank": rank,
                "P": P,
                "W": int(stat(e, "wins")),
                "D": int(stat(e, "ties")),
                "L": int(stat(e, "losses")),
                "GF": int(stat(e, "pointsFor")),
                "GA": int(stat(e, "pointsAgainst")),
                "GD": int(stat(e, "pointDifferential")),
                "Pts": int(stat(e, "points")),
                # only a confirmed elimination: finished last after all 3 group games
                # (4th never advances; 3rd is ambiguous via best-thirds, so leave it)
                "out": P >= 3 and rank >= 4,
            })
        rows.sort(key=lambda r: r["rank"] or 99)
        if letter:
            groups[letter] = rows

    matches = []
    sb = fetch(SCOREBOARD)
    for ev in sb.get("events", []):
        comp = (ev.get("competitions") or [{}])[0]
        cs = comp.get("competitors", [])
        home = next((c for c in cs if c.get("homeAway") == "home"), None)
        away = next((c for c in cs if c.get("homeAway") == "away"), None)
        if not home or not away:
            continue
        state = ev.get("status", {}).get("type", {}).get("state", "pre")
        try:
            sa, sbs = int(home.get("score") or 0), int(away.get("score") or 0)
        except ValueError:
            sa, sbs = 0, 0
        # advancing team (handles penalty shootouts) via ESPN's per-competitor winner flag
        win = None
        if home.get("winner"):
            win = norm(home["team"]["displayName"])
        elif away.get("winner"):
            win = norm(away["team"]["displayName"])
        matches.append({
            "ts": to_ts(ev.get("date", "")),
            "a": norm(home["team"]["displayName"]),
            "b": norm(away["team"]["displayName"]),
            "sa": sa, "sb": sbs,
            "state": state,
            "completed": bool(ev.get("status", {}).get("type", {}).get("completed")),
            "w": win,
        })

    data = {"updated": int(dt.datetime.now().timestamp()), "groups": groups, "matches": matches}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    played = sum(1 for m in matches if m["state"] != "pre")
    print(f"Wrote {OUT}: {len(groups)} groups, {len(matches)} matches ({played} live/played).")


if __name__ == "__main__":
    main()
