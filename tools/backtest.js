/**
 * J1 の時系列バックテスト。
 *
 *   node tools/backtest.js                  … 既定パラメータで精度を出す
 *   node tools/backtest.js --grid           … パラメータをグリッドサーチ
 *   node tools/backtest.js --grid=fatigue   … 日程補正の効果だけを測る
 *
 * これまで（解説.md 14章）は試合日が無かったため、
 * シーズンの試合をランダムに並べ替えて「消化率○%の時点」を近似していた。
 * 試合日が入ったので、実際の日付順に
 *   「その試合の前日までに終わっている試合だけで学習して予測する」
 * という本来の検証ができる。近似ではないので、ここで出る値がアプリの精度になる。
 *
 * 検証の中身は lib/backtest-core.js にある（リーグ非依存）。
 * このファイルは「J1のデータを渡す」だけの入口。J2 は backtest-j2.js。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { load } = require("./lib/data");
const M = require("./lib/model");
const core = require("./lib/backtest-core");
const SEASON_INFO = require("./lib/season").require();

const pf = path.join(__dirname, "..", "data", "promoted.json");
const PROMOTED = fs.existsSync(pf)
  ? JSON.parse(fs.readFileSync(pf, "utf8")).promotedAverage
  : M.DEFAULT_PROMOTED;
/* 採点を始めるシーズン。直書きせず data/season.json から取る（来季もここを触らないため） */
const FIRST_EVAL = SEASON_INFO.firstEval;

const BT = core.make({
  matches: load("j1-matches.json"),
  cup: load("ylc-matches.json"),      // 週中の別大会。休養日数の計算に混ぜる
  prior: PROMOTED,
  firstEval: FIRST_EVAL,
});

const { run, gapBefore, SEASONS } = BT;
const J1 = BT.matches;

module.exports = { run, J1, SEASONS, FIRST_EVAL, PROMOTED, gapBefore };

/* --------------------------------------------------- 出力 */

const fmt = (r) =>
  `log loss ${r.ll.toFixed(5)}  的中率 ${(r.hit * 100).toFixed(2)}%  (${r.n}試合)`;

const arg = process.argv.find((a) => a.startsWith("--grid"));

if (require.main !== module) {
  // モジュールとして読まれたときは何も出力しない
} else if (!arg) {
  const P = M.DEFAULT_P;
  const r = run(P, 0);
  console.log(`=== 時系列バックテスト（${FIRST_EVAL}-${SEASON_INFO.histEnd}・日程補正なし）===`);
  console.log("本モデル   ", fmt(r));
  console.log(`基準率     log loss ${r.llBase.toFixed(5)}  的中率 ${(r.hitBase * 100).toFixed(2)}%`);
  console.log(`一様(1/3)  log loss ${Math.log(3).toFixed(5)}  的中率 33.33%`);
} else if (arg === "--grid=fatigue") {
  console.log("=== 日程補正の効き幅 θ を探す ===");
  console.log("（θ=0 が最良なら「日程補正は入れない方が良い」という実測結果になる）\n");
  console.log("  θ     非対称（疲れた側が不利）    対称（両チーム減点）");
  for (const th of [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.10]) {
    const a = run(M.DEFAULT_P, th, false);
    const b = th === 0 ? a : run(M.DEFAULT_P, th, true);
    console.log(`  ${th.toFixed(2)}   ${a.ll.toFixed(5)} / ${(a.hit*100).toFixed(2)}%        ` +
                `${b.ll.toFixed(5)} / ${(b.hit*100).toFixed(2)}%`);
  }
} else {
  console.log("=== パラメータのグリッドサーチ（時系列バックテスト）===");
  let best = null;
  const grid = [];
  for (const HALF_LIFE of [3, 4, 5, 6, 8])
    for (const SHRINK of [16, 22, 28, 34, 40])
      for (const CUR_W of [0.5, 1.0, 1.5, 2.0, 3.0])
        grid.push({ ...M.DEFAULT_P, HALF_LIFE, SHRINK, CUR_W });
  let i = 0;
  for (const P of grid) {
    const r = run(P, 0);
    if (!best || r.ll < best.r.ll) { best = { P, r }; }
    if (++i % 25 === 0) process.stdout.write(`\r  ${i}/${grid.length} …`);
  }
  console.log(`\r  ${grid.length}/${grid.length} 完了            `);
  console.log("\n最良:", JSON.stringify({
    HALF_LIFE: best.P.HALF_LIFE, SHRINK: best.P.SHRINK, CUR_W: best.P.CUR_W,
  }));
  console.log("      ", fmt(best.r));
}
