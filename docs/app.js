"use strict";

const REFRESH_MS = 60000;
const FLAG = iso => `https://flagcdn.com/w40/${iso}.png`;

// bracket geometry (px)
const H = 64, HEADER_H = 28, MATCHW = 170, HGAP = 40, COLW = MATCHW + HGAP;
const ROUND_COL = { R32: 0, R16: 1, QF: 2, SF: 3, Final: 4 };

let T = null;
let latest = null, prev = null;
let probLatest = {}, probPrev = {};
let selectedOwners = new Set();
let view = "groups";
let oddsTab = "teams";
let nextRefreshAt = 0;
let shownTeam = {}, shownPlayer = {};   // last-rendered values, to flash on change
let fixtures = [];
let results = null, standing = {}, matchScore = {};   // committed ESPN standings + scores
let liveScores = {};                                   // live overlay fetched client-side
const pairKey = (a, b) => [a, b].sort().join("|");
const getMatch = (a, b) => liveScores[pairKey(a, b)] || matchScore[pairKey(a, b)];
const ESPN_SB = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const ESPN_NAME = { "Bosnia-Herzegovina": "Bosnia & Herzegovina", "Congo DR": "DR Congo", "Curaçao": "Curacao", "United States": "USA" };
const espnNorm = n => ESPN_NAME[n] || n;

// live scores straight from ESPN (CORS-enabled) every 60s — no push/deploy lag
async function fetchLive() {
  try {
    const r = await fetch(`${ESPN_SB}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    const next = {};
    (d.events || []).forEach(ev => {
      const c = (ev.competitions || [])[0]; if (!c) return;
      const cs = c.competitors || [];
      const home = cs.find(x => x.homeAway === "home"), away = cs.find(x => x.homeAway === "away");
      if (!home || !away) return;
      const a = espnNorm(home.team.displayName), b = espnNorm(away.team.displayName);
      next[pairKey(a, b)] = { a, b, sa: parseInt(home.score) || 0, sb: parseInt(away.score) || 0,
                              state: ev.status?.type?.state || "pre" };
    });
    liveScores = next;
    if (T) { renderNextMatch(); renderSchedule(); }
  } catch (e) { /* offline / ESPN hiccup — keep last known */ }
}
let seed = {};                          // team -> overall seed (1 = strongest by odds)
const AEST = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

async function getJSON(path) {
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
function teamMove(team) {
  if (probPrev[team] == null) return { cls: "flat", txt: "·" };
  return arrow(((probLatest[team] ?? 0) - probPrev[team]) * 100);
}
const pct = team => `${((probLatest[team] ?? 0) * 100).toFixed(1)}%`;
const owned = team => selectedOwners.size && T.teams[team] && selectedOwners.has(T.teams[team].owner) ? 1 : 0;
const ownerDot = team => {
  const o = T.teams[team]?.owner;
  return { color: o ? T.owners[o].color : "#555", name: o || "—" };
};
const sumProb = (teams, map) => teams.reduce((s, t) => s + (map[t] ?? 0), 0);
const seedBadge = team => seed[team] ? `<span class="seed" title="Seed ${seed[team]} of 48">${seed[team]}</span>` : "";

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
  const row = el("div", "trow");
  row.dataset.owned = owned(team);
  row.innerHTML =
    `<img src="${FLAG(T.teams[team].iso)}" alt="">` +
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
  Object.keys(results.groups).sort().forEach(L => {
    const card = el("div", "ltcard", `<h3>Group ${L}</h3>`);
    const body = results.groups[L].map((r, i) => {
      const od = ownerDot(r.team);
      const cls = (r.out ? "out" : "") + (i < 2 ? " qual" : "");
      return `<tr class="${cls}" data-owned="${owned(r.team)}">` +
        `<td class="pos">${i + 1}</td>` +
        `<td class="lt-team"><img src="${FLAG(T.teams[r.team]?.iso)}">` +
        `<span class="lt-nm">${r.team}</span><span class="otag"><span class="dot" style="background:${od.color}"></span>${od.name}</span></td>` +
        `<td>${r.P}</td><td class="hidem">${r.W}</td><td class="hidem">${r.D}</td><td class="hidem">${r.L}</td>` +
        `<td class="hidem">${r.GF}</td><td class="hidem">${r.GA}</td>` +
        `<td>${r.GD > 0 ? "+" + r.GD : r.GD}</td><td class="pts">${r.Pts}</td></tr>`;
    }).join("");
    card.innerHTML +=
      `<table class="ltable"><thead><tr>` +
      `<th></th><th class="lt-team">Team</th><th>P</th><th class="hidem">W</th><th class="hidem">D</th>` +
      `<th class="hidem">L</th><th class="hidem">GF</th><th class="hidem">GA</th><th>GD</th><th>Pts</th>` +
      `</tr></thead><tbody>${body}</tbody></table>`;
    v.appendChild(card);
  });
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
function line(parent, x, y, w, h, cls) {
  const d = el("div", cls || "kline");
  d.style.left = x + "px"; d.style.top = y + "px"; d.style.width = w + "px"; d.style.height = h + "px";
  parent.appendChild(d);
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

  // placeholder match boxes
  T.knockout.forEach(m => {
    const box = el("div", "kbox");
    box.style.left = ROUND_COL[m.round] * COLW + "px";
    box.style.top = ypx(yUnit[m.id]) + "px";
    box.style.width = MATCHW + "px";
    box.appendChild(pslot(placeholderText(m.home, matchById)));
    box.appendChild(pslot(placeholderText(m.away, matchById)));
    wrap.appendChild(box);
  });

  // winner placeholder
  const c = el("div", "kchamp");
  c.style.left = (5 * COLW) + "px"; c.style.top = ypx(yUnit[104]) + "px"; c.style.width = MATCHW + "px";
  c.innerHTML = `<div style="font-size:30px">🏆</div><div style="font-weight:800;color:var(--gold)">TBD</div>`;
  wrap.appendChild(c);
  v.appendChild(wrap);
}

/* ---------- schedule / calendar ---------- */
const DAY_FMT = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", weekday: "long", day: "numeric", month: "long" });
const TIME_FMT = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", hour: "numeric", minute: "2-digit", hour12: true });
function renderSchedule() {
  const v = $("#scheduleView"); if (!v) return; v.innerHTML = "";
  if (!fixtures.length) { v.innerHTML = "<p class='emptynote'>Fixtures unavailable.</p>"; return; }
  const now = Date.now() / 1000;
  const nextTs = (fixtures.find(f => f.ts > now) || {}).ts;
  let lastDay = null;
  fixtures.forEach(f => {
    const day = DAY_FMT.format(new Date(f.ts * 1000));
    if (day !== lastDay) { v.appendChild(el("div", "schedday", day)); lastDay = day; }
    const grp = T.teams[f.a]?.group;
    const m = getMatch(f.a, f.b);
    const played = m && m.state !== "pre";
    const live = m && m.state === "in";
    // results store score by (a,b) sorted — figure out which side is f.a
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
    v.appendChild(row);
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
      `<td class="wp">${pct(t)}</td><td class="delta ${mv.cls}">${mv.txt}</td>`;
    tb.appendChild(tr);
  });

  // player slips (accumulative)
  const players = Object.keys(T.owners).map(pl => {
    const ts = T.owners[pl].teams;
    return { pl, p: sumProb(ts, probLatest), pp: prev ? sumProb(ts, probPrev) : null };
  }).sort((a, b) => b.p - a.p);
  const pb = $("#playerTable tbody"); pb.innerHTML = "";
  players.forEach((r, i) => {
    const mv = r.pp == null ? { cls: "flat", txt: "·" } : arrow((r.p - r.pp) * 100);
    const color = T.owners[r.pl].color;
    const tr = el("tr"); tr.dataset.owned = selectedOwners.size && selectedOwners.has(r.pl) ? 1 : 0;
    if (shownPlayer[r.pl] != null && Math.abs(r.p - shownPlayer[r.pl]) > 1e-6) tr.className = "flash";
    shownPlayer[r.pl] = r.p;
    tr.innerHTML = `<td class="rank">${i + 1}</td>` +
      `<td><span class="team"><span class="odot" style="background:${color}"></span>${r.pl}</span></td>` +
      `<td class="wp">${(r.p * 100).toFixed(1)}%</td><td class="delta ${mv.cls}">${mv.txt}</td>`;
    pb.appendChild(tr);
  });

  // movers + tab visibility
  $("#teamTable").classList.toggle("hidden", oddsTab !== "teams");
  $("#playerTable").classList.toggle("hidden", oddsTab !== "players");
  $(".otitle").textContent = oddsTab === "teams" ? "live · to win the cup" : "live · combined slip odds";
  if (oddsTab === "teams") {
    const mv = teams.map(t => ({ n: t, d: (probLatest[t] - (probPrev[t] ?? probLatest[t])) * 100 }))
      .filter(m => Math.abs(m.d) > 0.05).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3);
    $("#movers").innerHTML = mv.length ? "Movers: " + mv.map(m => `<b>${m.n}</b> <span class="${m.d > 0 ? "up" : "down"}">${m.d > 0 ? "▲" : "▼"}${Math.abs(m.d).toFixed(1)}</span>`).join(" · ") : "No movement since last refresh.";
  } else {
    const mv = players.map(r => ({ n: r.pl, d: r.pp == null ? 0 : (r.p - r.pp) * 100 }))
      .filter(m => Math.abs(m.d) > 0.05).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3);
    $("#movers").innerHTML = mv.length ? "Movers: " + mv.map(m => `<b>${m.n}</b> <span class="${m.d > 0 ? "up" : "down"}">${m.d > 0 ? "▲" : "▼"}${Math.abs(m.d).toFixed(1)}</span>`).join(" · ") : "No movement since last refresh.";
  }
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
      `<span class="nmlabel live">🔴 LIVE NOW</span>` +
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

function renderAll() {
  document.body.classList.toggle("filtering", selectedOwners.size > 0);
  renderOwners(); renderStatus(); renderNextMatch(); renderGroups(); renderTable(); renderKnockout(); renderSchedule(); renderOdds();
}

/* ---------- load + poll ---------- */
async function refresh() {
  latest = await getJSON("data/odds_latest.json");
  try { prev = await getJSON("data/odds_prev.json"); } catch { prev = null; }
  try { fixtures = await getJSON("data/fixtures.json"); } catch { fixtures = []; }
  try { results = await getJSON("data/results.json"); } catch { results = null; }
  let hist = null;
  try { hist = await getJSON("data/odds_history.json"); } catch { hist = null; }
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
  seed = {};
  Object.keys(probLatest).sort((a, b) => probLatest[b] - probLatest[a]).forEach((t, i) => seed[t] = i + 1);
  standing = {}; matchScore = {};
  if (results) {
    for (const L in results.groups) results.groups[L].forEach(r => standing[r.team] = r);
    (results.matches || []).forEach(m => { matchScore[pairKey(m.a, m.b)] = m; });
  }
  nextRefreshAt = Date.now() + REFRESH_MS;
  renderAll();
}

function setView() {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#groupsView").classList.toggle("hidden", view !== "groups");
  $("#tableView").classList.toggle("hidden", view !== "table");
  $("#knockoutView").classList.toggle("hidden", view !== "knockout");
  $("#scheduleView").classList.toggle("hidden", view !== "schedule");
}

function initTabs() {
  document.querySelectorAll(".tab").forEach(btn => btn.onclick = () => { view = btn.dataset.view; setView(); });
  document.querySelectorAll(".otab").forEach(btn => btn.onclick = () => {
    oddsTab = btn.dataset.otab;
    document.querySelectorAll(".otab").forEach(b => b.classList.toggle("active", b === btn));
    renderOdds();
  });
}

function tick() {
  if (!latest) return;
  renderStatus(); renderNextMatch();
  if (Date.now() >= nextRefreshAt) refresh().catch(console.error);
}

function applyDeepLink() {
  const q = new URLSearchParams(location.search);
  const hv = location.hash.replace("#", "");
  const qv = q.get("view");
  const views = ["groups", "table", "knockout", "schedule"];
  if (views.includes(qv)) view = qv;
  else if (views.includes(hv)) view = hv;
  if (q.get("tab") === "players") oddsTab = "players";
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
  try { initTabs(); applyDeepLink(); } catch (e) { /* keep going even if a control is missing */ }
  let started = false;
  const start = () => load()
    .then(() => { if (!started) { started = true; setInterval(tick, 1000); fetchLive(); setInterval(fetchLive, 60000); } })
    .catch(err => {
      console.error(err);
      const n = document.getElementById("nextmatch");
      if (n) n.textContent = "Couldn't load data — retrying…";
      setTimeout(start, 4000);   // transient failures (deploy races, flaky net) self-heal
    });
  start();
})();
