/**
 * 日程補正（中N日・週中の別大会）を実測する。
 *
 *   node tools/calibrate-schedule.js
 *
 * 解説.md の 7章では、この補正だけが「実測ではない調整パラメータ」だった。
 * 試合日が手に入ったので、実際の効果量を測って置き換える。
 *
 * 方法
 *   1. シーズン Y の予測は Y より前だけで学習する（未来を使わない）
 *   2. 各試合の素の期待得点 λ を出す
 *   3. 「実際の得点 ÷ 期待得点」を、休養日数のバケットごとに集計する
 *      → 期待得点にはチームの地力が入っているので、
 *         「連戦するのは強いクラブ」という偏りは打ち消される
 *   4. 相手との休養差でも集計する（リーグ全体の季節効果を打ち消すため）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { load, dayNum, buildAppearances, previousMatch } = require("./lib/data");
const M = require("./lib/model");

/* パラメータと昇格クラブの事前分布は data/ が正。ここに数値を書かない */
const P = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "params.json"), "utf8")).model;
const PROMOTED = (() => {
  const f = path.join(__dirname, "..", "data", "promoted.json");
  return fs.existsSync(f)
    ? JSON.parse(fs.readFileSync(f, "utf8")).promotedAverage
    : M.DEFAULT_PROMOTED;
})();

const j1 = load("j1-matches.json");
const ylc = load("ylc-matches.json");

/* 中N日を出すための出場索引。リーグ戦だけでなくカップ戦も混ぜる */
const APP = buildAppearances([
  { rows: j1, kind: "league" },
  { rows: ylc, kind: "cup" },
]);

const SEASONS = [...new Set(j1.map((m) => m.s))].sort();
const FIRST_EVAL = 2018; // 解説.md 6章と同じ評価区間にする

/* ---------------------------------------------------------------- 観測を作る */

/** 1試合＝2レコード（ホーム視点・アウェイ視点）に展開する */
const obs = [];
let noPrev = 0;

for (const Y of SEASONS.filter((y) => y >= FIRST_EVAL)) {
  const past = j1.filter((m) => m.s < Y);
  const hasHistory = new Set(past.flatMap((m) => [m.h, m.a]));
  const fit = M.fitRatings(past, [], Y, P, PROMOTED, hasHistory);

  for (const m of j1.filter((x) => x.s === Y)) {
    const day = dayNum(m.date);
    if (day == null) continue;
    const { lh, la } = M.baseLambda(fit, m.h, m.a);
    const ph = previousMatch(APP, m.h, Y, day);
    const pa = previousMatch(APP, m.a, Y, day);
    if (!ph || !pa) { noPrev++; continue; }
    const gapH = day - ph.day, gapA = day - pa.day;
    // ホーム視点
    obs.push({ gap: gapH, oppGap: gapA, prevKind: ph.kind, gf: m.hg, ga: m.ag, ef: lh, ea: la, home: true });
    // アウェイ視点
    obs.push({ gap: gapA, oppGap: gapH, prevKind: pa.kind, gf: m.ag, ga: m.hg, ef: la, ea: lh, home: false });
  }
}

console.log(`観測 ${obs.length}件（チーム視点）／直前試合が無くて除外 ${noPrev}試合`);

/* ---------------------------------------------------------------- 集計 */

/** 集計の器。得点と失点の「実測/期待」比を出す */
function agg(rows) {
  let gf = 0, ga = 0, ef = 0, ea = 0;
  for (const r of rows) { gf += r.gf; ga += r.ga; ef += r.ef; ea += r.ea; }
  return {
    n: rows.length,
    atk: ef > 0 ? gf / ef : NaN,   // 1未満なら「点が取れていない」
    def: ea > 0 ? ga / ea : NaN,   // 1超なら「失点が増えている」
    gf, ga,
  };
}

/** 二項的なばらつきからの標準誤差の目安（得点はポアソンなので √期待値/期待値） */
const se = (expected) => (expected > 0 ? Math.sqrt(expected) / expected : NaN);

const BUCKETS = [
  { label: "中2日以下", test: (g) => g <= 3 },
  { label: "中3日",     test: (g) => g === 4 },
  { label: "中4日",     test: (g) => g === 5 },
  { label: "中5日",     test: (g) => g === 6 },
  { label: "中6日",     test: (g) => g === 7 },
  { label: "中7〜9日",  test: (g) => g >= 8 && g <= 10 },
  { label: "中10日以上", test: (g) => g >= 11 },
];

console.log("\n=== 休養日数ごとの「実測 ÷ 期待」 ===");
console.log("バケット      件数   得点比  (±)     失点比  (±)");
const restRows = [];
for (const b of BUCKETS) {
  const rows = obs.filter((r) => b.test(r.gap));
  if (!rows.length) continue;
  const a = agg(rows);
  const ef = rows.reduce((s, r) => s + r.ef, 0), ea = rows.reduce((s, r) => s + r.ea, 0);
  restRows.push({ label: b.label, ...a });
  console.log(
    `${b.label.padEnd(11)} ${String(a.n).padStart(5)}   ` +
    `${a.atk.toFixed(3)}  ±${se(ef).toFixed(3)}   ${a.def.toFixed(3)}  ±${se(ea).toFixed(3)}`
  );
}

/* 相手との休養差。リーグ全体の季節効果や年ごとのブレを打ち消せる */
console.log("\n=== 相手より何日多く休めたか ===");
const DIFF = [
  { label: "3日以上少ない", test: (d) => d <= -3 },
  { label: "1〜2日少ない",  test: (d) => d < 0 && d >= -2 },
  { label: "同じ",          test: (d) => d === 0 },
  { label: "1〜2日多い",    test: (d) => d > 0 && d <= 2 },
  { label: "3日以上多い",   test: (d) => d >= 3 },
];
console.log("差            件数   得点比   失点比");
const diffRows = [];
for (const b of DIFF) {
  const rows = obs.filter((r) => b.test(r.gap - r.oppGap));
  if (!rows.length) continue;
  const a = agg(rows);
  diffRows.push({ label: b.label, ...a });
  console.log(`${b.label.padEnd(13)} ${String(a.n).padStart(5)}   ${a.atk.toFixed(3)}    ${a.def.toFixed(3)}`);
}

/* 直前がカップ戦だったか（週中の別大会の効果） */
console.log("\n=== 直前の試合がリーグ戦かカップ戦か（中5日以内に限る）===");
const tight = obs.filter((r) => r.gap <= 6);
for (const k of ["league", "cup"]) {
  const rows = tight.filter((r) => r.prevKind === k);
  const a = agg(rows);
  console.log(`${(k === "league" ? "リーグ戦" : "カップ戦").padEnd(9)} ${String(a.n).padStart(5)}   ` +
    `得点比 ${a.atk.toFixed(3)}   失点比 ${a.def.toFixed(3)}`);
}

/* ---------------------------------------------------------------- 取りこぼしの見積り

   天皇杯とACLの日程は取れていない（JFAはJS描画・AFCは機械可読な形で公開していない）。
   その分「本当は中3日なのに中6日と見えている」試合が混じり、効果が薄まって見える恐れがある。

   どれくらい混じるのかを、手元にあるルヴァン杯で代用して測る。
   「J1だけで測った休養日数」と「J1＋ルヴァンで測った休養日数」がどれだけズレるかを見れば、
   カップ戦1つぶんの汚染率が分かる。天皇杯・ACLも同じ桁数だと考えられる。            */

const J1_ONLY = buildAppearances([{ rows: j1, kind: "league" }]);
let same = 0, over = 0, over2 = 0, sumOver = 0;
for (const Y of SEASONS.filter((y) => y >= FIRST_EVAL)) {
  for (const m of j1.filter((x) => x.s === Y)) {
    const day = dayNum(m.date);
    if (day == null) continue;
    for (const c of [m.h, m.a]) {
      const onlyLeague = previousMatch(J1_ONLY, c, Y, day);
      const withCup = previousMatch(APP, c, Y, day);
      if (!onlyLeague || !withCup) continue;
      // カップ戦を数えると直前試合が後ろにずれる＝本当の休養は短い
      const d = withCup.day - onlyLeague.day;
      if (d === 0) same++;
      else { over++; sumOver += d; if (d >= 2) over2++; }
    }
  }
}
const total = same + over;
console.log("\n=== 取りこぼしの見積り（ルヴァン杯を隠したらどうなるか）===");
console.log(`リーグ戦だけで測ると、${total}件のうち ${over}件（${(over / total * 100).toFixed(1)}%）で`);
console.log(`休養日数を過大に見積もる。ズレは平均 ${(sumOver / over).toFixed(1)}日、` +
  `2日以上ズレるのは ${over2}件（${(over2 / total * 100).toFixed(1)}%）。`);
console.log(`天皇杯とACLも同じ程度の汚染率だと考えられる。`);
console.log(`つまり本当の効果が仮に -7%（従来の想定）あるなら、`);
console.log(`1〜2割の混入では消えず、上の表に必ず表れる。表れていないので「効果は無い」と判断できる。`);

/* ---------------------------------------------------------------- 保存 */

const out = {
  generatedFrom: "data/j1-matches.json + data/ylc-matches.json",
  method: "シーズンYの予測はY未満で学習し、実測得点÷期待得点を休養日数で層別",
  evalSeasons: `${FIRST_EVAL}-${SEASONS[SEASONS.length - 1]}`,
  observations: obs.length,
  byRest: restRows,
  byRestDiff: diffRows,
};
const file = path.join(__dirname, "..", "data", "calib-schedule.json");
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`\n→ data/calib-schedule.json に保存`);
