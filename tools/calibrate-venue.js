/**
 * 新しく手に入った項目（会場・K/O時刻・曜日）が予測に効くかを試す。
 *
 *   node tools/calibrate-venue.js
 *
 * 効くかどうかは分からない。だから測る。
 * 採用の条件は tune.js と同じで、学習区間と検証区間の両方で log loss が下がること。
 * 下がらなければ「効かなかった」と記録して入れない。それも成果である。
 *
 * 試すもの
 *   1. 本拠地以外での「ホーム」試合（国立開催など）→ ホームアドバンテージが薄れるか
 *   2. 平日開催（水曜など）→ 得点傾向が変わるか
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { load, dayNum } = require("./lib/data");
const { run, J1 } = require("./backtest");

const params = load("params.json");
const P = params.model;

/* ------------------------------------------------------- 本拠地を決める */

/**
 * 各クラブ・各シーズンの本拠地を「ホーム戦でいちばん多く使った会場」とする。
 * 改修による一時移転もあるので、シーズンごとに決める。
 */
const HOME_VENUE = new Map();
for (const s of [...new Set(J1.map((m) => m.s))]) {
  for (const c of [...new Set(J1.filter((m) => m.s === s).map((m) => m.h))]) {
    const cnt = new Map();
    for (const m of J1) {
      if (m.s !== s || m.h !== c || !m.venue) continue;
      cnt.set(m.venue, (cnt.get(m.venue) ?? 0) + 1);
    }
    const top = [...cnt].sort((a, b) => b[1] - a[1])[0];
    if (top) HOME_VENUE.set(`${c}|${s}`, { venue: top[0], n: top[1], total: cnt.size });
  }
}

const isAway = (m) => {
  const hv = HOME_VENUE.get(`${m.h}|${m.s}`);
  return hv ? m.venue !== hv.venue : false;
};

const offVenue = J1.filter(isAway);
console.log(`=== 本拠地以外での「ホーム」試合 ===`);
console.log(`${offVenue.length} / ${J1.length}試合（${(offVenue.length / J1.length * 100).toFixed(1)}%）`);

/** 本拠地かどうかで、ホームチームの勝率・得点がどう違うか */
function summarize(rows, label) {
  const n = rows.length;
  if (!n) return;
  const hw = rows.filter((m) => m.hg > m.ag).length / n;
  const gh = rows.reduce((s, m) => s + m.hg, 0) / n;
  const ga = rows.reduce((s, m) => s + m.ag, 0) / n;
  console.log(`  ${label.padEnd(14)} ${String(n).padStart(4)}試合  ホーム勝率 ${(hw * 100).toFixed(1)}%  ` +
    `得点 ${gh.toFixed(3)} - ${ga.toFixed(3)}`);
  return { n, hw, gh, ga };
}
const atHome = summarize(J1.filter((m) => !isAway(m)), "本拠地");
const atOther = summarize(offVenue, "本拠地以外");

/* 上の差は「強いクラブほど国立を使う」などの偏りを含む。
   モデルの期待得点で割って、地力の違いを打ち消してから見る */
console.log("\n強さの違いを打ち消した比較（実測 ÷ 期待）:");
const need = new Map();
for (const Y of [...new Set(J1.map((m) => m.s))].filter((y) => y >= 2018)) {
  const past = J1.filter((m) => m.s < Y);
  const hasHistory = new Set(past.flatMap((m) => [m.h, m.a]));
  const M = require("./lib/model");
  const fit = M.fitRatings(past, [], Y, P, load("promoted.json").promotedAverage, hasHistory);
  for (const m of J1.filter((x) => x.s === Y)) {
    const b = M.baseLambda(fit, m.h, m.a);
    need.set(m, { eh: b.lh, ea: b.la });
  }
}
for (const [label, rows] of [["本拠地", J1.filter((m) => m.s >= 2018 && !isAway(m))],
                             ["本拠地以外", J1.filter((m) => m.s >= 2018 && isAway(m))]]) {
  let gf = 0, ga = 0, ef = 0, ea = 0;
  for (const m of rows) {
    const e = need.get(m); if (!e) continue;
    gf += m.hg; ga += m.ag; ef += e.eh; ea += e.ea;
  }
  console.log(`  ${label.padEnd(14)} ${String(rows.length).padStart(4)}試合  ` +
    `ホーム得点比 ${(gf / ef).toFixed(3)}  ホーム失点比 ${(ga / ea).toFixed(3)}  ` +
    `±${(Math.sqrt(ef) / ef).toFixed(3)}`);
}

/* ------------------------------------------------------- バックテストで採否 */

/**
 * 本拠地以外なら、ホームの期待得点に v を、相手に 1/v を掛ける。
 * v=1 なら補正なし。
 */
function withVenue(v) {
  return (m) => (isAway(m) ? { h: v, a: 1 / v } : { h: 1, a: 1 });
}

console.log("\n=== 本拠地以外での補正 v をバックテストで決める ===");
console.log("  v      学習(2018-22)  検証(2023-25)   全体      両区間で改善");
const base = { tr: run(P, 0).ll };
const trBase = run(P, 0, false, null, [2018, 2022]).ll;
const teBase = run(P, 0, false, null, [2023, 2025]).ll;
const rows = [{ v: 1.0, train: trBase, test: teBase, all: base.tr }];
console.log(`  1.00   ${trBase.toFixed(5)}       ${teBase.toFixed(5)}        ${base.tr.toFixed(5)}   —`);

for (const v of [0.94, 0.96, 0.98, 1.02, 1.04]) {
  const tr = run(P, 0, false, null, [2018, 2022], null, withVenue(v)).ll;
  const te = run(P, 0, false, null, [2023, 2025], null, withVenue(v)).ll;
  const al = run(P, 0, false, null, null, null, withVenue(v)).ll;
  const both = tr < trBase - 1e-9 && te < teBase - 1e-9;
  rows.push({ v, train: tr, test: te, all: al, both });
  console.log(`  ${v.toFixed(2)}   ${tr.toFixed(5)}       ${te.toFixed(5)}        ${al.toFixed(5)}   ${both ? "✅" : "—"}`);
}

const win = rows.filter((r) => r.both);
const best = win.length ? win.reduce((a, b) => (b.train + b.test < a.train + a.test ? b : a)) : rows[0];
console.log(win.length
  ? `\n→ 採用: v = ${best.v}`
  : `\n→ 採用しない（v = 1）。本拠地以外の開催でホームアドバンテージが変わる証拠は得られなかった。`);

/* ------------------------------------------------------- 平日開催 */

console.log("\n=== 曜日ごとの傾向（強さの違いを打ち消した比較）===");
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const byDow = new Map();
for (const m of J1.filter((x) => x.s >= 2018)) {
  const e = need.get(m); if (!e) continue;
  const d = (dayNum(m.date) + 4) % 7; // 1970-01-01 は木曜
  const k = WD[d];
  const o = byDow.get(k) ?? { n: 0, gf: 0, ga: 0, ef: 0, ea: 0 };
  o.n++; o.gf += m.hg; o.ga += m.ag; o.ef += e.eh; o.ea += e.ea;
  byDow.set(k, o);
}
console.log("  曜日   件数   ホーム得点比  ホーム失点比");
for (const k of ["月", "火", "水", "木", "金", "土", "日"]) {
  const o = byDow.get(k); if (!o) continue;
  console.log(`  ${k}    ${String(o.n).padStart(4)}   ${(o.gf / o.ef).toFixed(3)}         ${(o.ga / o.ea).toFixed(3)}`);
}

/* ------------------------------------------------------- 保存 */

const out = {
  note: "会場・曜日が予測に効くかを試した記録。効かなかったものも残す",
  offVenue: {
    matches: offVenue.length, total: J1.length,
    rawHomeWinRate: { atHome: atHome.hw, atOther: atOther.hw },
    grid: rows,
    adopted: win.length > 0,
    factor: win.length ? best.v : 1,
    verdict: win.length
      ? `本拠地以外では ×${best.v}`
      : "本拠地以外の開催による差は、学習・検証の両区間で一貫した改善にならなかった。補正しない",
  },
  byDayOfWeek: Object.fromEntries([...byDow].map(([k, o]) =>
    [k, { n: o.n, atk: o.gf / o.ef, def: o.ga / o.ea }])),
};
fs.writeFileSync(path.join(__dirname, "..", "data", "calib-venue.json"), JSON.stringify(out, null, 2) + "\n");
console.log("\n→ data/calib-venue.json に保存");
