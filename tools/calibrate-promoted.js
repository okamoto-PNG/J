/**
 * 昇格クラブを J2 の成績から評価する。
 *
 *   node tools/calibrate-promoted.js
 *
 * これまで（解説.md 5章）は、履歴の無いクラブを
 * 「過去の昇格クラブ25クラブの平均像」という1組の値に寄せていた。
 * つまり 水戸 と 千葉 が同じ強さとして扱われていた。
 *
 * J2 のデータが手に入ったので、
 *   「J2でどれくらい強かったか」→「J1でどれくらいやれるか」
 * の変換を、過去の昇格クラブから実測して置き換える。
 *
 * 検証は必ず二段構え。
 *   1) 回帰で J2 の強さが J1 の成績を説明するか見る
 *   2) 実際にバックテストの log loss が下がるか確かめる（下がらなければ採用しない）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { load, dayNum } = require("./lib/data");
const S = require("./lib/season").require();
const M = require("./lib/model");
const { run } = require("./backtest");

const PARAMS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "params.json"), "utf8"));
const P = PARAMS.model;

const j1 = load("j1-matches.json");
const j2 = load("j2-matches.json").filter((m) => m.hg != null);

/* ------------------------------------------------- 昇格クラブの平均像を測り直す */

/**
 * 「J2から上がってきたクラブの1年目」をすべて集めて、ホーム/アウェイ別に平均を取る。
 *
 * 解説.md 5章にあるとおり、ホームとアウェイでリーグ平均得点が違う（1.38 対 1.21）ので、
 * 1つの倍率を両方に当てるとアウェイの攻撃力を過大評価する。必ず4値に分ける。
 */
function measurePromotedAverage() {
  const seasons = [...new Set(j1.map((m) => m.s))].sort();
  let hGF = 0, hGA = 0, hN = 0, aGF = 0, aGA = 0, aN = 0;
  let lgHG = 0, lgAG = 0, lgN = 0;
  const clubs = [];
  for (const Y of seasons.slice(1)) {
    const prev = new Set(j1.filter((m) => m.s === Y - 1).flatMap((m) => [m.h, m.a]));
    const now = j1.filter((m) => m.s === Y);
    const nowClubs = new Set(now.flatMap((m) => [m.h, m.a]));
    const up = [...nowClubs].filter((c) => !prev.has(c));
    if (!up.length) continue;
    clubs.push(...up.map((c) => `${Y} ${c}`));
    // そのシーズンのリーグ平均（比較の分母）
    for (const m of now) { lgHG += m.hg; lgAG += m.ag; lgN++; }
    for (const m of now) {
      if (up.includes(m.h)) { hGF += m.hg; hGA += m.ag; hN++; }
      if (up.includes(m.a)) { aGF += m.ag; aGA += m.hg; aN++; }
    }
  }
  const lgH = lgHG / lgN, lgA = lgAG / lgN;
  return {
    atkH: (hGF / hN) / lgH, defH: (hGA / hN) / lgA,
    atkA: (aGF / aN) / lgA, defA: (aGA / aN) / lgH,
    clubs, nClubs: clubs.length, nMatches: hN + aN, lgH, lgA,
  };
}

const AVG = measurePromotedAverage();
const PROMOTED = { atkH: AVG.atkH, defH: AVG.defH, atkA: AVG.atkA, defA: AVG.defA };

console.log("=== 昇格クラブの平均像（公式データで測り直し）===");
console.log(`対象 ${AVG.nClubs}クラブ・${AVG.nMatches}試合ぶんの出場`);
console.log(`リーグ平均得点  ホーム ${AVG.lgH.toFixed(3)} / アウェイ ${AVG.lgA.toFixed(3)}`);
console.log(`  atkH ${AVG.atkH.toFixed(4)}   defH ${AVG.defH.toFixed(4)}`);
console.log(`  atkA ${AVG.atkA.toFixed(4)}   defA ${AVG.defA.toFixed(4)}`);
console.log(`（従来値 atkH 0.8797 / defH 1.0963 / atkA 0.8456 / defA 1.0362）`);

/* ------------------------------------------------- リーグ別の生の攻守力 */

/**
 * 指定リーグの試合から、シーズン Y 時点の攻守力を出す。
 * リーグ平均で正規化するので、J1 と J2 の得点水準の違いは吸収される。
 */
function ratingsAt(matches, Y, halfLife = P.HALF_LIFE, shrink = P.SHRINK) {
  const T = {};
  const t = (k) => (T[k] ??= { hGF: 0, hGA: 0, hN: 0, aGF: 0, aGA: 0, aN: 0 });
  let tHG = 0, tAG = 0, tN = 0;
  for (const m of matches) {
    if (m.s >= Y) continue;
    const w = Math.pow(0.5, (Y - m.s) / halfLife);
    const H = t(m.h), A = t(m.a);
    H.hGF += w * m.hg; H.hGA += w * m.ag; H.hN += w;
    A.aGF += w * m.ag; A.aGA += w * m.hg; A.aN += w;
    tHG += w * m.hg; tAG += w * m.ag; tN += w;
  }
  if (!tN) return null;
  const lgH = tHG / tN, lgA = tAG / tN, K = shrink, R = {};
  for (const [k, v] of Object.entries(T)) {
    R[k] = {
      atkH: ((v.hGF + K * lgH) / (v.hN + K)) / lgH,
      defH: ((v.hGA + K * lgA) / (v.hN + K)) / lgA,
      atkA: ((v.aGF + K * lgA) / (v.aN + K)) / lgA,
      defA: ((v.aGA + K * lgH) / (v.aN + K)) / lgH,
      n: v.hN + v.aN,
    };
  }
  return R;
}

/**
 * シーズン Y に実際に記録した攻守力（結果を見た値。学習には使わず、回帰の目的変数にする）。
 * 縮小推定なし・時間減衰なしの素の値。
 */
function observedIn(matches, Y) {
  return ratingsAt(matches.filter((m) => m.s === Y), Y + 1, 1e9, 0);
}

/* ------------------------------------------------- 昇格クラブを拾う */

const SEASONS = [...new Set(j1.map((m) => m.s))].sort();
const samples = [];

for (const Y of SEASONS.slice(1)) {
  const inJ1Before = new Set(j1.filter((m) => m.s < Y).flatMap((m) => [m.h, m.a]));
  const inJ1Now = new Set(j1.filter((m) => m.s === Y).flatMap((m) => [m.h, m.a]));
  const newcomers = [...inJ1Now].filter((c) => !inJ1Before.has(c));
  if (!newcomers.length) continue;

  const j2r = ratingsAt(j2, Y);
  const obs = observedIn(j1, Y);     // Y シーズンに J1 で実際に記録した攻守力
  if (!j2r || !obs) continue;

  for (const c of newcomers) {
    if (!j2r[c] || !obs[c]) continue;
    samples.push({ season: Y, club: c, j2: j2r[c], j1: obs[c] });
  }
}

console.log(`昇格クラブの標本 ${samples.length}件（${samples[0]?.season}-${samples[samples.length-1]?.season}）`);
console.log(samples.map((s) => `${s.season} ${s.club}`).join(" / "));

/* ------------------------------------------------- 回帰 */

/** 最小二乗で y = a + b*(x-1) を当てる。b が「J2の強さがJ1に持ち越される割合」 */
function fit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * (mx - 1), b, r: sxx * syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0, mean: my };
}

console.log("\n=== J2の攻守力は J1での成績を説明するか ===");
console.log("項目    J1平均   持ち越し係数 b   相関 r");
const COEF = {};
for (const k of ["atkH", "defH", "atkA", "defA"]) {
  const f = fit(samples.map((s) => s.j2[k]), samples.map((s) => s.j1[k]));
  COEF[k] = { a: f.a, b: f.b };
  console.log(`${k.padEnd(6)}  ${f.mean.toFixed(4)}   ${f.b >= 0 ? " " : ""}${f.b.toFixed(3)}          ${f.r >= 0 ? " " : ""}${f.r.toFixed(3)}`);
}

/* ------------------------------------------------- バックテストで採否を決める */

/* J2 側の見方（何年ぶん見るか・どれだけ平均に寄せるか）も探索する。
   昇格クラブについては「直近1シーズンの J2 だけ見る」方が良い可能性がある */
const J2_VIEWS = [
  { label: "直近1年ほぼそのまま", hl: 0.7, sh: 6 },
  { label: "直近1年",            hl: 1,   sh: 14 },
  { label: "直近2年",            hl: 2,   sh: 20 },
  { label: "従来と同じ(6年)",     hl: P.HALF_LIFE, sh: P.SHRINK },
];

/** J2 の攻守力から J1 の事前分布を作る */
function priorFromJ2(j2r, club, b) {
  const r = j2r?.[club];
  if (!r) return PROMOTED;
  const out = {};
  for (const k of ["atkH", "defH", "atkA", "defA"]) {
    out[k] = PROMOTED[k] + b * (r[k] - 1);
  }
  return out;
}

/** 各シーズンの「履歴なしクラブ」に個別の事前分布を与えた prior を作る */
function buildPrior(b, view) {
  const byClub = {};
  for (const Y of SEASONS.slice(1)) {
    const inJ1Before = new Set(j1.filter((m) => m.s < Y).flatMap((m) => [m.h, m.a]));
    const inJ1Now = new Set(j1.filter((m) => m.s === Y).flatMap((m) => [m.h, m.a]));
    const j2r = ratingsAt(j2, Y, view.hl, view.sh);
    for (const c of [...inJ1Now].filter((x) => !inJ1Before.has(x))) {
      byClub[c] = priorFromJ2(j2r, c, b);
    }
  }
  return { byClub, default: PROMOTED };
}

/**
 * 昇格クラブが絡む試合だけを採点する。
 * 全2670試合で測ると、影響を受ける試合が1割ほどしかないので効果が薄まって見えない。
 */
const onlyPromoted = (m, hasHistory) => !hasHistory.has(m.h) || !hasHistory.has(m.a);

console.log("\n=== 持ち越し係数 b をバックテストで決める ===");
console.log("昇格クラブが絡む試合だけを採点する（全体では影響が薄まって見えないため）");

const base = {
  b: 0, view: null,
  train: run(P, 0, false, PROMOTED, S.train, onlyPromoted).ll,
  test: run(P, 0, false, PROMOTED, S.test, onlyPromoted).ll,
};
const pa0 = run(P, 0, false, PROMOTED, null, onlyPromoted);
base.promotedAll = pa0.ll; base.n = pa0.n;
base.all = run(P, 0, false, PROMOTED).ll;
console.log(`\n従来（J2を使わない）  学習 ${base.train.toFixed(5)}  検証 ${base.test.toFixed(5)}  ` +
  `昇格戦全体 ${base.promotedAll.toFixed(5)} (${base.n}試合)`);

const rows = [base];
for (const view of J2_VIEWS) {
  console.log(`\nJ2の見方: ${view.label}（半減期${view.hl}季・縮小${view.sh}）`);
  console.log("   b     学習       検証       昇格戦全体   両区間で改善");
  for (const b of [0.2, 0.4, 0.6, 0.8, 1.0]) {
    const prior = buildPrior(b, view);
    const tr = run(P, 0, false, prior, S.train, onlyPromoted).ll;
    const te = run(P, 0, false, prior, S.test, onlyPromoted).ll;
    const pa = run(P, 0, false, prior, null, onlyPromoted);
    const both = tr < base.train - 1e-9 && te < base.test - 1e-9;
    rows.push({ b, view: view.label, hl: view.hl, sh: view.sh, train: tr, test: te, promotedAll: pa.ll, n: pa.n });
    console.log(`   ${b.toFixed(1)}   ${tr.toFixed(5)}   ${te.toFixed(5)}   ${pa.ll.toFixed(5)}      ${both ? "✅" : "—"}`);
  }
}

/* tune.js と同じ規則：学習・検証の両方で改善しなければ採用しない */
const ok = rows.filter((r) => r.b > 0 && r.train < base.train - 1e-9 && r.test < base.test - 1e-9);
const best = ok.length
  ? ok.reduce((x, y) => (y.train + y.test < x.train + x.test ? y : x))
  : base;
console.log(ok.length
  ? `\n→ 採用: b = ${best.b}（${best.view}）両区間で改善`
  : `\n→ 採用しない（b = 0）。どの設定でも「片方の区間でしか改善しない」ため、` +
    `\n   J2成績の持ち越しは実在する効果として確認できなかった。従来の昇格クラブ平均を使う。`);

/* ------------------------------------------------- 予想対象シーズンの昇格クラブ */

const j1next = load(S.files.J1);
const inJ1 = new Set(j1.map((m) => [m.h, m.a]).flat());
const newcomersNext = [...new Set(j1next.flatMap((m) => [m.h, m.a]))].filter((c) => !inJ1.has(c));
const bestView = best.view ? J2_VIEWS.find((v) => v.label === best.view) : J2_VIEWS[3];
const j2ratNext = ratingsAt(j2, S.upcoming, bestView.hl, bestView.sh);

console.log(`\n=== ${S.label} で J1 履歴が無いクラブ: ${newcomersNext.join(" / ")} ===`);
const priorNext = {};
console.log("クラブ   J2攻撃H  J2守備H  →  J1事前 atkH  defH   atkA   defA");
for (const c of newcomersNext) {
  const p = priorFromJ2(j2ratNext, c, best.b);
  priorNext[c] = p;
  const r = j2ratNext[c];
  console.log(`${c.padEnd(7)} ${r ? r.atkH.toFixed(3) : "  -  "}    ${r ? r.defH.toFixed(3) : "  -  "}      ` +
    `${p.atkH.toFixed(3)}  ${p.defH.toFixed(3)}  ${p.atkA.toFixed(3)}  ${p.defA.toFixed(3)}`);
}
console.log(`（従来はどちらも atkH ${PROMOTED.atkH} / defH ${PROMOTED.defH} で同じ扱いだった）`);

const out = {
  note: "J2の攻守力から昇格クラブの事前分布を作る係数。tools/calibrate-promoted.js が決める",
  method: "prior = 昇格クラブ平均 + b × (J2での攻守力 - 1)。b はバックテストで決定",
  samples: samples.map((s) => ({ season: s.season, club: s.club })),
  regression: COEF,
  carryover: best.b,
  grid: rows,
  promotedAverage: PROMOTED,
  leagueAverage: { home: AVG.lgH, away: AVG.lgA },
  sampleClubs: AVG.nClubs, sampleAppearances: AVG.nMatches,
  priorNext,
  verdict: best.b === 0
    ? "J2の成績を使っても精度は上がらなかった。昇格クラブ平均のまま使う"
    : `J2の強さを ${best.b} の割合で持ち越すと精度が上がる`,
};
fs.writeFileSync(path.join(__dirname, "..", "data", "promoted.json"), JSON.stringify(out, null, 2) + "\n");
console.log("\n→ data/promoted.json に保存");
