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
OUT = os.path.join(os.environ.get("WC_DATA_DIR", "docs/data"), "results.json")

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


def minute_of(clock):
    """ESPN clock to a comparable minute: "9'" -> 9, "90'+4'" -> 90, junk -> 999."""
    try:
        return int(str(clock).split("'")[0].strip())
    except (ValueError, AttributeError):
        return 999


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
    # ITP "Duff Pool" prize stats, aggregated over all played matches (see app.js)
    red, yellow, conceded, scored = {}, {}, {}, {}
    fastest = None    # {team, minute, clock, player}
    first_og = None   # {team, minute, clock, player, matchTs, against}
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
        a, b = norm(home["team"]["displayName"]), norm(away["team"]["displayName"])
        mts = to_ts(ev.get("date", ""))
        # advancing team (handles penalty shootouts) via ESPN's per-competitor winner flag
        win = a if home.get("winner") else (b if away.get("winner") else None)
        matches.append({
            "ts": mts, "a": a, "b": b, "sa": sa, "sb": sbs,
            "state": state,
            "completed": bool(ev.get("status", {}).get("type", {}).get("completed")),
            "w": win,
        })

        # ---- Duff Pool aggregation (played matches only) ----
        if state == "pre":
            continue
        scored[a] = scored.get(a, 0) + sa
        conceded[a] = conceded.get(a, 0) + sbs
        scored[b] = scored.get(b, 0) + sbs
        conceded[b] = conceded.get(b, 0) + sa
        idname = {c["team"]["id"]: norm(c["team"]["displayName"]) for c in cs if c.get("team")}
        for p in comp.get("details") or []:
            tname = idname.get((p.get("team") or {}).get("id"))
            if not tname:
                continue
            clk = (p.get("clock") or {}).get("displayValue")
            mn = minute_of(clk)
            player = (p.get("athletesInvolved") or [{}])[0].get("displayName")
            if p.get("redCard"):
                red[tname] = red.get(tname, 0) + 1
            if p.get("yellowCard"):
                yellow[tname] = yellow.get(tname, 0) + 1
            if p.get("ownGoal"):
                # ESPN's `team` on an own goal is the beneficiary; the team that
                # committed it is the opponent (the athlete's side).
                culprit = b if tname == a else (a if tname == b else None)
                if culprit and (first_og is None or (mts, mn) < (first_og["matchTs"], first_og["minute"])):
                    first_og = {"team": culprit, "minute": mn, "clock": clk,
                                "player": player, "matchTs": mts, "against": tname}
            elif p.get("scoringPlay"):
                if fastest is None or mn < fastest["minute"]:
                    fastest = {"team": tname, "minute": mn, "clock": clk, "player": player}

    # rolling ~30h history of each team's within-group rank, so the frontend can
    # show 24h ladder movement (ESPN's own rankChange is always 0 for this comp)
    nowts = int(dt.datetime.now().timestamp())
    ranks = {r["team"]: r["rank"] for g in groups.values() for r in g}
    try:
        with open(OUT) as f:
            hist = json.load(f).get("rankHistory", [])
    except Exception:
        hist = []
    hist.append({"ts": nowts, "ranks": ranks})
    hist = [h for h in hist if h.get("ts", 0) >= nowts - 30 * 3600]

    prize_stats = {
        "redCards": red, "yellowCards": yellow, "conceded": conceded, "scored": scored,
        "fastestGoal": fastest, "firstOwnGoal": first_og,
    }
    data = {"updated": nowts, "groups": groups, "matches": matches,
            "rankHistory": hist, "prizeStats": prize_stats}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    played = sum(1 for m in matches if m["state"] != "pre")
    print(f"Wrote {OUT}: {len(groups)} groups, {len(matches)} matches ({played} live/played).")


if __name__ == "__main__":
    main()
