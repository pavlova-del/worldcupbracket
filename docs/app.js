"use strict";

const REFRESH_MS = 60000;
const FLAG = iso => `https://flagcdn.com/w40/${iso}.png`;
// Live data is served by the Raspberry Pi (always-on, home AU IP). Set DATA_API
// to the Pi's public URL to read live; empty = use the committed Pages snapshot.
const DATA_API = "https://vulcan.tailee0fb5.ts.net";
const DYNAMIC = new Set(["odds_latest.json", "odds_prev.json", "odds_history.json", "fixtures.json", "results.json", "news.json"]);
let piLive = false;   // did the dynamic data load from the Pi this refresh?
// the Pi scrapes every ~60s; if the latest snapshot is older than this the data
// is being served but not refreshing (e.g. Sportsbet started blocking) — flag it.
const STALE_SECS = 360;
let ageOverride = null;   // ?age=<secs> preview hook for the freshness footer

// bracket geometry (px)
const H = 64, HEADER_H = 28, MATCHW = 188, HGAP = 40, COLW = MATCHW + HGAP;
const ROUND_COL = { R32: 0, R16: 1, QF: 2, SF: 3, Final: 4 };

let T = null;
let latest = null, prev = null;
let history = [];                         // [{ts, winner:{team:odds}}] hourly
let probSeries = {}, slipSeries = {};     // team/owner -> [{ts, v:prob}] over history
let probLatest = {}, probPrev = {};
let selectedOwners = new Set();
let view = "groups";
let oddsTab = "teams";
let moversTab = "teams";   // Teams / Player slips sub-toggle within the Movers tab
let schedMode = "fixtures";
let nextRefreshAt = 0;
let shownTeam = {}, shownPlayer = {};   // last-rendered values, to flash on change
let fixtures = [];
let results = null, standing = {}, matchScore = {};   // committed ESPN standings + scores
let news = null;                                       // {generatedAt, items:[{title,source,url,ts,team}]}
let liveScores = {};                                   // live overlay fetched client-side
const pairKey = (a, b) => [a, b].sort().join("|");
const getMatch = (a, b) => liveScores[pairKey(a, b)] || matchScore[pairKey(a, b)];
const ESPN_SB = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const ESPN_NAME = { "Bosnia-Herzegovina": "Bosnia & Herzegovina", "Congo DR": "DR Congo", "Curaçao": "Curacao", "United States": "USA" };
const espnNorm = n => ESPN_NAME[n] || n;

// live scores straight from ESPN (CORS-enabled) every 60s — no push/deploy lag.
// ESPN's default scoreboard only returns one matchday (often yesterday's finished
// games), so query an explicit window (yesterday → tomorrow) to always catch the
// current/live match.
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
let seenEvents = null;   // Set of detail keys already shown (null until first fetch)

function classifyEvent(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("red card") || t.includes("second yellow") || t.includes("yellow red")) return "red";
  if (t.includes("yellow card")) return "yellow";
  if (t.includes("goal") || t.includes("penalty - scored")) return "goal";
  return null;
}

let evtQueue = [], evtBusy = false;
function fireEvent(ev) { evtQueue.push(ev); if (!evtBusy) playNextEvent(); }
function playNextEvent(hold) {
  if (!hold && !evtQueue.length) { evtBusy = false; return; }
  evtBusy = true;
  const ev = hold || evtQueue.shift();
  const owner = T.teams[ev.team] ? T.teams[ev.team].owner : null;
  const ownerColor = owner ? T.owners[owner].color : "#888";
  const ov = el("div", "evt-ov" + (ev._hold ? " hold" : ""));
  const card = el("div", "evt-card");
  const flag = T.teams[ev.team] ? `<img src="${FLAG(T.teams[ev.team].iso)}" alt="">` : "";
  if (ev.type === "goal") {
    card.innerHTML = `<div class="evt-big">GOAL!</div>` +
      `<div class="evt-team">${flag}<span>${ev.team}</span> <span class="evt-score">${ev.score || ""}</span></div>` +
      (owner ? `<div class="evt-owner"><span class="dot" style="background:${ownerColor}"></span>${owner}'s team</div>` : "") +
      (ev.player ? `<div class="evt-sub">⚽ ${ev.player}</div>` : "");
    spawnConfetti(card, ownerColor, ev._hold);
  } else {
    const red = ev.type === "red";
    card.innerHTML = `<div class="evt-cardicon ${ev.type}"></div>` +
      `<div class="evt-big" style="color:${red ? "var(--down)" : "var(--gold)"}">${red ? "RED" : "YELLOW"} CARD</div>` +
      `<div class="evt-team">${flag}<span>${ev.team}</span></div>` +
      (ev.player ? `<div class="evt-sub">${ev.player}</div>` : "");
  }
  ov.appendChild(card);
  document.body.appendChild(ov);
  if (ev._hold) return;                          // demo: leave it on screen
  setTimeout(() => { ov.remove(); playNextEvent(); }, 4200);
}
function spawnConfetti(container, color, hold) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cols = [color || "#ffd24a", "#ffffff", "#5fcf8f", "#ffd24a"];
  for (let i = 0; i < 26; i++) {
    const p = el("div", "evt-confetti");
    const ang = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 240;
    p.style.setProperty("--tx", (Math.cos(ang) * dist).toFixed(0) + "px");
    p.style.setProperty("--ty", (Math.sin(ang) * dist * 0.6 + 120).toFixed(0) + "px");
    p.style.setProperty("--rot", (Math.random() * 720 - 360) + "deg");
    p.style.background = cols[i % cols.length];
    if (hold) { p.style.animationDelay = "-0.7s"; p.style.animationPlayState = "paused"; }
    else p.style.animationDelay = (Math.random() * 0.15) + "s";
    container.appendChild(p);
  }
}
// poll faster while a match is live so goals/cards feel immediate
function scheduleLive() {
  const live = Object.values(liveScores).some(m => m.state === "in");
  setTimeout(async () => { await fetchLive(); scheduleLive(); }, live ? 20000 : 60000);
}
// demo: ?demo=goal|yellow|red (or ?demo=all) loops the real animation for preview
function demoEvent(kind) {
  const samples = {
    goal: { type: "goal", team: "Spain", player: "Lamine Yamal", score: "2–1" },
    yellow: { type: "yellow", team: "Argentina", player: "Rodrigo De Paul" },
    red: { type: "red", team: "Brazil", player: "Casemiro" },
  };
  const seq = kind === "all" ? ["goal", "yellow", "red"] : [kind];
  if (!samples[seq[0]]) return;
  let i = 0;
  const loop = () => { fireEvent({ ...samples[seq[i % seq.length]] }); i++; };
  loop(); setInterval(loop, 3300);
}
async function fetchLive() {
  try {
    const now = Date.now();
    const url = `${ESPN_SB}?dates=${ymd(new Date(now - 36e5 * 36))}-${ymd(new Date(now + 36e5 * 24))}&t=${now}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    const next = {}, curSeen = new Set(), fresh = [];
    (d.events || []).forEach(ev => {
      const c = (ev.competitions || [])[0]; if (!c) return;
      const cs = c.competitors || [];
      const home = cs.find(x => x.homeAway === "home"), away = cs.find(x => x.homeAway === "away");
      if (!home || !away) return;
      const a = espnNorm(home.team.displayName), b = espnNorm(away.team.displayName);
      const w = home.winner ? a : (away.winner ? b : null);   // advancing team (incl. penalties)
      const state = ev.status?.type?.state || "pre";
      const sa = parseInt(home.score) || 0, sb = parseInt(away.score) || 0;
      next[pairKey(a, b)] = { a, b, sa, sb, state, w };
      // detect goal/card events from the play-by-play details
      const byId = {}; cs.forEach(x => byId[x.id] = espnNorm(x.team.displayName));
      (c.details || []).forEach((p, i) => {
        const type = classifyEvent(p.type && p.type.text);
        if (!type) return;
        const team = byId[p.team && p.team.id] || a;
        const player = ((p.athletesInvolved || [])[0] || {}).displayName || "";
        const clock = (p.clock || {}).displayValue || "";
        const key = (p.id ? "p" + p.id : `${a}|${b}|${clock}|${p.type.text}|${player}|${i}`);
        curSeen.add(key);
        if (seenEvents && !seenEvents.has(key) && state !== "pre" && T && T.teams[team])
          fresh.push({ type, team, player, score: `${sa}–${sb}` });
      });
    });
    liveScores = next;
    const first = seenEvents === null;
    seenEvents = curSeen;
    if (!first) fresh.forEach(fireEvent);
    if (T) { renderNextMatch(); renderSchedule(); }
  } catch (e) { /* offline / ESPN hiccup — keep last known */ }
}
let seed = {};                          // team -> overall seed (1 = strongest by odds)
const AEST = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

async function getJSON(path) {
  const name = path.split("/").pop();
  // dynamic data → try the Pi's live API first, fall back to the Pages snapshot
  if (DATA_API && DYNAMIC.has(name)) {
    try {
      const r = await fetch(`${DATA_API}/data/${name}?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) { const j = await r.json(); piLive = true; return j; }
    } catch (e) { /* Pi unreachable — fall back below */ }
    piLive = false;
  }
  const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function fairProbs(winnerOdds) {
  if (!winnerOdds) return {};
  let z = 0; for (const t in winnerOdds) z += 1 / winnerOdds[t];
  const p = {}; for (const t in winnerOdds) p[t] = (1 / winnerOdds[t]) / z;
  return p;
}

function arrow(d) {
  if (d > 0.05) return { cls: "up", txt: `▲${d.toFixed(1)}` };
  if (d < -0.05) return { cls: "down", txt: `▼${Math.abs(d).toFixed(1)}` };
  return { cls: "flat", txt: "·" };
}

// human "x ago" for the freshness footer
function ago(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

// turn the hourly odds_history into per-team and per-slip probability series,
// ending on the live snapshot so a sparkline runs right up to "now".
function buildSeries() {
  probSeries = {}; slipSeries = {};
  const pts = (history || []).filter(h => h && h.winner).map(h => ({ ts: h.ts, p: fairProbs(h.winner) }));
  if (latest && latest.winner && (!pts.length || pts[pts.length - 1].ts < latest.timestamp))
    pts.push({ ts: latest.timestamp, p: probLatest });
  if (pts.length < 2) return;
  const teams = new Set();
  pts.forEach(pt => Object.keys(pt.p).forEach(t => teams.add(t)));
  teams.forEach(t => probSeries[t] = pts.map(pt => ({ ts: pt.ts, v: pt.p[t] ?? 0 })));
  Object.keys(T.owners).forEach(o => {
    const ts = T.owners[o].teams;
    slipSeries[o] = pts.map(pt => ({ ts: pt.ts, v: ts.reduce((s, t) => s + (pt.p[t] ?? 0), 0) }));
  });
}

// tiny inline-SVG sparkline; auto-scales to the series' own min/max so flat-ish
// lines still show shape. Green if it ends higher than it started, else red.
function sparkline(series, opts) {
  if (!series || series.length < 2) return "";
  opts = opts || {};
  const w = opts.w || 46, h = opts.h || 14, pad = 1.6;
  const vs = series.map(p => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 1e-9) { lo -= 1e-6; hi += 1e-6; }
  const n = series.length;
  const X = i => pad + (w - 2 * pad) * (i / (n - 1));
  const Y = v => pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo));
  const d = series.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(" ");
  const up = vs[n - 1] >= vs[0];
  const col = up ? "var(--up)" : "var(--down)";
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${X(n - 1).toFixed(1)}" cy="${Y(vs[n - 1]).toFixed(1)}" r="1.6" fill="${col}"/></svg>`;
}

function teamMove(team) {
  if (probPrev[team] == null) return { cls: "flat", txt: "·" };
  return arrow(((probLatest[team] ?? 0) - probPrev[team]) * 100);
}
const pct = team => `${((probLatest[team] ?? 0) * 100).toFixed(1)}%`;
const owned = team => selectedOwners.size && T.teams[team] && selectedOwners.has(T.teams[team].owner) ? 1 : 0;
// out of contention = the bookie has dropped the team from the winner market
const isOut = team => Object.keys(probLatest).length > 0 && !(team in probLatest) && !!(T.teams && T.teams[team]);
const ownerDot = team => {
  const o = T.teams[team]?.owner;
  return { color: o ? T.owners[o].color : "#555", name: o || "—" };
};
const sumProb = (teams, map) => teams.reduce((s, t) => s + (map[t] ?? 0), 0);
const seedBadge = team => seed[team] ? `<span class="seed" title="Seed ${seed[team]} of 48">${seed[team]}</span>` : "";
// ladder-movement chip: ▲ up / ▼ down places (blank when unchanged)
const moveChip = d => d > 0 ? `<span class="mv up" title="up ${d}">▲${d}</span>`
  : d < 0 ? `<span class="mv down" title="down ${-d}">▼${-d}</span>` : "";
/* ---------- standings + knockout projection ---------- */
// Groups tab orders by odds (the draw view). Real standings live in the Table tab.
function standings(letter) {
  return [...T.groups[letter]].sort((a, b) => (probLatest[b] ?? 0) - (probLatest[a] ?? 0));
}

/* ---------- owner filter ---------- */
function renderOwners() {
  const bar = $("#ownerbar"); bar.innerHTML = "";
  const reset = el("span", "chip reset" + (selectedOwners.size ? "" : " active"), "All players");
  reset.onclick = () => { selectedOwners.clear(); renderAll(); };
  bar.appendChild(reset);
  Object.entries(T.owners).sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, o]) => {
    const c = el("span", "chip" + (selectedOwners.has(name) ? " active" : ""),
      `<span class="dot" style="background:${o.color}"></span>${name}`);
    c.onclick = () => { selectedOwners.has(name) ? selectedOwners.delete(name) : selectedOwners.add(name); renderAll(); };
    bar.appendChild(c);
  });
  bar.appendChild(el("span", "filterhint", "tap a player to highlight their teams"));
}

function ownerTag(team) {
  const o = T.teams[team]?.owner;
  return o ? `<span class="otag"><span class="dot" style="background:${T.owners[o].color}"></span>${o}</span>` : "";
}

/* ---------- groups ---------- */
function teamRow(team) {
  const od = ownerDot(team), mv = teamMove(team);
  const row = el("div", "trow" + (isOut(team) ? " out" : ""));
  row.dataset.owned = owned(team);
  row.innerHTML =
    `<img class="${isOut(team) ? "flagout" : ""}" src="${FLAG(T.teams[team].iso)}" alt="">` +
    `<div><div class="tname">${seedBadge(team)}${team}</div>` +
    `<div class="owner"><span class="dot" style="background:${od.color}"></span>${od.name}</div></div>` +
    `<span class="pct">${pct(team)}</span>` +
    `<span class="delta ${mv.cls}">${mv.txt}</span>`;
  return row;
}
function renderGroups() {
  const v = $("#groupsView"); v.innerHTML = "";
  Object.keys(T.groups).sort().forEach(L => {
    const card = el("div", "group", `<h3>Group ${L}</h3>`);
    standings(L).forEach(t => card.appendChild(teamRow(t)));
    v.appendChild(card);
  });
}

/* ---------- table / standings ---------- */
function renderTable() {
  const v = $("#tableView"); if (!v) return; v.innerHTML = "";
  if (!results || !results.groups) {
    v.innerHTML = "<p class='emptynote'>Group tables appear once the tournament is under way.</p>";
    return;
  }
  // Teams reshuffle into live standings order, but with no movement arrows so
  // every row stays the same height and the group card never changes size.
  Object.keys(T.groups).sort().forEach(L => {
    const card = el("div", "ltcard", `<h3>Group ${L}</h3>`);
    const teams = [...T.groups[L]].sort((a, b) =>
      ((standing[a] && standing[a].rank) || 99) - ((standing[b] && standing[b].rank) || 99));
    const grp = results.groups[L] || [];
    const gdone = grp.length === 4 && grp.every(r => r.P >= 3);
    const cl = groupClinch(grp);   // early-clinched top-2 teams (before group finishes)
    const body = teams.map((team, i) => {
      const r = standing[team] || {};
      const od = ownerDot(team);
      const gd = r.GD || 0;
      const cls = (r.out ? "out" : "") + (i < 2 ? " qual" : "");
      const q = !gdone && cl[team] && cl[team].top2 ? `<span class="qbadge" title="Qualified for the Round of 32">Q</span>` : "";
      return `<tr class="${cls}" data-owned="${owned(team)}">` +
        `<td class="pos">${i + 1}</td>` +
        `<td class="lt-team"><img class="${isOut(team) ? "flagout" : ""}" src="${FLAG(T.teams[team]?.iso)}">` +
        `<span class="lt-nm">${team}</span>${q}<span class="otag"><span class="dot" style="background:${od.color}"></span>${od.name}</span></td>` +
        `<td>${r.P || 0}</td><td class="hidem">${r.W || 0}</td><td class="hidem">${r.D || 0}</td><td class="hidem">${r.L || 0}</td>` +
        `<td class="hidem">${r.GF || 0}</td><td class="hidem">${r.GA || 0}</td>` +
        `<td>${gd > 0 ? "+" + gd : gd}</td><td class="pts">${r.Pts || 0}</td></tr>`;
    }).join("");
    card.innerHTML +=
      `<table class="ltable"><thead><tr>` +
      `<th></th><th class="lt-team">Team</th><th>P</th><th class="hidem">W</th><th class="hidem">D</th>` +
      `<th class="hidem">L</th><th class="hidem">GF</th><th class="hidem">GA</th><th>GD</th><th>Pts</th>` +
      `</tr></thead><tbody>${body}</tbody></table>`;
    v.appendChild(card);
  });
}

/* ---------- ITP "Duff Pool" prize tracker ----------
   Renders only when #prizesView + tournament.json `prizes` exist (ITP only); inert
   elsewhere. Three switchable layouts via ?duff=standings|chalkboard|cans (default
   standings) for comparison. Leaders come from results.prizeStats + the bracket. */
function leadersBy(map, worst) {
  const e = Object.entries(map || {});
  if (!e.length) return [];
  const ext = e.reduce((acc, [, v]) => worst ? Math.min(acc, v) : Math.max(acc, v), worst ? Infinity : -Infinity);
  return e.filter(([, v]) => v === ext);
}
const duffOwner = team => (team && T.teams[team] && T.teams[team].owner) || null;
const ownerCol = o => (o && T.owners[o] && T.owners[o].color) || "#888";
function teamChip(team, withOwner) {
  if (!team || !T.teams[team]) return `<span class="dz-tbd">— TBD —</span>`;
  const o = duffOwner(team);
  return `<span class="dz-team"><img src="${FLAG(T.teams[team].iso)}" alt="">` +
    `<span class="dz-tn">${team}</span>` +
    (withOwner !== false && o ? `<span class="dz-own"><span class="dz-dot" style="background:${ownerCol(o)}"></span>${o}</span>` : "") +
    `</span>`;
}
// resolve each prize category to its current leader(s) + value
function duffCats() {
  const ps = (results && results.prizeStats) || {};
  const con = ps.conceded || {}, sc = ps.scored || {}, gd = {};
  Object.keys({ ...sc, ...con }).forEach(t => gd[t] = (sc[t] || 0) - (con[t] || 0));
  let champ = null, runner = null;
  if (results && T.knockout) {
    const byId = {}; T.knockout.forEach(m => byId[m.id] = m);
    const final = byId[104];
    if (final) {
      const { slotTeam, matchWinner } = resolveBracket(byId);
      const w = matchWinner(104);
      if (w) { const h = slotTeam(final.home, "104-home"), a = slotTeam(final.away, "104-away"); champ = w; runner = (w === h ? a : h); }
    }
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const evtVal = f => f ? `${f.clock || f.minute + "'"}${f.player ? " · " + f.player : ""}` : "";
  const resolve = key => {
    switch (key) {
      case "winner":       return champ ? { teams: [champ], val: "🏆 Champions" } : null;
      case "runnerup":     return runner ? { teams: [runner], val: "Runner-up" } : null;
      case "fastestGoal":  return ps.fastestGoal ? { teams: [ps.fastestGoal.team], val: evtVal(ps.fastestGoal) } : null;
      case "firstOwnGoal": return ps.firstOwnGoal ? { teams: [ps.firstOwnGoal.team], val: evtVal(ps.firstOwnGoal) } : null;
      case "mostRed":      { const t = leadersBy(ps.redCards, false); return t.length ? { teams: t.map(e => e[0]), val: plural(t[0][1], "red card") } : null; }
      case "mostConceded": { const t = leadersBy(con, false); return t.length ? { teams: t.map(e => e[0]), val: plural(t[0][1], "goal") + " conceded" } : null; }
      case "worstGD":      { const t = leadersBy(gd, true); return t.length ? { teams: t.map(e => e[0]), val: `${t[0][1] > 0 ? "+" : ""}${t[0][1]} GD` } : null; }
    }
    return null;
  };
  return T.prizes.map(c => {
    const r = resolve(c.key) || { teams: [], val: "" };
    return { key: c.key, label: c.label, pct: c.pct, teams: r.teams, val: r.val, single: r.teams.length === 1 };
  });
}
// Bart at the chalkboard — ITP-supplied image asset (Duff Pool chalkboard gag)
const BART = `<img class="cb-bart" src="bart_chalk_transparent.png" alt="Bart at the chalkboard">`;
function renderPrizes() {
  const v = $("#prizesView");
  if (!v || !T || !T.prizes) return;
  const cats = duffCats();
  const lines = cats.map(c => {
    const single = c.teams.length > 0;
    const lead = single ? c.teams.map(t => `<span class="cb-lead">${teamChip(t)}</span>`).join(" ") : `<span class="cb-tbd">TBD</span>`;
    const info = single && c.val ? c.val : "";
    return `<div class="cb-line"><span class="cb-prize">${c.label}</span>` +
      `<span class="cb-pool">${c.pct}%</span>` +
      `<span class="cb-leadwrap">${lead}</span>` +
      `<span class="cb-info">${info}</span></div>`;
  }).join("");
  v.innerHTML =
    `<div class="cb-scene">` +
      `<div class="cb-frame">` +
        `<div class="cb-board"><div class="cb-title">Leaderboard</div>` +
        `<div class="cb-lines">` +
          `<div class="cb-line cb-head"><span class="cb-prize">Criteria</span><span class="cb-pool">Share of Pot</span><span class="cb-leadwrap">Current Leader</span><span class="cb-info">Information</span></div>` +
          lines + `</div></div>` +
        `<div class="cb-tray"><i class="ch ch1"></i><i class="ch ch2"></i><i class="er"></i></div>` +
      `</div>` +
      `<div class="cb-floor"></div>` + BART +
    `</div>`;
}

/* ---------- knockout (absolute layout + connectors) ---------- */
function placeholderText(slot, matchById) {
  if (slot.win) return ({ R32: "R32", R16: "R16", QF: "QF", SF: "SF" }[matchById[slot.win].round] || "") + " winner";
  if (slot.pos === "W") return "Winner " + slot.group;
  if (slot.pos === "R") return "Runner-up " + slot.group;
  if (slot.pos === "3") return "3rd · " + slot.groups.join("/");
  return "TBD";
}
function pslot(text) {
  const s = el("div", "slot pslot");
  s.innerHTML = `<span></span><span class="kdot"></span><span class="nm">${text}</span><span></span>`;
  return s;
}
// a knockout slot once a real team is known (flag + owner colour + score + win/lose)
function kslot(team, opts) {
  const s = el("div", "slot" + (opts.won ? " kwin" : "") + (opts.lost ? " klose" : "") + (opts.prov ? " kprov" : ""));
  const od = ownerDot(team);
  s.style.borderLeftColor = od.color;
  s.dataset.owned = owned(team);
  s.title = opts.prov ? `${team} — ${od.name} · qualified (final group position TBD)` : `${team} — ${od.name}`;
  s.innerHTML = `<span></span><img src="${FLAG(T.teams[team].iso)}" alt="">` +
    `<span class="knm"><span class="nm">${team}</span>${od.name && od.name !== "—" ? `<span class="kown">${od.name}</span>` : ""}</span>` +
    (opts.prov ? `<span class="kq" title="Qualified — final group position TBD">Q</span>` : `<span class="kscore">${opts.score}</span>`);
  return s;
}
// assign the 8 best third-placed teams to the third-slots, respecting allowed groups
function assignThirds(slots, qualifying) {
  const assign = {}, used = new Set();
  (function bt(i) {
    if (i === slots.length) return true;
    for (const q of qualifying) {
      if (!used.has(q.group) && slots[i].groups.includes(q.group)) {
        used.add(q.group); assign[slots[i].key] = q.team;
        if (bt(i + 1)) return true;
        used.delete(q.group); delete assign[slots[i].key];
      }
    }
    return false;
  })(0);
  return assign;
}
// which teams are mathematically guaranteed a top-2 (or 1st) group finish, by
// brute-forcing every outcome of the group's remaining fixtures. Conservative:
// a team clinches top-2 only if in EVERY scenario at most one rival can match or
// pass its points (so tiebreakers can never drop it below 2nd).
function groupClinch(rows) {
  const teams = rows.map(r => r.team);
  const base = {}; rows.forEach(r => base[r.team] = r.Pts || 0);
  const rem = ((results && results.matches) || []).filter(m =>
    m.state === "pre" && teams.includes(m.a) && teams.includes(m.b));
  const scen = [];
  (function rec(i, p) {
    if (i === rem.length) { scen.push(p); return; }
    const { a, b } = rem[i];
    rec(i + 1, { ...p, [a]: p[a] + 3 });            // a wins
    rec(i + 1, { ...p, [a]: p[a] + 1, [b]: p[b] + 1 }); // draw
    rec(i + 1, { ...p, [b]: p[b] + 3 });            // b wins
  })(0, base);
  const f = {};
  teams.forEach(t => {
    let won = true, top2 = true;
    for (const s of scen) {
      const ge = teams.reduce((n, o) => n + (o !== t && s[o] >= s[t] ? 1 : 0), 0);
      if (ge >= 1) won = false;
      if (ge >= 2) top2 = false;
    }
    f[t] = { won, top2 };
  });
  return f;
}
// resolve real teams into bracket slots from group standings + actual match winners
function resolveBracket(matchById) {
  const groups = (results && results.groups) || {};
  const rank = {}, done = {};
  Object.keys(groups).forEach(g => {
    rank[g] = groups[g].map(r => r.team);
    done[g] = groups[g].length === 4 && groups[g].every(r => r.P >= 3);
  });
  let thirds = {};
  const allDone = Object.keys(groups).length === 12 && Object.values(done).every(Boolean);
  if (allDone) {
    const q = Object.keys(groups).map(g => ({ team: groups[g][2].team, group: g, Pts: groups[g][2].Pts, GD: groups[g][2].GD, GF: groups[g][2].GF }))
      .sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF).slice(0, 8);
    const slots = [];
    T.knockout.forEach(m => ["home", "away"].forEach(side => {
      if (m[side].pos === "3") slots.push({ key: `${m.id}-${side}`, groups: m[side].groups });
    }));
    thirds = assignThirds(slots, q);
  }
  // teams clinched into the top 2 are shown provisionally (in their current-rank
  // slot) before the group's last games are played; `prov` flags those fills
  const clinch = {}; Object.keys(groups).forEach(g => clinch[g] = done[g] ? null : groupClinch(groups[g]));
  const prov = new Set();
  const cache = {};
  function slotTeam(slot, key) {
    if (slot.win) return matchWinner(slot.win);
    if (slot.pos === "W" || slot.pos === "R") {
      const t = rank[slot.group] ? rank[slot.group][slot.pos === "W" ? 0 : 1] : null;
      if (done[slot.group]) return t;
      const c = clinch[slot.group];
      if (t && c && c[t] && c[t].top2) { prov.add(key); return t; }
      return null;
    }
    if (slot.pos === "3") return thirds[key] || null;
    return null;
  }
  function matchWinner(mid) {
    if (mid in cache) return cache[mid];
    cache[mid] = null;
    const m = matchById[mid];
    const h = slotTeam(m.home, `${mid}-home`), a = slotTeam(m.away, `${mid}-away`);
    if (h && a) {
      const res = getMatch(h, a);
      if (res && res.state === "post")
        cache[mid] = res.w || (res.sa === res.sb ? null : (res.a === h ? (res.sa > res.sb ? h : a) : (res.sa > res.sb ? a : h)));
    }
    return cache[mid];
  }
  return { slotTeam, matchWinner, prov };
}
function line(parent, x, y, w, h, cls) {
  const d = el("div", cls || "kline");
  d.style.left = x + "px"; d.style.top = y + "px"; d.style.width = w + "px"; d.style.height = h + "px";
  parent.appendChild(d);
}
/* ---------- Sweepstake Rankings (worldcupbracket only — needs tournament.json `pots`) ----------
   Each pot's prize goes to the team that reaches the furthest round; ties (same round)
   broken by Points -> GD -> goals for -> goals against -> yellows -> reds. Prizes pay
   the team's owner: $200 champion, $70 runner-up, $30 per pot winner. */
const SWEEP_PRIZES = { champion: 200, runnerUp: 70, pot: 30 };
function sweepDepth(team, ctx) {
  const roundN = { R32: 2, R16: 3, QF: 4, SF: 5, Final: 6 };
  let deepest = 0;
  T.knockout.forEach(m => {
    const h = ctx.slotTeam(m.home, `${m.id}-home`), a = ctx.slotTeam(m.away, `${m.id}-away`);
    if ((h === team || a === team) && (roundN[m.round] || 0) > deepest) deepest = roundN[m.round];
  });
  if (ctx.matchWinner(104) === team) return { n: 7, label: "Champion" };
  if (deepest === 6) return { n: 6, label: "Final" };
  if (deepest) return { n: deepest, label: { 2: "Round of 32", 3: "Round of 16", 4: "Quarter-final", 5: "Semi-final" }[deepest] };
  if (isOut(team) || (standing[team] && standing[team].out)) return { n: 0, label: "Out · group" };
  return { n: 1, label: "Group stage" };
}
function sweepStat(team) {
  const ps = (results && results.prizeStats) || {}, s = standing[team] || {};
  const gf = (ps.scored || {})[team] ?? s.GF ?? 0, ga = (ps.conceded || {})[team] ?? s.GA ?? 0;
  return { pts: s.Pts || 0, gf, ga, gd: gf - ga, y: (ps.yellowCards || {})[team] || 0, r: (ps.redCards || {})[team] || 0 };
}
function sweepRank(teams, ctx) {
  return teams.map(t => ({ t, d: sweepDepth(t, ctx), s: sweepStat(t) }))
    .sort((a, b) => b.d.n - a.d.n || b.s.pts - a.s.pts || b.s.gd - a.s.gd || b.s.gf - a.s.gf || a.s.ga - b.s.ga || a.s.y - b.s.y || a.s.r - b.s.r);
}
// shared data model for the Sweepstake tab + its exported infographic
function sweepsModel() {
  const byId = {}; T.knockout.forEach(m => byId[m.id] = m);
  const ctx = resolveBracket(byId);
  const champ = ctx.matchWinner(104);
  const fin = byId[104]; let runner = null;
  if (fin && champ) { const h = ctx.slotTeam(fin.home, "104-home"), a = ctx.slotTeam(fin.away, "104-away"); runner = champ === h ? a : h; }
  const ownerOf = t => (t && T.teams[t]) ? T.teams[t].owner : null;
  const winnings = {};
  const award = (t, amt, label) => { const o = ownerOf(t); if (!o) return; (winnings[o] || (winnings[o] = { amt: 0, prizes: [] })).amt += amt; winnings[o].prizes.push(label); };
  award(champ, SWEEP_PRIZES.champion, "Winner"); award(runner, SWEEP_PRIZES.runnerUp, "Runner-up");
  const ranked = {};
  Object.keys(T.pots).forEach(p => { ranked[p] = sweepRank(T.pots[p], ctx); const w = ranked[p][0]; award(w && w.t, SWEEP_PRIZES.pot, p); });
  const board = Object.entries(winnings).sort((a, b) => b[1].amt - a[1].amt);
  return { ctx, champ, runner, ranked, board, ownerOf };
}

// draw a shareable PNG infographic on a <canvas> — no external libs and no flag
// images, so the canvas is never tainted and always exports
// gather a broad "tournament digest" from the live data. The pot leaders + player
// slips are the sweepstake content; the rest is pure football (odds swings,
// tournament stat leaders, eliminations).
function digestModel() {
  const s = sweepsModel();
  const teamIso = t => (T.teams[t] || {}).iso;
  // --- team-news headlines (today only) from the news scraper ---
  const nowSec = Math.floor(Date.now() / 1000);
  const headlines = (((news && news.items) || []).filter(h => h && h.title && (!h.ts || h.ts >= nowSec - 36 * 3600))).slice(0, 3);
  // --- sweepstake: pot 1-4 leaders (kept) ---
  const pots = Object.keys(T.pots).map(p => { const w = s.ranked[p][0]; const t = w && w.t; return { pot: p, team: t, owner: t ? s.ownerOf(t) : null, round: w ? w.d.label : "", iso: t ? teamIso(t) : null }; });
  // --- player slips: biggest 24h movers by combined win probability (with current total) ---
  const havePrev = Object.keys(probPrev).length > 0;
  const slipMovers = Object.keys(T.owners).map(o => {
    const now = sumProb(T.owners[o].teams, probLatest);
    const was = havePrev ? sumProb(T.owners[o].teams, probPrev) : now;
    return { o, now, d: (now - was) * 100 };
  }).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  // --- knocked out: pure teams (with flag iso), strongest first ---
  const out = Object.keys(T.teams).filter(t => isOut(t)).sort((a, b) => (seed[a] || 99) - (seed[b] || 99)).map(t => ({ team: t, iso: teamIso(t) }));
  // --- biggest odds movers over the last 24h (with flag + current total chance) ---
  const md = Object.keys(probLatest).filter(t => T.teams[t]).map(t => ({ t, d: (probLatest[t] - (probPrev[t] ?? probLatest[t])) * 100 }));
  const dec = x => x ? { ...x, iso: teamIso(x.t), now: probLatest[x.t] ?? 0 } : null;
  const riser = dec(md.slice().sort((a, b) => b.d - a.d)[0] || null);
  const faller = dec(md.slice().sort((a, b) => a.d - b.d)[0] || null);
  const R = results || {};
  // --- by the numbers: tournament stat leaders ---
  const ps = R.prizeStats || {};
  const top = map => { const e = Object.entries(map || {}); if (!e.length) return null; e.sort((a, b) => b[1] - a[1]); return { team: e[0][0], v: e[0][1] }; };
  const tiles = [];
  if (ps.fastestGoal) tiles.push({ label: "Fastest goal", team: ps.fastestGoal.team, val: ps.fastestGoal.clock || ps.fastestGoal.minute + "'", iso: teamIso(ps.fastestGoal.team) });
  const sharp = top(ps.scored); if (sharp) tiles.push({ label: "Sharpest attack", team: sharp.team, val: sharp.v + " scored", iso: teamIso(sharp.team) });
  const leak = top(ps.conceded); if (leak) tiles.push({ label: "Leakiest defence", team: leak.team, val: leak.v + " conceded", iso: teamIso(leak.team) });
  const reds = top(ps.redCards); if (reds) tiles.push({ label: "Most red cards", team: reds.team, val: reds.v + (reds.v === 1 ? " red" : " reds"), iso: teamIso(reds.team) });
  if (tiles.length < 4 && ps.firstOwnGoal) tiles.push({ label: "First own goal", team: ps.firstOwnGoal.team, val: ps.firstOwnGoal.clock || ps.firstOwnGoal.minute + "'", iso: teamIso(ps.firstOwnGoal.team) });
  return { ...s, pots, slipMovers, out, riser, faller, tiles, headlines };
}

// preload flag PNGs as CORS-clean images so they can be drawn without tainting the
// canvas (flagcdn sends Access-Control-Allow-Origin: *). Failed loads are skipped.
function loadFlags(isos) {
  const uniq = [...new Set((isos || []).filter(Boolean))];
  return Promise.all(uniq.map(iso => new Promise(res => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res([iso, img]);
    img.onerror = () => res(null);
    img.src = `https://flagcdn.com/w40/${iso}.png`;
  }))).then(pairs => { const m = {}; pairs.forEach(p => { if (p) m[p[0]] = p[1]; }); return m; });
}

// every flag iso the digest draws (pot leaders, team movers, stat tiles, knocked out)
function digestFlagIsos(m) {
  return [...m.pots.map(p => p.iso), m.riser && m.riser.iso, m.faller && m.faller.iso,
    ...m.tiles.map(t => t.iso), ...m.out.map(o => o.iso)];
}

// draw the shareable digest PNG on a <canvas>. Flags (if any) are CORS-clean images
// from loadFlags(), so drawing them keeps the canvas exportable. Each section is a
// single bordered panel with row dividers for a clean leaderboard look.
function drawDigest(m, flags) {
  flags = flags || {};
  const C = { bg0: "#0e3325", bg1: "#06140e", panel: "#10382b", gold: "#ffd24a", ink: "#f4f7f5", dim: "#9bb1a8", up: "#5fcf8f", down: "#ff6b6b", border: "rgba(255,255,255,.07)", div: "rgba(255,255,255,.06)" };
  const F = s => `${s}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  const ocol = o => (o && T.owners[o] && T.owners[o].color) || "#888";
  // offscreen text measurement (needed to wrap headlines before the canvas is sized)
  const mc = document.createElement("canvas").getContext("2d");
  const measure = (s, sz, wt) => { mc.font = `${wt} ${F(sz)}`; return mc.measureText(String(s)).width; };
  const wrapLines = (s, maxw, sz, wt) => { const words = String(s).split(/\s+/), lines = []; let cur = ""; words.forEach(w => { const t = cur ? cur + " " + w : w; if (measure(t, sz, wt) <= maxw || !cur) cur = t; else { lines.push(cur); cur = w; } }); if (cur) lines.push(cur); return lines; };
  const clipM = (s, maxw, sz, wt) => { s = String(s); if (measure(s, sz, wt) <= maxw) return s; let t = s; while (t.length && measure(t + "…", sz, wt) > maxw) t = t.slice(0, -1); return t.trimEnd() + "…"; };
  const W = 1080, pad = 56, IW = W - 2 * pad, R = 2, headH = 200, hdrH = 46, rowH = 62, secGap = 22, tileH = 96, tileGap = 16;
  const xL = pad + 28, xR = W - pad - 28;
  const teamMovers = [];
  if (m.riser && m.riser.d > 0.05) teamMovers.push({ ...m.riser, up: true });
  if (m.faller && m.faller.d < -0.05) teamMovers.push({ ...m.faller, up: false });
  const slipMovers = (m.slipMovers || []).filter(s => Math.abs(s.d) > 0.05).slice(0, 4);
  const tiles = m.tiles;
  const tileRows = Math.max(1, Math.ceil(tiles.length / 2));
  const outRows = Math.max(1, Math.ceil(m.out.length / 2));

  // headlines: wrap each to <=2 lines now so we can size the panel
  const NEWS_MAXW = IW - 100, NEWS_LH = 27;
  const newsItems = (m.headlines || []).map(h => {
    let lines = wrapLines(h.title, NEWS_MAXW, 21, 600);
    if (lines.length > 2) { const rest = lines.slice(1).join(" "); lines = [lines[0], clipM(rest, NEWS_MAXW, 21, 600)]; }
    return { h, lines };
  });
  const newsItemH = it => it.lines.length * NEWS_LH + 52;
  const newsBody = newsItems.reduce((s, it) => s + newsItemH(it), 0);
  const newsH = newsItems.length ? hdrH + newsBody + secGap : 0;

  const rowsH = n => hdrH + Math.max(1, n) * rowH + secGap;
  const tilesH = hdrH + tileRows * tileH + (tileRows - 1) * tileGap + secGap;
  const knockBody = m.out.length ? (16 + outRows * 42 + 16) : rowH;
  const knockH = hdrH + knockBody + secGap;
  const startY = headH + 26;
  const total = newsH + rowsH(m.pots.length) + rowsH(slipMovers.length) + rowsH(teamMovers.length) + tilesH + knockH;
  const H = startY + total + 36;

  const cv = document.createElement("canvas"); cv.width = W * R; cv.height = H * R;
  const c = cv.getContext("2d"); c.scale(R, R); c.textBaseline = "alphabetic";
  const rrp = (x, y, w, h, r) => { c.beginPath(); c.roundRect(x, y, w, h, r); };
  const txt = (s, x, y, sz, wt, col, al) => { c.font = `${wt} ${F(sz)}`; c.fillStyle = col; c.textAlign = al || "left"; c.fillText(String(s), x, y); };
  const dot = (x, y, r, col) => { c.beginPath(); c.arc(x, y, r, 0, 7); c.fillStyle = col; c.fill(); };
  const clip = (s, maxw, wt, sz) => { c.font = `${wt} ${F(sz)}`; s = String(s); if (c.measureText(s).width <= maxw) return s; let t = s; while (t.length && c.measureText(t + "…").width > maxw) t = t.slice(0, -1); return t + "…"; };
  const panel = (yt, h) => { rrp(pad, yt, IW, h, 16); c.fillStyle = C.panel; c.fill(); c.lineWidth = 1; c.strokeStyle = C.border; rrp(pad + .5, yt + .5, IW - 1, h - 1, 15.5); c.stroke(); };
  const divider = yy => { c.strokeStyle = C.div; c.lineWidth = 1; c.beginPath(); c.moveTo(pad + 24, yy); c.lineTo(W - pad - 24, yy); c.stroke(); };
  const avatar = (x, yc, r, o) => { dot(x, yc, r, ocol(o)); txt((o[0] || "").toUpperCase(), x, yc + r * 0.36, r * 1.05, 800, "#08231a", "center"); };
  // draw a flag centred vertically on yc; returns true if drawn (else caller falls back)
  const flag = (iso, x, yc, fw, fh) => { const img = iso && flags[iso]; if (!img) return false; const ty = yc - fh / 2; c.save(); rrp(x, ty, fw, fh, 3); c.clip(); c.drawImage(img, x, ty, fw, fh); c.restore(); rrp(x, ty, fw, fh, 3); c.strokeStyle = "rgba(0,0,0,.35)"; c.lineWidth = 1; c.stroke(); return true; };

  // ---- background + header band ----
  let g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, C.bg0); g.addColorStop(1, C.bg1); c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createLinearGradient(0, 0, W, headH); g.addColorStop(0, "rgba(255,210,74,.18)"); g.addColorStop(.65, "rgba(255,210,74,.02)"); c.fillStyle = g; c.fillRect(0, 0, W, headH);
  c.fillStyle = C.gold; c.fillRect(0, headH - 4, W, 4);
  txt("WORLD CUP 2026", pad, 92, 52, 800, C.gold);
  txt("Tournament digest", pad, 132, 26, 500, C.ink);
  txt(new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }), pad, 168, 21, 500, C.dim);

  let y = startY;
  const head = s => { c.fillStyle = C.gold; rrp(pad, y + 2, 5, 20, 2); c.fill(); txt(s, pad + 16, y + 18, 19, 800, C.gold); y += hdrH; };
  const empty = msg => { panel(y, rowH); txt(msg, xL, y + rowH / 2 + 6, 20, 500, C.dim); y += rowH + secGap; };
  const nowSec = Math.floor(Date.now() / 1000);

  // ---- TEAM NEWS · today (scraped headlines) ----
  if (newsItems.length) {
    head("TEAM NEWS · today");
    panel(y, newsBody);
    let yy = y;
    newsItems.forEach((it, i) => {
      if (i) divider(yy);
      const top = yy + 16;
      dot(xL, top + 9, 4, C.gold);
      it.lines.forEach((ln, li) => txt(ln, xL + 22, top + 18 + li * NEWS_LH, 21, 600, C.ink));
      const meta = (it.h.source || "") + (it.h.ts ? "  ·  " + ago(nowSec - it.h.ts) : "");
      txt(meta.toUpperCase(), xL + 22, top + 18 + it.lines.length * NEWS_LH + 2, 13, 700, C.dim);
      yy += newsItemH(it);
    });
    y += newsBody + secGap;
  }

  // ---- POT LEADERS (sweepstake) ----
  head("POT LEADERS · furthest so far");
  { const ph = m.pots.length * rowH; panel(y, ph);
    m.pots.forEach((p, i) => {
      const yc = y + i * rowH + rowH / 2; if (i) divider(y + i * rowH);
      txt(p.pot.toUpperCase(), xL, yc + 5, 14, 800, C.dim);
      if (p.team) {
        const drew = flag(p.iso, pad + 100, yc, 30, 20), tx = drew ? pad + 144 : pad + 100;
        dot(tx + 6, yc, 6, ocol(p.owner));
        txt(clip(p.team + "  ·  " + p.owner, IW - 380, 600, 22), tx + 20, yc + 6, 22, 600, C.ink);
        txt(p.round, xR, yc + 5, 17, 600, C.dim, "right");
      } else txt("TBD", pad + 100, yc + 6, 20, 500, C.dim);
    });
    y += ph + secGap;
  }

  // ---- PLAYER SLIPS · biggest 24h moves (sweepstake) ----
  head("PLAYER SLIPS · biggest 24h moves");
  if (!slipMovers.length) empty("Slips holding steady — no notable moves.");
  else { const ph = slipMovers.length * rowH; panel(y, ph);
    slipMovers.forEach((s, i) => {
      const yc = y + i * rowH + rowH / 2, up = s.d >= 0, col = up ? C.up : C.down; if (i) divider(y + i * rowH);
      txt(up ? "▲" : "▼", xL, yc + 7, 18, 800, col);
      avatar(pad + 80, yc, 15, s.o);
      txt(s.o, pad + 110, yc + 7, 23, 700, C.ink);
      txt((s.now * 100).toFixed(1) + "%", xR - 128, yc + 7, 19, 600, C.dim, "right");
      txt((up ? "+" : "") + s.d.toFixed(1) + "%", xR, yc + 8, 24, 800, col, "right");
    });
    y += ph + secGap;
  }

  // ---- TEAM odds movers ----
  head("TEAMS · biggest odds moves · 24h");
  if (!teamMovers.length) empty("Odds steady — no notable moves.");
  else { const ph = teamMovers.length * rowH; panel(y, ph);
    teamMovers.forEach((mv, i) => {
      const yc = y + i * rowH + rowH / 2, col = mv.up ? C.up : C.down; if (i) divider(y + i * rowH);
      txt(mv.up ? "▲" : "▼", xL, yc + 7, 18, 800, col);
      const drew = flag(mv.iso, pad + 58, yc, 30, 20), tx = drew ? pad + 102 : pad + 58;
      txt(clip(mv.t, IW - 380, 700, 23), tx, yc + 7, 23, 700, C.ink);
      txt((mv.now * 100).toFixed(1) + "%", xR - 128, yc + 7, 19, 600, C.dim, "right");
      txt((mv.up ? "+" : "") + mv.d.toFixed(1) + "%", xR, yc + 8, 24, 800, col, "right");
    });
    y += ph + secGap;
  }

  // ---- BY THE NUMBERS (stat tiles) ----
  head("BY THE NUMBERS");
  { const tw = (IW - tileGap) / 2;
    tiles.forEach((t, i) => {
      const cx = pad + (i % 2) * (tw + tileGap), ty = y + Math.floor(i / 2) * (tileH + tileGap), ln = ty + 70;
      rrp(cx, ty, tw, tileH, 14); c.fillStyle = C.panel; c.fill(); c.lineWidth = 1; c.strokeStyle = C.border; rrp(cx + .5, ty + .5, tw - 1, tileH - 1, 13.5); c.stroke();
      txt(t.label.toUpperCase(), cx + 24, ty + 34, 13, 800, C.dim);
      const drew = flag(t.iso, cx + 24, ln - 7, 30, 20), tx = drew ? cx + 66 : cx + 24;
      txt(clip(t.team, tw - (tx - cx) - 120, 700, 23), tx, ln, 23, 700, C.ink);
      txt(t.val, cx + tw - 22, ln, 16, 800, C.gold, "right");
    });
    y += tileRows * tileH + (tileRows - 1) * tileGap + secGap;
  }

  // ---- KNOCKED OUT ----
  head("KNOCKED OUT");
  if (!m.out.length) empty("Nobody eliminated yet.");
  else { panel(y, knockBody); const colW = IW / 2, fw = 30, fh = 20;
    m.out.forEach((o, i) => {
      const cx = pad + 24 + (i % 2) * colW, yc = y + 16 + Math.floor(i / 2) * 42 + 21, img = flags[o.iso];
      if (img) { c.save(); rrp(cx, yc - fh / 2, fw, fh, 3); c.clip(); c.drawImage(img, cx, yc - fh / 2, fw, fh); c.restore(); rrp(cx, yc - fh / 2, fw, fh, 3); c.strokeStyle = "rgba(0,0,0,.35)"; c.lineWidth = 1; c.stroke(); }
      else dot(cx + 8, yc, 5, C.dim);
      txt(clip(o.team, colW - 96, 500, 20), cx + fw + 14, yc + 6, 20, 500, C.dim);
    });
    y += knockBody + secGap;
  }

  txt("Updated " + new Date().toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + " · live at the dashboard", pad, H - 26, 17, 500, C.dim);
  return cv;
}

async function exportSweeps(btn) {
  const reset = btn ? btn.textContent : "";
  const flash = msg => { if (btn) { btn.textContent = msg; setTimeout(() => { btn.textContent = reset; }, 2600); } };
  const m = digestModel();
  const flags = await loadFlags(digestFlagIsos(m));   // CORS-clean so export still works
  drawDigest(m, flags).toBlob(async blob => {
    if (!blob) return;
    const file = new File([blob], `wc-update-${new Date().toISOString().slice(0, 10)}.png`, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "World Cup 2026", text: "World Cup 2026 — tournament digest" }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    let copied = false;
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); copied = true; } catch (e) { /* clipboard unsupported */ }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash(copied ? "Saved + copied ✓" : "Image saved ✓");
  }, "image/png");
}

function renderSweeps() {
  const v = $("#sweepsView");
  if (!v || !T || !T.pots) return;
  const M = sweepsModel();
  const { champ, runner, ranked, board, ownerOf } = M;
  const ocol = o => (o && T.owners[o] && T.owners[o].color) || "#888";
  const colOf = t => ocol(ownerOf(t));
  const teamCell = t => t
    ? `<span class="sw-team"><img class="${isOut(t) ? "flagout" : ""}" src="${FLAG(T.teams[t].iso)}"><b>${t}</b>` +
      `<span class="sw-own"><span class="dz-dot" style="background:${colOf(t)}"></span>${ownerOf(t) || "—"}</span></span>`
    : `<span class="dz-tbd">TBD</span>`;
  // ----- hero -----
  let html = `<div class="sw-hero">` +
    `<button class="sw-export" type="button">Share update</button>` +
    `<div class="sw-hero-title">Sweepstake Rankings</div>` +
    `<div class="sw-hero-pool"><b>$390</b> prize pool · $200 winner · $70 runner-up · $30 each pot</div>` +
    `<div class="sw-rules"><b>Pot winner</b> = the team that progresses furthest. Ties are broken in order: ` +
    `Points → Goal difference → Goals scored → Goals conceded → Yellow cards → Red cards.</div></div>`;
  // ----- Winner / Runner-up hero cards -----
  const bigPrize = (cls, medal, amt, label, team) =>
    `<div class="sw-big ${cls}"${team ? ` style="--c:${colOf(team)}"` : ""}><div class="sw-big-medal">${medal}</div>` +
    `<div class="sw-big-info"><div class="sw-big-amt">$${amt}</div><div class="sw-big-lab">${label}</div>` +
    `<div class="sw-big-team">${team ? teamCell(team) : `<span class="sw-tbd">to be decided</span>`}</div></div></div>`;
  html += `<div class="sw-bigs">` + bigPrize("gold", "🏆", SWEEP_PRIZES.champion, "Tournament Winner", champ) +
    bigPrize("silver", "🥈", SWEEP_PRIZES.runnerUp, "Runner-up", runner) + `</div>`;
  // ----- 2x2 pot cards -----
  html += `<div class="sw-potcards">` + Object.keys(T.pots).map(p => {
    const w = ranked[p][0], t = w && w.t;
    return `<div class="sw-potcard"${t ? ` style="--c:${colOf(t)}"` : ""}>` +
      `<div class="sw-pc-head"><span class="sw-pc-name">${p}</span><span class="sw-pc-cash">$${SWEEP_PRIZES.pot}</span></div>` +
      `<div class="sw-pc-team">${t ? teamCell(t) : `<span class="sw-tbd">TBD</span>`}</div>` +
      `<div class="sw-pc-round">${t ? "reached " + w.d.label : "—"}</div></div>`;
  }).join("") + `</div>`;
  // ----- money: podium (top 3) + list -----
  if (board.length) {
    const av = o => `<span class="sw-av" style="background:${ocol(o)}">${o[0]}</span>`;
    const chips = w => w.prizes.map(x => `<em>${x}</em>`).join("");
    html += `<div class="sw-money"><div class="sw-money-head"><h3>💰 Prize money — as it stands</h3></div>`;
    if (board.length >= 3) {
      const pod = ([o, w], place, medal) => `<div class="sw-pod sw-pod-${place}" style="--c:${ocol(o)}">` +
        `<div class="sw-pod-top"><div class="sw-pod-medal">${medal}</div>${av(o)}<div class="sw-pod-name">${o}</div>` +
        `<div class="sw-pod-amt">$${w.amt}</div></div><div class="sw-pod-block">${place}</div></div>`;
      html += `<div class="sw-podium">` + pod(board[1], 2, "🥈") + pod(board[0], 1, "🥇") + pod(board[2], 3, "🥉") + `</div>`;
      const rest = board.slice(3);
      if (rest.length) html += `<div class="sw-mlist">` + rest.map(([o, w], i) =>
        `<div class="sw-mrow"><span class="sw-mrank">${i + 4}</span>${av(o)}<span class="sw-mname">${o}</span>` +
        `<span class="sw-mprz">${chips(w)}</span><span class="sw-mamt">$${w.amt}</span></div>`).join("") + `</div>`;
    } else {
      html += `<div class="sw-mlist">` + board.map(([o, w], i) =>
        `<div class="sw-mrow"><span class="sw-mrank">${i + 1}</span>${av(o)}<span class="sw-mname">${o}</span>` +
        `<span class="sw-mprz">${chips(w)}</span><span class="sw-mamt">$${w.amt}</span></div>`).join("") + `</div>`;
    }
    html += `</div>`;
  }

  const RSHORT = { 7: "Winner", 6: "Final", 5: "SF", 4: "QF", 3: "R16", 2: "R32", 1: "Group", 0: "Out" };
  html += `<div class="sw-pots">`;
  Object.keys(T.pots).forEach(p => {
    const rows = ranked[p].map((r, i) => {
      const out = isOut(r.t) || (standing[r.t] && standing[r.t].out);
      return `<tr class="${i === 0 ? "sw-winrow" : ""}${out ? " out" : ""}">` +
        `<td class="sw-pos">${i + 1}</td><td class="sw-tcell">${teamCell(r.t)}</td>` +
        `<td class="sw-round">${RSHORT[r.d.n] || r.d.label}</td><td>${r.s.pts}</td>` +
        `<td>${r.s.gd > 0 ? "+" + r.s.gd : r.s.gd}</td><td class="hidem">${r.s.gf}</td><td class="hidem">${r.s.ga}</td>` +
        `<td class="hidem">${r.s.y}</td><td class="hidem">${r.s.r}</td>` +
        `<td class="sw-cash">${i === 0 ? "$" + SWEEP_PRIZES.pot : ""}</td></tr>`;
    }).join("");
    html += `<div class="sw-pot"><h3>${p}</h3><table class="sw-table"><thead><tr>` +
      `<th></th><th>Team</th><th>Reached</th><th title="Points">Pts</th><th title="Goal difference">GD</th>` +
      `<th class="hidem">GF</th><th class="hidem">GA</th><th class="hidem" title="Yellow cards">Y</th><th class="hidem" title="Red cards">R</th><th></th>` +
      `</tr></thead><tbody>${rows}</tbody></table></div>`;
  });
  html += `</div>`;
  v.innerHTML = html;
  const eb = v.querySelector(".sw-export"); if (eb) eb.onclick = () => exportSweeps(eb);
}
function renderKnockout() {
  const v = $("#knockoutView"); v.innerHTML = "";
  const matchById = {}; T.knockout.forEach(m => matchById[m.id] = m);

  // DFS leaf ordering from the Final root -> non-crossing vertical positions
  const yUnit = {}; let leaf = 0;
  (function layout(id) {
    const m = matchById[id];
    if (m.round === "R32") return (yUnit[id] = leaf++);
    const yh = layout(m.home.win), ya = layout(m.away.win);
    return (yUnit[id] = (yh + ya) / 2);
  })(104);
  const ypx = u => HEADER_H + (u + 0.5) * H;
  const fullH = HEADER_H + 16 * H;

  const wrap = el("div", "kwrap");
  wrap.style.width = (5 * COLW + MATCHW + 20) + "px";
  wrap.style.height = fullH + "px";

  // round titles + subtle dividers (horizontal under each round, vertical between rounds)
  const rounds = [["R32", "Round of 32"], ["R16", "Round of 16"], ["QF", "Quarter-finals"],
                  ["SF", "Semi-finals"], ["Final", "Final"], ["Winner", "Winner"]];
  rounds.forEach(([code, label], ci) => {
    const x = (code === "Winner" ? 5 : ROUND_COL[code]) * COLW;
    const t = el("div", "ktitle", label); t.style.left = x + "px"; t.style.top = "0px"; wrap.appendChild(t);
    line(wrap, x, HEADER_H - 8, MATCHW, 2, "khr");
    if (ci > 0) line(wrap, x - HGAP / 2, HEADER_H - 8, 2, fullH - HEADER_H + 8, "kvsep");
  });

  // connectors
  T.knockout.forEach(m => {
    if (m.round === "R32") return;
    const col = ROUND_COL[m.round];
    const childRight = (col - 1) * COLW + MATCHW;
    const midX = childRight + HGAP / 2;
    const parentLeft = col * COLW;
    const yh = ypx(yUnit[m.home.win]), ya = ypx(yUnit[m.away.win]), yp = ypx(yUnit[m.id]);
    line(wrap, childRight, yh - 1, HGAP / 2, 2);
    line(wrap, childRight, ya - 1, HGAP / 2, 2);
    line(wrap, midX - 1, Math.min(yh, ya), 2, Math.abs(ya - yh));
    line(wrap, midX - 1, yp - 1, parentLeft - midX + 1, 2);
  });

  // match boxes — real teams once known, otherwise the position placeholder
  const { slotTeam, matchWinner, prov } = resolveBracket(matchById);
  const slotFor = (m, side) => {
    const key = `${m.id}-${side}`, team = slotTeam(m[side], key);
    if (!team) return { team: null, label: placeholderText(m[side], matchById) };
    return { team, key, prov: prov.has(key) };
  };
  T.knockout.forEach(m => {
    const box = el("div", "kbox");
    box.style.left = ROUND_COL[m.round] * COLW + "px";
    box.style.top = ypx(yUnit[m.id]) + "px";
    box.style.width = MATCHW + "px";
    const h = slotFor(m, "home"), a = slotFor(m, "away");
    const res = (h.team && a.team) ? getMatch(h.team, a.team) : null;
    const played = res && res.state !== "pre";
    const winner = matchWinner(m.id);
    let hs = "", as = "";
    if (played) { const flip = res.a !== h.team; hs = flip ? res.sb : res.sa; as = flip ? res.sa : res.sb; }
    [[h, hs], [a, as]].forEach(([slot, score]) => {
      if (!slot.team) { box.appendChild(pslot(slot.label)); return; }
      box.appendChild(kslot(slot.team, {
        score: score === "" ? "" : score,
        won: winner && winner === slot.team,
        lost: winner && winner !== slot.team,
        prov: slot.prov,
      }));
    });
    wrap.appendChild(box);
  });

  // champion (filled when the final is decided)
  const champ = matchWinner(104);
  const c = el("div", "kchamp");
  c.style.left = (5 * COLW) + "px"; c.style.top = ypx(yUnit[104]) + "px"; c.style.width = MATCHW + "px";
  if (champ) {
    const od = ownerDot(champ);
    c.innerHTML = `<img src="${FLAG(T.teams[champ].iso)}" style="width:46px;height:31px;border-radius:3px">` +
      `<div style="font-weight:800;margin-top:4px">${champ}</div>` +
      `<div class="owner" style="justify-content:center"><span class="dot" style="background:${od.color}"></span>${od.name}</div>`;
  } else {
    c.innerHTML = `<div style="font-size:30px">🏆</div><div style="font-weight:800;color:var(--gold)">TBD</div>`;
  }
  wrap.appendChild(c);
  v.appendChild(wrap);
}

/* ---------- schedule / calendar ---------- */
const DAY_FMT = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", weekday: "long", day: "numeric", month: "long" });
const TIME_FMT = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", hour: "numeric", minute: "2-digit", hour12: true });
function schedRow(f, now, nextTs) {
  const grp = T.teams[f.a]?.group;
  const m = getMatch(f.a, f.b);
  const played = m && m.state !== "pre";
  const live = m && m.state === "in";
  let sA = "", sB = "";
  if (played) { const flip = m.a !== f.a; sA = flip ? m.sb : m.sa; sB = flip ? m.sa : m.sb; }
  const winA = played && sA > sB, winB = played && sB > sA;
  const row = el("div", "schedrow" + (live ? " live" : "") +
    (!played && f.ts === nextTs ? " next" : "") + (!played && !live && f.ts < now ? " past" : ""));
  row.dataset.owned = (selectedOwners.size && (owned(f.a) || owned(f.b))) ? 1 : 0;
  const timeCell = live
    ? `<span class="schedtime"><span class="livebadge">LIVE</span></span>`
    : `<span class="schedtime">${TIME_FMT.format(new Date(f.ts * 1000))}</span>`;
  const mid = played ? `<span class="score">${sA}<span class="dash">–</span>${sB}</span>` : `<span class="vs">v</span>`;
  row.innerHTML = timeCell +
    `<span class="schedteam${winA ? " win" : ""}">${seedBadge(f.a)}<img src="${FLAG(T.teams[f.a]?.iso)}">${f.a}${ownerTag(f.a)}</span>` +
    mid +
    `<span class="schedteam${winB ? " win" : ""}">${seedBadge(f.b)}<img src="${FLAG(T.teams[f.b]?.iso)}">${f.b}${ownerTag(f.b)}</span>` +
    `<span class="schedgrp">${grp ? "Grp " + grp : ""}</span>`;
  return row;
}

function renderSchedule() {
  const v = $("#scheduleView"); if (!v) return; v.innerHTML = "";
  const tabs = el("div", "schedtabs");
  [["fixtures", "Fixtures"], ["results", "Results"]].forEach(([mode, label]) => {
    const b = el("button", "schedtab" + (schedMode === mode ? " active" : ""), label);
    b.onclick = () => { schedMode = mode; renderSchedule(); };
    tabs.appendChild(b);
  });
  v.appendChild(tabs);

  const now = Date.now() / 1000;
  const nextTs = (fixtures.find(f => f.ts > now) || {}).ts;

  let list;
  if (schedMode === "results") {
    // played games come from results.json (ESPN keeps every match) — Sportsbet's
    // fixtures list drops games once they kick off, so we can't use it here
    list = ((results && results.matches) || [])
      .filter(m => m.state !== "pre" && T.teams[m.a] && T.teams[m.b])
      .sort((a, b) => b.ts - a.ts);   // most recent first
    if (!list.length) { v.appendChild(el("p", "emptynote", "No games played yet — check back after the first kick-off.")); return; }
  } else {
    list = fixtures.slice();
    if (!list.length) { v.appendChild(el("p", "emptynote", "Fixtures unavailable.")); return; }
  }
  let lastDay = null;
  list.forEach(f => {
    const day = DAY_FMT.format(new Date(f.ts * 1000));
    if (day !== lastDay) { v.appendChild(el("div", "schedday", day)); lastDay = day; }
    v.appendChild(schedRow(f, now, nextTs));
  });
}

/* ---------- odds panel (teams + player slips) ---------- */
function renderOdds() {
  // teams
  const teams = Object.keys(probLatest).filter(t => T.teams[t]).sort((a, b) => probLatest[b] - probLatest[a]);
  const tb = $("#teamTable tbody"); tb.innerHTML = "";
  teams.forEach((t, i) => {
    const od = ownerDot(t), mv = teamMove(t), p = probLatest[t] ?? 0;
    const tr = el("tr"); tr.dataset.owned = owned(t);
    if (standing[t] && standing[t].out) tr.classList.add("out");
    if (shownTeam[t] != null && Math.abs(p - shownTeam[t]) > 1e-6) tr.classList.add("flash");
    shownTeam[t] = p;
    tr.innerHTML = `<td class="rank">${i + 1}</td>` +
      `<td><span class="team"><img src="${FLAG(T.teams[t].iso)}"><span class="odot" style="background:${od.color}" title="${od.name}"></span>${t}</span></td>` +
      `<td class="sparkcell">${sparkline(probSeries[t])}</td>` +
      `<td class="wp">${pct(t)}</td><td class="delta ${mv.cls}">${mv.txt}</td>`;
    tb.appendChild(tr);
  });
  // teams that can no longer win (dropped from the odds market): kept on but greyed
  // and parked at the bottom, seed preserved
  Object.keys(T.teams).filter(t => !(t in probLatest) && seed[t]).sort((a, b) => seed[a] - seed[b]).forEach(t => {
    const od = ownerDot(t);
    const tr = el("tr", "gone"); tr.dataset.owned = owned(t);
    tr.innerHTML = `<td class="rank">${seed[t]}</td>` +
      `<td><span class="team"><img src="${FLAG(T.teams[t].iso)}"><span class="odot" style="background:${od.color}" title="${od.name}"></span>${t}</span></td>` +
      `<td class="sparkcell"></td>` +
      `<td class="wp">out</td><td class="delta"></td>`;
    tb.appendChild(tr);
  });

  // player slips (accumulative)
  const players = Object.keys(T.owners).map(pl => {
    const ts = T.owners[pl].teams;
    return { pl, p: sumProb(ts, probLatest), pp: prev ? sumProb(ts, probPrev) : null };
  }).sort((a, b) => b.p - a.p);
  // each slip's rank ~24h ago (from the odds baseline) -> ladder movement
  const baseRank = {};
  Object.keys(T.owners).map(pl => ({ pl, pp: sumProb(T.owners[pl].teams, probPrev) }))
    .sort((a, b) => b.pp - a.pp).forEach((r, i) => baseRank[r.pl] = i + 1);
  const pb = $("#playerTable tbody"); pb.innerHTML = "";
  players.forEach((r, i) => {
    const mv = r.pp == null ? { cls: "flat", txt: "·" } : arrow((r.p - r.pp) * 100);
    const md = baseRank[r.pl] ? baseRank[r.pl] - (i + 1) : 0;
    const color = T.owners[r.pl].color;
    const tr = el("tr"); tr.dataset.owned = selectedOwners.size && selectedOwners.has(r.pl) ? 1 : 0;
    if (shownPlayer[r.pl] != null && Math.abs(r.p - shownPlayer[r.pl]) > 1e-6) tr.className = "flash";
    shownPlayer[r.pl] = r.p;
    const flags = T.owners[r.pl].teams.map(tm => {
      const out = isOut(tm) || (standing[tm] && standing[tm].out);
      return `<img class="${out ? "tmout" : ""}" src="${FLAG(T.teams[tm].iso)}" title="${tm}${out ? " · out" : ""}" alt="">`;
    }).join("");
    tr.innerHTML = `<td class="rank">${i + 1}${moveChip(md)}</td>` +
      `<td><div class="slip"><span class="team"><span class="odot" style="background:${color}"></span>${r.pl}</span>` +
      `<span class="sliptms">${flags}</span></div></td>` +
      `<td class="sparkcell">${sparkline(slipSeries[r.pl])}</td>` +
      `<td class="wp">${(r.p * 100).toFixed(1)}%</td><td class="delta ${mv.cls}">${mv.txt}</td>`;
    pb.appendChild(tr);
  });

  renderMoversView();

  // tab visibility
  $("#teamTable").classList.toggle("hidden", oddsTab !== "teams");
  $("#playerTable").classList.toggle("hidden", oddsTab !== "players");
  $("#moversView").classList.toggle("hidden", oddsTab !== "movers");
  $("#movers").classList.toggle("hidden", oddsTab === "movers");

  // 24h movers summary line (Teams / Player slips tabs)
  if (oddsTab !== "movers") {
    const src = oddsTab === "teams"
      ? teams.map(t => ({ n: t, d: (probLatest[t] - (probPrev[t] ?? probLatest[t])) * 100 }))
      : players.map(r => ({ n: r.pl, d: r.pp == null ? 0 : (r.p - r.pp) * 100 }));
    const mv = src.filter(m => Math.abs(m.d) > 0.05).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3);
    $("#movers").innerHTML = mv.length ? "Movers: " + mv.map(m => `<b>${m.n}</b> <span class="${m.d > 0 ? "up" : "down"}">${m.d > 0 ? "▲" : "▼"}${Math.abs(m.d).toFixed(1)}</span>`).join(" · ") : "No movement in the last 24h.";
  }
}

// "biggest movers of the tournament" — change in win% from the start of the
// retained history to now, with a sparkline showing the path. Toggle between
// Teams and Player slips; each shows the top risers + fallers.
function renderMoversView() {
  const v = $("#moversView"); if (!v) return;
  const teamsMode = moversTab !== "players";
  const src = teamsMode ? probSeries : slipSeries;
  const keys = teamsMode ? Object.keys(src).filter(t => T.teams[t]) : Object.keys(T.owners);
  const arr = keys.map(k => {
    const s = src[k]; if (!s || s.length < 2) return null;
    return { k, a: s[0].v, b: s[s.length - 1].v, d: (s[s.length - 1].v - s[0].v) * 100, s };
  }).filter(Boolean);
  const span = history.length ? (latest.timestamp - history[0].ts) : 0;
  const since = span > 0 ? `over the last ${ago(span).replace(" ago", "")}` : "so far";
  const tabs = `<div class="mvtabs">` +
    [["teams", "Teams"], ["players", "Player slips"]].map(([m, l]) =>
      `<button class="mvtab${moversTab === m ? " active" : ""}" data-mvtab="${m}">${l}</button>`).join("") +
    `</div>`;
  if (!arr.length || arr.every(m => Math.abs(m.d) < 0.05)) {
    v.innerHTML = tabs + `<p class='emptynote'>Odds have barely shifted ${since}. Biggest movers will appear here once prices start swinging — usually mid group-stage.</p>`;
    return wireMoversTabs(v);
  }
  const risers = arr.filter(m => m.d > 0.05).sort((x, y) => y.d - x.d).slice(0, 6);
  const fallers = arr.filter(m => m.d < -0.05).sort((x, y) => x.d - y.d).slice(0, 6);
  const icon = m => teamsMode
    ? `<img src="${FLAG(T.teams[m.k].iso)}" alt="">`
    : `<span class="mvdot" style="background:${T.owners[m.k].color}"></span>`;
  const ownedM = m => teamsMode ? owned(m.k) : (selectedOwners.size && selectedOwners.has(m.k) ? 1 : 0);
  const row = m => `<div class="mvrow" data-owned="${ownedM(m)}">` + icon(m) +
    `<span class="mvteam"><span class="mvnm">${m.k}</span>` +
    `<span class="mvsub">${(m.a * 100).toFixed(1)}<span class="arrowto">→</span>${(m.b * 100).toFixed(1)}%</span></span>` +
    `<span class="mvspark">${sparkline(m.s, { w: 62, h: 18 })}</span>` +
    `<span class="mvdelta ${m.d > 0 ? "up" : "down"}">${m.d > 0 ? "▲" : "▼"}${Math.abs(m.d).toFixed(1)}</span></div>`;
  const grp = (cls, label, rows) => `<div class="mvgroup"><h4 class="${cls}">${label}</h4>` +
    (rows.length ? rows.map(row).join("") : "<p class='emptynote'>None yet.</p>") + "</div>";
  v.innerHTML = tabs + `<div class="mvcap">Change in win% ${since}</div>` +
    grp("up", "▲ Shortened most", risers) + grp("down", "▼ Drifted most", fallers);
  wireMoversTabs(v);
}
function wireMoversTabs(v) {
  v.querySelectorAll(".mvtab").forEach(b => b.onclick = () => { moversTab = b.dataset.mvtab; renderMoversView(); });
}

/* ---------- next match box ---------- */
function fmtCountdown(sec) {
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function nmTeam(name) {
  const o = T.teams[name]?.owner, od = o ? T.owners[o] : null;
  const flag = T.teams[name] ? `<img src="${FLAG(T.teams[name].iso)}" alt="">` : "";
  const own = o ? `<span class="nm-owner"><span class="dot" style="background:${od.color}"></span>${o}</span>` : "";
  return `<span class="nmteam">${flag}${seedBadge(name)}<b>${name}</b>${own}</span>`;
}
function renderNextMatch() {
  const box = $("#nextmatch"); if (!box) return;
  // a live match takes priority over the next upcoming one (live overlay first)
  const liveM = Object.values(liveScores).find(m => m.state === "in" && T.teams[m.a] && T.teams[m.b])
    || (results && (results.matches || []).find(m => m.state === "in" && T.teams[m.a] && T.teams[m.b]));
  if (liveM) {
    const grp = T.teams[liveM.a]?.group;
    box.classList.add("livebox");
    box.innerHTML =
      `<span class="nmlabel live">LIVE NOW</span>` +
      `<span class="nmvs">${nmTeam(liveM.a)}<span class="score">${liveM.sa}<span class="dash">–</span>${liveM.sb}</span>${nmTeam(liveM.b)}</span>` +
      `<span class="nmtime">${grp ? `Group ${grp}` : ""}</span>`;
    return;
  }
  box.classList.remove("livebox");
  if (!fixtures.length) { box.innerHTML = "<span class='nmlabel'>Fixtures unavailable</span>"; return; }
  const now = Date.now() / 1000;
  const nx = fixtures.find(f => f.ts > now);
  if (!nx) { box.innerHTML = "<span class='nmlabel'>⏱ No upcoming matches</span>"; return; }
  const grp = T.teams[nx.a]?.group;
  box.innerHTML =
    `<span class="nmlabel">⏱ NEXT MATCH · in ${fmtCountdown(nx.ts - now)}</span>` +
    `<span class="nmvs">${nmTeam(nx.a)}<span class="vs">v</span>${nmTeam(nx.b)}</span>` +
    `<span class="nmtime">${AEST.format(new Date(nx.ts * 1000))} AEST${grp ? ` · Group ${grp}` : ""}</span>`;
}

function renderStatus() {
  if (!latest) return;
  $("#legend").textContent = "▲ shortening · ▼ drifting (last 24h)";
}

// subtle freshness footer in the odds panel. Catches the blind spot where the Pi
// serves a frozen file (Sportsbet blocked): the data still loads "live" but stops
// advancing, so we surface its age — dim when fresh, amber when stale, red offline.
function renderFreshness() {
  const foot = $("#dataFoot"); if (!foot || !latest) return;
  const offline = DATA_API && !piLive;
  const age = ageOverride != null ? ageOverride : Math.max(0, Date.now() / 1000 - (latest.timestamp || 0));
  const stale = !offline && age > STALE_SECS;
  foot.classList.toggle("offline", offline);
  foot.classList.toggle("stale", stale);
  const txt = offline
    ? `live data offline · showing last snapshot (${ago(age)})`
    : `odds updated ${ago(age)}`;
  foot.innerHTML = `<span class="fdot"></span><span class="ftxt">${txt}</span>`;
}

function renderAll() {
  document.body.classList.toggle("filtering", selectedOwners.size > 0);
  renderOwners(); renderStatus(); renderFreshness(); renderNextMatch(); renderGroups(); renderTable(); renderKnockout(); renderSchedule(); renderOdds(); renderPrizes(); renderSweeps();
}

/* ---------- load + poll ---------- */
async function refresh() {
  latest = await getJSON("data/odds_latest.json");
  try { prev = await getJSON("data/odds_prev.json"); } catch { prev = null; }
  try { fixtures = await getJSON("data/fixtures.json"); } catch { fixtures = []; }
  try { results = await getJSON("data/results.json"); } catch { results = null; }
  try { news = await getJSON("data/news.json"); } catch { news = null; }
  let hist = null;
  try { hist = await getJSON("data/odds_history.json"); } catch { hist = null; }
  history = (hist && hist.length) ? hist.filter(h => h && h.winner) : [];
  probLatest = fairProbs(latest.winner);
  // delta baseline = odds as of ~24h ago (so movement stays visible for a day);
  // fall back to the oldest history entry, then to the previous snapshot
  let baseWinner = prev ? prev.winner : null;
  if (hist && hist.length) {
    const target = latest.timestamp - 86400;
    let base = hist[0];                       // oldest (history is chronological)
    for (const h of hist) if (h.ts <= target) base = h;
    baseWinner = base.winner;
  }
  probPrev = baseWinner ? fairProbs(baseWinner) : {};
  // fixed "tournament seed": rank every team once from the fullest odds snapshot we
  // have (before any eliminations) so a team keeps its seed even after the bookie
  // drops it from the winner market. Lower decimal price = stronger = seed 1.
  seed = {};
  let seedRef = latest.winner || {};
  (history || []).forEach(h => { if (h.winner && Object.keys(h.winner).length > Object.keys(seedRef).length) seedRef = h.winner; });
  Object.keys(seedRef).filter(t => T.teams[t]).sort((a, b) => seedRef[a] - seedRef[b]).forEach((t, i) => seed[t] = i + 1);
  standing = {}; matchScore = {};
  if (results) {
    for (const L in results.groups) results.groups[L].forEach(r => standing[r.team] = r);
    (results.matches || []).forEach(m => { matchScore[pairKey(m.a, m.b)] = m; });
  }
  buildSeries();
  nextRefreshAt = Date.now() + REFRESH_MS;
  renderAll();
}

function setView() {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#groupsView").classList.toggle("hidden", view !== "groups");
  $("#tableView").classList.toggle("hidden", view !== "table");
  $("#knockoutView").classList.toggle("hidden", view !== "knockout");
  $("#scheduleView").classList.toggle("hidden", view !== "schedule");
  const pv = $("#prizesView"); if (pv) pv.classList.toggle("hidden", view !== "prizes");  // ITP only
  const sv = $("#sweepsView"); if (sv) sv.classList.toggle("hidden", view !== "sweeps");  // worldcupbracket only
  document.body.classList.toggle("duff-view", view === "prizes");   // card fits the board (no stretch)
}

function initTabs() {
  document.querySelectorAll(".tab").forEach(btn => btn.onclick = () => { view = btn.dataset.view; setView(); });
  document.querySelectorAll(".otab").forEach(btn => btn.onclick = () => {
    oddsTab = btn.dataset.otab;
    document.querySelectorAll(".otab").forEach(b => b.classList.toggle("active", b === btn));
    renderOdds();
  });
}

// ⓘ button + plain-English glossary modal (built here so it lives in the shared app.js)
function initInfo() {
  const bar = document.getElementById("topbar");
  if (!bar || document.getElementById("infoBtn")) return;
  const btn = el("button", "infobtn", "i");
  btn.id = "infoBtn"; btn.title = "What do the numbers mean?";
  bar.appendChild(btn);
  const modal = el("div", "infomodal hidden");
  modal.innerHTML =
    `<div class="infocard"><button class="infoclose" aria-label="Close">✕</button>` +
    `<h2>What do the numbers mean?</h2><dl>` +
    `<dt>Win %</dt><dd>Each team's chance of winning the <b>whole tournament</b>, from the bookies' outright odds (rescaled so all teams add up to 100%). Higher = more likely.</dd>` +
    `<dt>Outright odds</dt><dd>The bookmaker's price on a team to lift the trophy — not to win a single match. We convert that price into the Win %.</dd>` +
    `<dt>Seed</dt><dd>A team's strength ranking from the bookies' pre-tournament odds: <b>1</b> is the favourite, <b>48</b> the longest shot. It's fixed for the tournament, so a team keeps its seed even after it's knocked out.</dd>` +
    `<dt><span class="up">▲ Shortening</span></dt><dd>The team's odds have come <b>in</b> over the last 24h — it's now <b>more</b> likely to win. The number is the change in Win %.</dd>` +
    `<dt><span class="down">▼ Drifting</span></dt><dd>The odds have drifted <b>out</b> — the team is now <b>less</b> likely to win.</dd>` +
    `<dt>Player slips</dt><dd>Your overall chance: the Win % of all the teams you own, added together.</dd>` +
    `<dt>Table</dt><dd>Live group standings. The top two (green bar) qualify; greyed-out teams are knocked out.</dd>` +
    `<dt><span class="qbadge">Q</span> Qualified</dt><dd>This team is <b>mathematically guaranteed</b> a top-two group finish — already through to the Round of 32 even before its group's last games. In the bracket it sits in its slot provisionally; its exact position (and opponent) is locked in once the group finishes.</dd>` +
    `<dt>Live</dt><dd>Scores update in real time; the glowing card is a match in progress.</dd>` +
    `</dl><button class="tour-start">Take The Tour</button></div>`;
  document.body.appendChild(modal);
  const close = () => modal.classList.add("hidden");
  btn.onclick = () => modal.classList.remove("hidden");
  modal.querySelector(".infoclose").onclick = close;
  modal.querySelector(".tour-start").onclick = () => { close(); startTour(); };
  modal.addEventListener("click", e => { if (e.target === modal) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  if (location.hash === "#info") modal.classList.remove("hidden");
}

/* ---------- guided "coach marks" tour ---------- */
const TOUR = [
  { sel: ".tabs", title: "The views", text: "Switch between Groups, the live Table (standings), the Knockout bracket and the Schedule." },
  { sel: "#groupsView .trow .seed", title: "Seed", text: "A team's strength rank by the odds — <b>1</b> is the favourite, <b>48</b> the longest shot." },
  { sel: "#groupsView .trow .pct", title: "Win %", text: "This team's chance of winning the <b>whole tournament</b> (from the bookies' outright odds)." },
  { sel: "#groupsView .trow .delta", title: "24h movement", text: "<span class='up'>▲ green</span> = odds shortening (more likely); <span class='down'>▼ red</span> = drifting (less likely), vs 24h ago." },
  { sel: "#groupsView .trow .owner", title: "Owner", text: "Which player owns this team. Tap a player up the top to highlight all of theirs." },
  { sel: "#nextmatch", title: "Next / live match", text: "The next kick-off in AEST — or a live game with its score and a glowing border." },
  { sel: "#oddsPanel", title: "Live odds", text: "Every team ranked by chance to win, plus a <b>Player slips</b> tab ranking all of us by combined odds." },
];
let tourI = 0, tourEls = null, tourTarget = null;

function ensureTourEls() {
  if (tourEls) return tourEls;
  const ns = "http://www.w3.org/2000/svg";
  const overlay = el("div", "tour-overlay");
  const spot = el("div", "tour-spot");
  const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "tour-svg");
  const line = document.createElementNS(ns, "line"); line.setAttribute("class", "tour-line");
  const dot = document.createElementNS(ns, "circle"); dot.setAttribute("class", "tour-dot"); dot.setAttribute("r", "5");
  svg.append(line, dot);
  const pop = el("div", "tour-pop");
  overlay.onclick = endTour;
  pop.onclick = e => e.stopPropagation();
  document.body.append(overlay, spot, svg, pop);
  window.addEventListener("resize", repositionTour);
  window.addEventListener("scroll", repositionTour, true);
  return (tourEls = { overlay, spot, svg, line, dot, pop });
}

function startTour() {
  view = "groups"; setView();          // tour targets live on the Groups view
  ensureTourEls(); tourI = 0; showStep();
}

function showStep() {
  const step = TOUR[tourI];
  const t = document.querySelector(step.sel);
  if (!t) { if (tourI < TOUR.length - 1) { tourI++; return showStep(); } return endTour(); }
  tourTarget = t;
  t.scrollIntoView({ block: "center", inline: "nearest" });
  requestAnimationFrame(() => positionStep());
}

function positionStep() {
  if (!tourEls || !tourTarget) return;
  const step = TOUR[tourI], { spot, pop, line, dot } = tourEls;
  const r = tourTarget.getBoundingClientRect(), pad = 6, vw = innerWidth, vh = innerHeight;
  spot.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px;`;
  pop.innerHTML = `<h3>${step.title}</h3><p>${step.text}</p>` +
    `<div class="tour-nav"><span class="step">${tourI + 1} / ${TOUR.length}</span><span>` +
    `<button class="tour-btn ghost" data-act="prev"${tourI ? "" : " disabled"}>Back</button>` +
    `<button class="tour-btn" data-act="next">${tourI === TOUR.length - 1 ? "Done" : "Next"}</button></span></div>`;
  pop.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    tourI += b.dataset.act === "next" ? 1 : -1;
    if (tourI >= TOUR.length) return endTour();
    if (tourI < 0) tourI = 0;
    showStep();
  });
  const pr = pop.getBoundingClientRect();
  let left = Math.min(Math.max(8, r.left), vw - pr.width - 8);
  const below = r.bottom + 14 + pr.height < vh;
  let top = below ? r.bottom + 14 : Math.max(8, r.top - pr.height - 14);
  pop.style.top = top + "px"; pop.style.left = left + "px";
  // connector line from the popup edge to the highlighted box
  const px = left + pr.width / 2, py = below ? top : top + pr.height;
  const ty = below ? r.bottom : r.top, tx = Math.min(Math.max(r.left + r.width / 2, left), left + pr.width);
  line.setAttribute("x1", px); line.setAttribute("y1", py);
  line.setAttribute("x2", tx); line.setAttribute("y2", ty);
  dot.setAttribute("cx", tx); dot.setAttribute("cy", ty);
}

function repositionTour() { if (tourEls && tourEls.overlay.isConnected) positionStep(); }

function endTour() {
  if (!tourEls) return;
  window.removeEventListener("resize", repositionTour);
  window.removeEventListener("scroll", repositionTour, true);
  Object.values(tourEls).forEach(n => n.remove && n.remove());
  tourEls = null; tourTarget = null;
}


function tick() {
  if (!latest) return;
  renderStatus(); renderFreshness(); renderNextMatch();
  if (Date.now() >= nextRefreshAt) refresh().catch(console.error);
}

function applyDeepLink() {
  const q = new URLSearchParams(location.search);
  const hv = location.hash.replace("#", "");
  const qv = q.get("view");
  const views = ["groups", "table", "knockout", "schedule", "prizes", "sweeps"];
  if (views.includes(qv)) view = qv;
  else if (views.includes(hv)) view = hv;
  if (["players", "movers"].includes(q.get("tab"))) oddsTab = q.get("tab");
  if (q.get("sched") === "results") schedMode = "results";
  // ?age=<secs> previews the freshness footer (fresh/stale) without waiting
  const ageQ = parseInt(q.get("age"), 10);
  if (!Number.isNaN(ageQ)) ageOverride = ageQ;
  (q.get("owner") || "").split(",").map(s => s.trim()).filter(Boolean).forEach(o => selectedOwners.add(o));
}

async function load() {
  T = await getJSON("data/tournament.json");
  [...selectedOwners].forEach(o => { if (!(o in T.owners)) selectedOwners.delete(o); });
  await refresh();
  setView();
  document.querySelectorAll(".otab").forEach(b => b.classList.toggle("active", b.dataset.otab === oddsTab));
}

(function init() {
  try { initTabs(); applyDeepLink(); initInfo(); } catch (e) { /* keep going even if a control is missing */ }
  let started = false;
  const start = () => load()
    .then(() => { if (!started) { started = true; setInterval(tick, 1000); fetchLive(); scheduleLive(); if (location.hash === "#tour") setTimeout(startTour, 300); const dm = new URLSearchParams(location.search).get("demo"); if (dm) setTimeout(() => demoEvent(dm), 300); } })
    .catch(err => {
      console.error(err);
      const n = document.getElementById("nextmatch");
      if (n) n.textContent = "Couldn't load data — retrying…";
      setTimeout(start, 4000);   // transient failures (deploy races, flaky net) self-heal
    });
  start();
})();
