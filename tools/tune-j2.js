/**
 * J2 のパラメータと精度を、J1 とまったく同じ方法で決める。
 *
 *   node tools/tune-j2.js
 *
 * J1 の値をそのまま流用しないのは、J2 が別のリーグだからではなく
 * 「流用してよいかどうかを測っていないから」。測った結果 J1 と同じ値になるなら、
 * それはそれで「同じでよい」という根拠になる。
 *
 * 採用の規則は J1 と同じ：
 *   学習区間 2018-2022 と 検証区間 2023-2025 の両方で log loss が下がったときだけ採用。
 * 片方だけの改善は雑音として捨てる。
 *
 * 結果は data/params-j2.json に書き出す。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { load } = require("./lib/data");
const M = require("./lib/model");
const core = require("./lib/backtest-core");

const TRAIN = [2018, 2022];
const TEST = [2023, 2025];
const OFF = 1e9;
const FIRST_EVAL = 2018;

const j2all = load("j2-matches.json");
const ylc = load("ylc-matches.json");

/* ============================================================================
   1) J2 に初めて現れるクラブを、どこへ寄せるか
   J1 と違い、J2 の新顔には2種類ある。
     ・J1 から落ちてきたクラブ（強いことが多い）
     ・J3 から上がってきたクラブ（弱いことが多い）
   J3 のデータを持っていないので個別には評価できない。
   そこで「J2 に初めて出たシーズンの実績」を全部ならした平均像を作る。
   これは J1 側の promotedAverage とまったく同じ考え方。
   ============================================================================ */
function newcomerAverage(rows) {
  const played = rows.filter((m) => m.hg != null);
  const first = new Map();                       // クラブ → 初出シーズン
  for (const m of played) for (const c of [m.h, m.a]) {
    if (!first.has(c) || m.s < first.get(c)) first.set(c, m.s);
  }
  const seasons = [...new Set(played.map((m) => m.s))].sort();
  const skip = seasons[0];                       // 最初の年は全員が「初出」なので除く

  let hGF = 0, hGA = 0, hN = 0, aGF = 0, aGA = 0, aN = 0;
  const clubs = new Set();
  /* リーグ平均はシーズンごとに違うので、シーズン平均で割ってから平均する */
  const lg = {};
  for (const s of seasons) {
    const ms = played.filter((m) => m.s === s);
    lg[s] = { h: ms.reduce((x, m) => x + m.hg, 0) / ms.length,
              a: ms.reduce((x, m) => x + m.ag, 0) / ms.length };
  }
  let atkH = 0, defH = 0, atkA = 0, defA = 0, nH = 0, nA = 0;
  for (const m of played) {
    if (m.s === skip) continue;
    const L = lg[m.s];
    if (first.get(m.h) === m.s) { atkH += m.hg / L.h; defH += m.ag / L.a; nH++; clubs.add(m.h + m.s); }
    if (first.get(m.a) === m.s) { atkA += m.ag / L.a; defA += m.hg / L.h; nA++; clubs.add(m.a + m.s); }
  }
  return {
    atkH: atkH / nH, defH: defH / nH, atkA: atkA / nA, defA: defA / nA,
    appearances: nH + nA, clubSeasons: clubs.size,
  };
}

const NEW = newcomerAverage(j2all);
const AVERAGE = { atkH: NEW.atkH, defH: NEW.defH, atkA: NEW.atkA, defA: NEW.defA };

console.log("=== J2 の新顔クラブの平均像（J1 の昇格クラブ平均に相当）===");
console.log(`  ${NEW.clubSeasons}クラブ・シーズン / ${NEW.appearances}試合から実測`);
console.log(`  atkH ${AVERAGE.atkH.toFixed(4)}  defH ${AVERAGE.defH.toFixed(4)}` +
            `  atkA ${AVERAGE.atkA.toFixed(4)}  defA ${AVERAGE.defA.toFixed(4)}`);
console.log("  （1.0 がリーグ平均。攻撃は低いほど・守備は高いほど苦戦している）");

/* ============================================================================
   1-b) J3 が手に入ったので、新顔を出自（J1から / J3から）で分けて個別に評価する
   実測は tools/calibrate-j3.js が済ませ、確定値を data/calib-j3.json に書いている。
   ここでは出自の判定や「J3での攻守力」を作り直さず、その結果を読むだけにする
   （同じ計算を2箇所に置くと必ず片方が古くなる）。
   ファイルが無い／実測して採用されなかった場合は、従来どおり混ぜた平均1組を使う。
   ============================================================================ */
let PRIOR = AVERAGE;
let j3note = "J3 は使わない（data/calib-j3.json が無い）";
try {
  const cj3 = load("calib-j3.json");
  if (cj3.adopted && cj3.adopted !== "single" && cj3.byClub && Object.keys(cj3.byClub).length) {
    PRIOR = { byClub: cj3.byClub, default: AVERAGE };
    j3note = `calib-j3.json の個別事前分布（${cj3.adopted} / b=${cj3.carryover} / ${cj3.view}）`;
    console.log(`\n  → J3 から個別の事前分布を ${Object.keys(cj3.byClub).length}クラブぶん読み込んだ`);
    console.log(`     ${j3note}`);
    for (const [k, v] of Object.entries(cj3.groupAverages ?? {})) {
      console.log(`     ${k.padEnd(4)}から: atkH ${v.atkH.toFixed(4)}  defH ${v.defH.toFixed(4)}` +
        `  atkA ${v.atkA.toFixed(4)}  defA ${v.defA.toFixed(4)}  （${v.clubSeasons}クラブ）`);
    }
  } else {
    j3note = "J3 を実測したが採用されなかった（混ぜた平均のまま）";
    console.log(`\n  → ${j3note}`);
  }
} catch {
  console.log(`\n  → ${j3note}`);
}
console.log();

/* ============================================================================
   2) パラメータを決める（J1 と同じ規則）
   ============================================================================ */
const BT = core.make({ matches: j2all, cup: ylc, prior: PRIOR, firstEval: FIRST_EVAL });

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
const score = (P, range) => {
  const k = JSON.stringify(P) + "|" + range.join("-");
  if (!cache.has(k)) cache.set(k, BT.run(P, 0, false, null, range).ll);
  return cache.get(k);
};

/* 出発点は J1 の確定値。「J1 と同じでよいか」を問う形にする */
const j1P = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "params.json"), "utf8")).model;
let P = { ...j1P };
let tr = score(P, TRAIN), te = score(P, TEST);

console.log("=== J2 のパラメータ決定（両区間で改善したものだけ採用）===");
console.log(`出発点（J1の値）  学習 ${tr.toFixed(5)}  検証 ${te.toFixed(5)}   ${JSON.stringify(P)}\n`);

const adopted = [];
for (let pass = 1; pass <= 6; pass++) {
  let moved = false;
  for (const [axis, values] of Object.entries(AXES)) {
    let bv = null, btr = tr, bte = te;
    for (const v of values) {
      if (v === P[axis]) continue;
      const q = { ...P, [axis]: v };
      const a = score(q, TRAIN), b = score(q, TEST);
      if (a < btr - 1e-9 && b < bte - 1e-9) { bv = v; btr = a; bte = b; }
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

const same = JSON.stringify(P) === JSON.stringify(j1P);
console.log(`\n=== 確定 ===`);
for (const [k, v] of Object.entries(P)) console.log(`  ${k.padEnd(10)} ${show(v)}`);
console.log(same
  ? "  → J1 と同じ値になった（J2 でも J1 の設定がそのまま最良）"
  : "  → J1 とは違う値が採用された");

const final = BT.run(P, 0);
console.log(`\n  2018-2025 全体   log loss ${final.ll.toFixed(5)}   的中率 ${(final.hit * 100).toFixed(2)}%  (${final.n}試合)`);
console.log(`  基準率（常にホーム）      ${final.llBase.toFixed(5)}          ${(final.hitBase * 100).toFixed(2)}%`);
console.log(`  一様（1/3ずつ）          ${Math.log(3).toFixed(5)}          33.33%`);

const out = {
  note: "tools/tune-j2.js が決めた値。手で書き換えないこと。再実行すれば同じ値になる",
  rule: `学習 ${TRAIN.join("-")} と 検証 ${TEST.join("-")} の両方で log loss が下がったときだけ採用`,
  source: "data/j2-matches.json（Ｊリーグ公式データサイト・試合日つき）",
  startedFrom: "data/params.json の J1 確定値",
  sameAsJ1: same,
  model: P,
  newcomer: {
    ...PRIOR,
    method: "J2に初めて現れたシーズンの成績を、そのシーズンのリーグ平均で割って平均したもの",
    note: "J1から落ちてきたクラブとJ3から上がってきたクラブが混ざった平均像。J3のデータが無いので個別には分けられない",
    clubSeasons: NEW.clubSeasons, appearances: NEW.appearances,
  },
  adopted,
  accuracy: {
    logLoss: final.ll, hitRate: final.hit, matches: final.n,
    baselineLogLoss: final.llBase, baselineHitRate: final.hitBase,
    uniformLogLoss: Math.log(3),
    trainLogLoss: BT.run(P, 0, false, null, TRAIN).ll,
    testLogLoss: BT.run(P, 0, false, null, TEST).ll,
  },
};
fs.writeFileSync(path.join(__dirname, "..", "data", "params-j2.json"), JSON.stringify(out, null, 2) + "\n");
console.log("\n→ data/params-j2.json に保存");
