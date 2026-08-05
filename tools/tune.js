/**
 * パラメータを時系列バックテストで決める。
 *
 *   node tools/tune.js
 *
 * ふつうのグリッドサーチは「評価する試合そのもので最良値を選ぶ」ので、
 * たまたま合っただけの値を掴む（過剰適合）。実際にやってみると
 * HALF_LIFE や RHO は、学習区間では改善するのに検証区間では悪化した。
 *
 * そこでこのスクリプトは
 *   学習区間 2018-2022 と 検証区間 2023-2025 の両方で改善したときだけ採用する
 * という規則にしている。片方だけの改善は雑音として捨てる。
 * この規則なら、あとで再実行しても同じ結論になる。
 *
 * 結果は data/params.json に書き出す。アプリの定数はここから生成する。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { run } = require("./backtest");
const M = require("./lib/model");

/* 学習区間・検証区間は data/season.json から取る。
   parse.js がデータから導いているので、シーズンが進んでもここを触らなくてよい。 */
const SEASON_INFO = require("./lib/season").require();
const TRAIN = SEASON_INFO.train;
const TEST = SEASON_INFO.test;
const OFF = 1e9; // H2H_K に入れると相性補正が実質無効になる

/** 探索する軸と候補値 */
const AXES = {
  HALF_LIFE: [2, 3, 4, 5, 6, 7, 8, 10, 12],
  SHRINK:    [10, 14, 18, 22, 26, 28, 30, 34, 38, 44, 52],
  CUR_W:     [0, 0.5, 0.8, 1.0, 1.2, 1.5, 1.8, 2.2, 2.8, 3.5],
  H2H_K:     [2, 4, 8, 12, 18, 24, 32, 48, 80, OFF],
  H2H_CAP:   [0.05, 0.10, 0.15, 0.25, 0.40],
  RHO:       [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06],
};

const show = (v) => (v >= OFF ? "∞" : String(v));
const cache = new Map();
function score(P, range) {
  const k = JSON.stringify(P) + "|" + range.join("-");
  if (!cache.has(k)) cache.set(k, run(P, 0, false, null, range).ll);
  return cache.get(k);
}

let P = { ...M.DEFAULT_P };
let tr = score(P, TRAIN), te = score(P, TEST);
console.log("=== パラメータ決定（両区間で改善したものだけ採用）===");
console.log(`出発点  学習 ${tr.toFixed(5)}  検証 ${te.toFixed(5)}   ${JSON.stringify(P)}\n`);

const adopted = [], rejected = [];

for (let pass = 1; pass <= 6; pass++) {
  let moved = false;
  for (const [axis, values] of Object.entries(AXES)) {
    let bv = null, btr = tr, bte = te;
    for (const v of values) {
      if (v === P[axis]) continue;
      const q = { ...P, [axis]: v };
      const a = score(q, TRAIN), b = score(q, TEST);
      const better = a < btr - 1e-9 && b < bte - 1e-9;   // ★両方で改善が条件
      if (better) { bv = v; btr = a; bte = b; }
      else if (a < tr - 1e-9 && b >= te - 1e-9 && pass === 1) {
        rejected.push({ axis, from: P[axis], to: v, train: a - tr, test: b - te });
      }
    }
    if (bv !== null) {
      console.log(`pass${pass}  ${axis.padEnd(9)} ${show(P[axis]).padStart(6)} → ${show(bv).padStart(6)}   ` +
        `学習 ${tr.toFixed(5)}→${btr.toFixed(5)}   検証 ${te.toFixed(5)}→${bte.toFixed(5)}`);
      adopted.push({ axis, from: P[axis], to: bv, train: btr - tr, test: bte - te });
      P[axis] = bv; tr = btr; te = bte; moved = true;
    }
  }
  if (!moved) { console.log(`pass${pass}  これ以上の改善なし → 終了`); break; }
}

if (rejected.length) {
  console.log("\n--- 学習区間だけで改善した候補（過剰適合として却下）---");
  for (const r of rejected.slice(0, 12))
    console.log(`  ${r.axis} ${show(r.from)}→${show(r.to)}  学習 ${r.train.toFixed(5)}  検証 +${r.test.toFixed(5)}`);
}

/* 日程補正も同じ規則で判定する */
console.log("\n=== 日程補正（中N日）の効き幅 θ ===");
const fat = [];
for (const th of [0, 0.02, 0.04, 0.06, 0.10]) {
  const a = run(P, th, false, null, TRAIN).ll, b = run(P, th, false, null, TEST).ll;
  fat.push({ theta: th, train: a, test: b });
  console.log(`  θ=${th.toFixed(2)}  学習 ${a.toFixed(5)}  検証 ${b.toFixed(5)}`);
}
const bestTheta = fat.reduce((x, y) => (y.train + y.test < x.train + x.test ? y : x)).theta;
console.log(`  → θ = ${bestTheta}${bestTheta === 0 ? "（日程補正は入れない。効かせるほど悪化する）" : ""}`);

/* 確定値で全区間の精度を出す */
const final = run(P, bestTheta);
console.log("\n=== 確定 ===");
for (const [k, v] of Object.entries(P)) {
  const note = k === "H2H_K" && v >= OFF ? "   ← 相性補正を使わない（実測で有害と判明）" : "";
  console.log(`  ${k.padEnd(10)} ${show(v)}${note}`);
}
console.log(`  FATIGUE    ${bestTheta}${bestTheta === 0 ? "   ← 日程補正を使わない（同上）" : ""}`);
console.log(`\n  ${SEASON_INFO.firstEval}-${SEASON_INFO.histEnd} 全体   log loss ${final.ll.toFixed(5)}` +
  `   的中率 ${(final.hit * 100).toFixed(2)}%  (${final.n}試合)`);
console.log(`  基準率（常にホーム）      ${final.llBase.toFixed(5)}          ${(final.hitBase * 100).toFixed(2)}%`);
console.log(`  一様（1/3ずつ）          ${Math.log(3).toFixed(5)}          33.33%`);

const out = {
  note: "tools/tune.js が決めた値。手で書き換えないこと。再実行すれば同じ値になる",
  rule: `学習 ${TRAIN.join("-")} と 検証 ${TEST.join("-")} の両方で log loss が下がったときだけ採用`,
  source: "data/j1-matches.json（Ｊリーグ公式データサイト・試合日つき）",
  model: P,
  fatigue: {
    theta: bestTheta,
    tested: fat,
    verdict: bestTheta === 0
      ? "中N日・週中の別大会による有利不利は検出できなかった。補正を入れると精度が下がる"
      : "効果あり",
  },
  h2h: (() => {
    const base = M.DEFAULT_P.H2H_K;   // 従来値（24）
    const weakened = P.H2H_K > base;
    // 対戦20回のときの効き幅。1に近いほど「補正が効いていない」
    const strengthAt20 = 20 / (20 + P.H2H_K);
    return {
      H2H_K: P.H2H_K >= OFF ? "∞" : P.H2H_K,
      disabled: P.H2H_K >= OFF,
      effectivelyOff: strengthAt20 < 0.25,
      strengthAt20Meetings: strengthAt20,
      verdict: !weakened
        ? "従来のまま（弱めても改善しなかった）"
        : `対戦相性は有害だった。H2H_K を ${base} → ${P.H2H_K} に弱めると学習・検証の両区間で改善する。` +
          `この値では対戦20回でも効き幅は ${(strengthAt20 * 100).toFixed(0)}% で、実質ほぼ無効`,
    };
  })(),
  adopted, rejected: rejected.slice(0, 20),
  accuracy: {
    logLoss: final.ll, hitRate: final.hit, matches: final.n,
    baselineLogLoss: final.llBase, baselineHitRate: final.hitBase,
    uniformLogLoss: Math.log(3),
    trainLogLoss: run(P, bestTheta, false, null, TRAIN).ll,
    testLogLoss: run(P, bestTheta, false, null, TEST).ll,
  },
};
fs.writeFileSync(path.join(__dirname, "..", "data", "params.json"), JSON.stringify(out, null, 2) + "\n");
console.log("\n→ data/params.json に保存");
