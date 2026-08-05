/**
 * パラメータ選びが過剰適合していないかを確かめる（分割検証）。
 *
 *   node tools/validate.js
 *
 * tune.js は 2018-2025 の 2670試合で log loss を最小化する。
 * ところが「評価した試合でパラメータを選ぶ」と、
 * たまたま合っただけの値を掴んでしまう（過剰適合）。
 *
 * そこで
 *   前半 2018-2022 だけでパラメータを選び、
 *   後半 2023-2025（見ていない試合）で測る
 * ことで、その値が本物かノイズかを切り分ける。
 *
 * 「後半でも改善している」→ 採用してよい
 * 「後半では悪化する」    → 前半に合わせただけ。採用しない
 */
"use strict";

const { run } = require("./backtest");
const M = require("./lib/model");

const SEASON_INFO = require("./lib/season").require();
const TRAIN = SEASON_INFO.train;
const TEST = SEASON_INFO.test;

const AXES = {
  HALF_LIFE: [2, 3, 4, 5, 6, 7, 8, 10, 12],
  SHRINK:    [10, 14, 18, 22, 26, 28, 30, 34, 38, 44, 52],
  CUR_W:     [0, 0.5, 0.8, 1.0, 1.2, 1.5, 1.8, 2.2, 2.8, 3.5],
  H2H_K:     [2, 4, 8, 12, 18, 24, 32, 48, 80, 1e9],
  H2H_CAP:   [0.05, 0.10, 0.15, 0.25, 0.40],
  RHO:       [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06],
};

const show = (v) => (v >= 1e9 ? "∞" : String(v));

/** 座標降下法で range 内の log loss を最小化する */
function tune(range, start) {
  let P = { ...start };
  let best = run(P, 0, false, null, range).ll;
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const [axis, values] of Object.entries(AXES)) {
      let bv = P[axis], bl = best;
      for (const v of values) {
        if (v === P[axis]) continue;
        const ll = run({ ...P, [axis]: v }, 0, false, null, range).ll;
        if (ll < bl - 1e-9) { bl = ll; bv = v; }
      }
      if (bv !== P[axis]) { P[axis] = bv; best = bl; moved = true; }
    }
    if (!moved) break;
  }
  return { P, ll: best };
}

console.log("=== 分割検証 ===");
console.log(`学習 ${TRAIN[0]}-${TRAIN[1]}  で選び、  検証 ${TEST[0]}-${TEST[1]}  で測る\n`);

const base = { ...M.DEFAULT_P };                       // 従来のパラメータ
const trained = tune(TRAIN, base).P;                   // 前半だけで選んだパラメータ

console.log("従来        ", JSON.stringify(base, (k, v) => (v >= 1e9 ? "∞" : v)));
console.log("前半で選んだ ", JSON.stringify(trained, (k, v) => (v >= 1e9 ? "∞" : v)));

const rows = [
  ["従来のパラメータ", base],
  ["前半で選んだ値", trained],
];
console.log("\n                  学習区間 log loss   検証区間 log loss   検証の的中率");
for (const [label, P] of rows) {
  const a = run(P, 0, false, null, TRAIN);
  const b = run(P, 0, false, null, TEST);
  console.log(`${label.padEnd(17)} ${a.ll.toFixed(5)}           ${b.ll.toFixed(5)}           ${(b.hit * 100).toFixed(2)}%`);
}

/* 軸ごとに「検証区間でも効いているか」を個別に見る */
console.log("\n=== 1軸ずつ動かしたときの検証区間への影響（従来値から）===");
console.log("変更                          学習       検証      判定");
const baseTest = run(base, 0, false, null, TEST).ll;
const baseTrain = run(base, 0, false, null, TRAIN).ll;
for (const [axis, values] of Object.entries(AXES)) {
  for (const v of values) {
    if (v === base[axis]) continue;
    const P = { ...base, [axis]: v };
    const tr = run(P, 0, false, null, TRAIN).ll;
    const te = run(P, 0, false, null, TEST).ll;
    // 学習区間で改善した候補だけ表示する（それが検証でも改善するかが知りたい）
    if (tr >= baseTrain) continue;
    const ok = te < baseTest;
    console.log(`${(axis + " = " + show(v)).padEnd(28)} ` +
      `${(tr - baseTrain >= 0 ? "+" : "") + (tr - baseTrain).toFixed(5)}  ` +
      `${(te - baseTest >= 0 ? "+" : "") + (te - baseTest).toFixed(5)}  ` +
      `${ok ? "✅ 検証でも改善" : "❌ 検証では悪化（過剰適合）"}`);
  }
}

/* 日程補正も同じ方法で確かめる */
console.log("\n=== 日程補正 θ の分割検証 ===");
console.log("  θ      学習       検証");
for (const th of [0, 0.02, 0.04, 0.06]) {
  const a = run(base, th, false, null, TRAIN).ll;
  const b = run(base, th, false, null, TEST).ll;
  console.log(`  ${th.toFixed(2)}   ${a.toFixed(5)}   ${b.toFixed(5)}`);
}
