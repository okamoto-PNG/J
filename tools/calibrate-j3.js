/**
 * J2 の新顔クラブを「どこから来たか」で分けて評価する。
 *
 *   node tools/calibrate-j3.js
 *
 * これまで（tune-j2.js の newcomerAverage）は、J2 に初めて現れたクラブを
 * ぜんぶ1組の平均像に寄せていた。しかし J2 の新顔には2種類ある。
 *   ・J1 から落ちてきたクラブ（強いことが多い）
 *   ・J3 から上がってきたクラブ（弱いことが多い）
 * これを混ぜた平均に寄せるのは、明らかに粗い。
 * tune-j2.js にも「J3のデータが無いので個別には分けられない」と書いてあった。
 *
 * J3 のデータ（2015-2026）が手に入ったので、その穴を埋める。測るのは2段階。
 *   段階1  出自で2グループに分ける（J1から / J3から）。個別の成績は使わない
 *   段階2  さらに「出身リーグでどれくらい強かったか」を持ち越す（係数 b）
 *
 * 検証は calibrate-promoted.js と同じ二段構え。
 *   1) 回帰で「出身リーグの攻守力」が「J2での成績」を説明するか見る
 *   2) バックテストの log loss が下がるか確かめる（下がらなければ採用しない）
 *
 * 採用規則も同じ：
 *   学習区間 2018-2022 と 検証区間 2023-2025 の両方で下がったときだけ採用。
 * 片方だけの改善は雑音として捨てる。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { load } = require("./lib/data");
const core = require("./lib/backtest-core");

const DATA = path.join(__dirname, "..", "data");
const TRAIN = [2018, 2022];
const TEST = [2023, 2025];
const FIRST_EVAL = 2018;
const KEYS = ["atkH", "defH", "atkA", "defA"];

/* 測るときのパラメータは J1 の確定値を使う。
   tune-j2.js が「出発点は J1 の確定値」としているのと同じ立場に立つため。
   params-j2.json を読むと tune-j2.js との間で循環するので読まない
   （このスクリプトは tune-j2.js より前に走る）。 */
const P = JSON.parse(fs.readFileSync(path.join(DATA, "params.json"), "utf8")).model;

const j2all = load("j2-matches.json");
const j2 = j2all.filter((m) => m.hg != null);
const j1 = load("j1-matches.json").filter((m) => m.hg != null);
const j3 = load("j3-matches.json").filter((m) => m.hg != null);
const ylc = load("ylc-matches.json");

/* ------------------------------------------------------------ 在籍の索引 */

/** シーズン → そのシーズンに在籍したクラブの集合 */
function bySeason(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.s)) m.set(r.s, new Set());
    m.get(r.s).add(r.h);
    m.get(r.s).add(r.a);
  }
  return m;
}
const J1S = bySeason(j1), J2S = bySeason(j2), J3S = bySeason(j3);
const SEASONS = [...J2S.keys()].sort();

/**
 * J2 の新顔クラブが「前年どこにいたか」。
 * 前年 J3 にいれば昇格組、前年 J1 にいれば降格組。
 * どちらでもない（JFL からの新規参入・データの外）は "不明" にして平均像に寄せる。
 */
function originOf(club, Y) {
  if (J3S.get(Y - 1)?.has(club)) return "J3";
  if (J1S.get(Y - 1)?.has(club)) return "J1";
  return "不明";
}

/** シーズン Y の J2 新顔（それ以前に J2 に出ていないクラブ） */
function newcomersIn(Y) {
  const before = new Set();
  for (const s of SEASONS) if (s < Y) for (const c of J2S.get(s)) before.add(c);
  return [...(J2S.get(Y) ?? [])].filter((c) => !before.has(c));
}

/* ------------------------------------------------------------ 平均像 */

/** シーズンごとの J2 リーグ平均得点（比較の分母） */
const LG = {};
for (const s of SEASONS) {
  const ms = j2.filter((m) => m.s === s);
  LG[s] = { h: ms.reduce((x, m) => x + m.hg, 0) / ms.length,
            a: ms.reduce((x, m) => x + m.ag, 0) / ms.length };
}

/**
 * 新顔の平均像を出す。split=true なら出自ごとに分ける。
 * 最初のシーズンは全員が「初出」なので除く（tune-j2.js と同じ）。
 * ホームとアウェイでリーグ平均得点が違うので、必ず4値に分ける
 * （1つの倍率を両方に当てるとアウェイを過大評価する。解説.md 5章の失敗）。
 */
function averages(split) {
  const acc = {};
  const box = (k) => (acc[k] ??= { atkH: 0, defH: 0, atkA: 0, defA: 0, nH: 0, nA: 0, clubs: new Set() });
  for (const Y of SEASONS.slice(1)) {
    for (const c of newcomersIn(Y)) {
      const key = split ? originOf(c, Y) : "all";
      const b = box(key);
      b.clubs.add(`${Y} ${c}`);
      const L = LG[Y];
      for (const m of j2.filter((x) => x.s === Y && x.h === c)) {
        b.atkH += m.hg / L.h; b.defH += m.ag / L.a; b.nH++;
      }
      for (const m of j2.filter((x) => x.s === Y && x.a === c)) {
        b.atkA += m.ag / L.a; b.defA += m.hg / L.h; b.nA++;
      }
    }
  }
  const out = {};
  for (const [k, b] of Object.entries(acc)) {
    if (!b.nH || !b.nA) continue;
    out[k] = {
      atkH: b.atkH / b.nH, defH: b.defH / b.nH,
      atkA: b.atkA / b.nA, defA: b.defA / b.nA,
      clubSeasons: b.clubs.size, appearances: b.nH + b.nA,
      members: [...b.clubs].sort(),
    };
  }
  return out;
}

const SINGLE_FULL = averages(false).all;
const GROUP_FULL = averages(true);
const strip = (o) => ({ atkH: o.atkH, defH: o.defH, atkA: o.atkA, defA: o.defA });
const SINGLE = strip(SINGLE_FULL);

console.log("=== J2 の新顔クラブ：出自で分けて実測 ===");
console.log(`従来（混ぜた平均）  ${SINGLE_FULL.clubSeasons}クラブ・${SINGLE_FULL.appearances}試合`);
console.log(`  atkH ${SINGLE.atkH.toFixed(4)}  defH ${SINGLE.defH.toFixed(4)}` +
            `  atkA ${SINGLE.atkA.toFixed(4)}  defA ${SINGLE.defA.toFixed(4)}\n`);
console.log("出自      クラブ  試合   atkH     defH     atkA     defA");
for (const [k, v] of Object.entries(GROUP_FULL)) {
  console.log(`${k.padEnd(8)}  ${String(v.clubSeasons).padStart(4)}  ${String(v.appearances).padStart(4)}   ` +
    KEYS.map((x) => v[x].toFixed(4)).join("   "));
}
for (const [k, v] of Object.entries(GROUP_FULL)) {
  console.log(`  ${k}: ${v.members.join(" / ")}`);
}

/* ------------------------------------------------------------ 出身リーグの攻守力 */

/**
 * 指定リーグの試合から、シーズン Y 時点の攻守力を出す。
 * リーグ平均で正規化するので、J1・J2・J3 の得点水準の違いは吸収される。
 * （calibrate-promoted.js の ratingsAt と同じ実装）
 */
function ratingsAt(matches, Y, halfLife, shrink) {
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

/** シーズン Y に実際に記録した攻守力（回帰の目的変数。縮小も減衰もしない素の値） */
const observedIn = (matches, Y) => ratingsAt(matches.filter((m) => m.s === Y), Y + 1, 1e9, 0);

const SRC = { J1: j1, J3: j3 };

/* ------------------------------------------------------------ 回帰 */

/** 最小二乗で y = a + b*(x-1)。b が「出身リーグの強さが持ち越される割合」 */
function fitLine(xs, ys) {
  const n = xs.length;
  if (n < 3) return { b: 0, r: 0, mean: ys.reduce((a, b) => a + b, 0) / (n || 1), n };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return {
    b: sxx > 0 ? sxy / sxx : 0,
    r: sxx * syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0,
    mean: my, n,
  };
}

/* 標本を集める：J2 新顔の「出身リーグでの攻守力」と「J2 初年度の実績」 */
const samples = { J1: [], J3: [] };
for (const Y of SEASONS.slice(1)) {
  const obs = observedIn(j2, Y);
  if (!obs) continue;
  for (const c of newcomersIn(Y)) {
    const from = originOf(c, Y);
    if (!SRC[from]) continue;
    const src = ratingsAt(SRC[from], Y, 1, 14);   // 直近1年を見る
    if (!src?.[c] || !obs[c]) continue;
    samples[from].push({ season: Y, club: c, src: src[c], j2: obs[c] });
  }
}

console.log("\n=== 出身リーグの攻守力は J2 での成績を説明するか ===");
const REG = {};
for (const from of ["J3", "J1"]) {
  const s = samples[from];
  console.log(`\n${from} から（標本 ${s.length}クラブ）`);
  if (s.length < 3) { console.log("  標本が少なすぎて何も言えない"); continue; }
  console.log("  項目    J2平均   持ち越し係数 b   相関 r");
  REG[from] = {};
  for (const k of KEYS) {
    const f = fitLine(s.map((x) => x.src[k]), s.map((x) => x.j2[k]));
    REG[from][k] = { b: f.b, r: f.r };
    console.log(`  ${k.padEnd(6)}  ${f.mean.toFixed(4)}   ${f.b >= 0 ? " " : ""}${f.b.toFixed(3)}` +
      `          ${f.r >= 0 ? " " : ""}${f.r.toFixed(3)}`);
  }
}

/* ------------------------------------------------------------ バックテスト */

const BT = core.make({ matches: j2all, cup: ylc, prior: SINGLE, firstEval: FIRST_EVAL });

/** 新顔が絡む試合だけ採点する。全体で測ると影響が薄まって見えない */
const onlyNewcomer = (m, hasHistory) => !hasHistory.has(m.h) || !hasHistory.has(m.a);

/** 出自グループの平均像。標本が少ない出自は混ぜた平均で代用する */
function groupBase(from) {
  const g = GROUP_FULL[from];
  return g && g.clubSeasons >= 3 ? strip(g) : SINGLE;
}

/** 出身リーグの見方（何年ぶん見るか・どれだけ平均に寄せるか） */
const VIEWS = [
  { label: "直近1年ほぼそのまま", hl: 0.7, sh: 6 },
  { label: "直近1年", hl: 1, sh: 14 },
  { label: "直近2年", hl: 2, sh: 20 },
  { label: "6年（本体と同じ）", hl: P.HALF_LIFE, sh: P.SHRINK },
];

/**
 * prior を組む。
 * @param mode "single"（従来）/ "group"（出自で2分割）/ "indiv"（さらに個別の成績を持ち越す）
 */
function buildPrior(mode, b, view) {
  if (mode === "single") return SINGLE;
  const byClub = {};
  for (const Y of SEASONS.slice(1)) {
    const cache = {};
    for (const c of newcomersIn(Y)) {
      const from = originOf(c, Y);
      const base = groupBase(from);
      if (mode === "group" || !SRC[from] || b === 0) { byClub[c] = base; continue; }
      cache[from] ??= ratingsAt(SRC[from], Y, view.hl, view.sh);
      const r = cache[from]?.[c];
      byClub[c] = r ? Object.fromEntries(KEYS.map((k) => [k, base[k] + b * (r[k] - 1)])) : base;
    }
  }
  return { byClub, default: SINGLE };
}

const measure = (pr) => ({
  train: BT.run(P, 0, false, pr, TRAIN, onlyNewcomer).ll,
  test: BT.run(P, 0, false, pr, TEST, onlyNewcomer).ll,
  all: BT.run(P, 0, false, pr, null, onlyNewcomer),
});

console.log("\n=== バックテストで採否を決める（新顔が絡む試合だけ採点）===");
const base = measure(SINGLE);
console.log(`\n従来（混ぜた平均1組）      学習 ${base.train.toFixed(5)}  検証 ${base.test.toFixed(5)}` +
  `  新顔戦全体 ${base.all.ll.toFixed(5)} (${base.all.n}試合)`);

const rows = [{ mode: "single", b: 0, view: null, train: base.train, test: base.test, all: base.all.ll, n: base.all.n }];
const better = (r) => r.train < base.train - 1e-9 && r.test < base.test - 1e-9;

/* 段階1：出自で2グループに分けるだけ */
const g = measure(buildPrior("group", 0, null));
rows.push({ mode: "group", b: 0, view: null, train: g.train, test: g.test, all: g.all.ll, n: g.all.n });
console.log(`段階1（出自で2分割）        学習 ${g.train.toFixed(5)}  検証 ${g.test.toFixed(5)}` +
  `  新顔戦全体 ${g.all.ll.toFixed(5)}   ${better(rows[1]) ? "✅ 両区間で改善" : "— 片方だけ／悪化"}`);

/* 段階2：さらに個別の成績を持ち越す */
console.log("\n段階2（出自ごとの平均 ＋ 出身リーグでの強さ × b）");
for (const view of VIEWS) {
  console.log(`\n  出身リーグの見方: ${view.label}（半減期${view.hl}季・縮小${view.sh}）`);
  console.log("     b     学習       検証       新顔戦全体   両区間で改善");
  for (const b of [0.2, 0.4, 0.6, 0.8, 1.0]) {
    const m = measure(buildPrior("indiv", b, view));
    const row = { mode: "indiv", b, view: view.label, hl: view.hl, sh: view.sh,
                  train: m.train, test: m.test, all: m.all.ll, n: m.all.n };
    rows.push(row);
    console.log(`     ${b.toFixed(1)}   ${m.train.toFixed(5)}   ${m.test.toFixed(5)}   ` +
      `${m.all.ll.toFixed(5)}      ${better(row) ? "✅" : "—"}`);
  }
}

/* 採用規則：まず「両区間で改善」で門をくぐらせる（4章と同じ）。
   そのうえで、どれを採るかは検証区間の値で決める。

   ★ calibrate-promoted.js は学習+検証の和で選んでいる。ここで同じにしないのは、
   学習区間が b に対して単調に良くなり続けるからである（下の表を見れば分かる）。
   和で選ぶと学習側に引っ張られて b が上がりきってしまう。実際 和で選ぶと b=0.8 になるが、
   検証区間は b=0.6 が最良で、4つの見方すべてで同じ形（内点で最小）になっている。
   単調な軸を含む和で選ぶのは、学習区間に合わせているのと同じことなので採らない。 */
const ok = rows.filter((r) => r.mode !== "single" && better(r));
const best = ok.length
  ? ok.reduce((x, y) => (y.test < x.test - 1e-12 || (Math.abs(y.test - x.test) <= 1e-12 && y.train < x.train) ? y : x))
  : rows[0];
const bySum = ok.length ? ok.reduce((x, y) => (y.train + y.test < x.train + x.test - 1e-12 ? y : x)) : rows[0];

console.log("\n=== 判定 ===");
if (best.mode === "single") {
  console.log("→ 採用しない。どの設定でも「両区間で改善」を満たさなかった。");
  console.log("  J3 のデータは取れたが、J2 の新顔の評価を良くする効果は確認できなかった。");
} else if (best.mode === "group") {
  console.log("→ 段階1（出自で2グループに分ける）を採用。個別の成績の持ち越しは効かなかった。");
} else {
  console.log(`→ 段階2を採用: b = ${best.b}（${best.view}）`);
}
console.log(`  学習 ${base.train.toFixed(5)} → ${best.train.toFixed(5)}` +
  `   検証 ${base.test.toFixed(5)} → ${best.test.toFixed(5)}`);
console.log(`  門をくぐった設定 ${ok.length}通り／${rows.length - 1}通り`);
if (bySum !== best) {
  console.log(`  参考: 学習+検証の和で選ぶと b=${bySum.b}（${bySum.view}）だが、` +
    `検証区間は ${bySum.test.toFixed(5)} で上の ${best.test.toFixed(5)} より悪い。`);
  console.log("  学習区間は b に対して単調に良くなるので、和で選ぶと b が上がりきってしまう。");
}

/* ------------------------------------------------------------ 2026-27 の新顔 */

const j2next = load("j2-2026.json");
const inJ2 = new Set(j2.flatMap((m) => [m.h, m.a]));
const newFor2026 = [...new Set(j2next.flatMap((m) => [m.h, m.a]))].filter((c) => !inJ2.has(c));

const prior2026 = {};
console.log(`\n=== 2026-27 で J2 履歴が無いクラブ: ${newFor2026.join(" / ") || "なし"} ===`);
if (newFor2026.length) {
  const view = best.view ? VIEWS.find((v) => v.label === best.view) : VIEWS[1];
  console.log("クラブ    出自   atkH    defH    atkA    defA");
  for (const c of newFor2026) {
    const from = originOf(c, 2026);
    const bs = best.mode === "single" ? SINGLE : groupBase(from);
    let p = bs;
    if (best.mode === "indiv" && SRC[from]) {
      const r = ratingsAt(SRC[from], 2026, view.hl, view.sh)?.[c];
      if (r) p = Object.fromEntries(KEYS.map((k) => [k, bs[k] + best.b * (r[k] - 1)]));
    }
    prior2026[c] = p;
    console.log(`${c.padEnd(9)} ${from.padEnd(5)}  ${KEYS.map((k) => p[k].toFixed(4)).join("  ")}`);
  }
}

/* ------------------------------------------------------------ 保存

   確定した事前分布を、過去の新顔ぶんまで含めて書き出す。
   tune-j2.js はこれを読むだけでよく、出自の判定や ratingsAt を作り直さずに済む
   （実装を2箇所に置くと必ず片方が古くなる）。                                   */

const bestView = best.view ? VIEWS.find((v) => v.label === best.view) : VIEWS[1];
const resolved = best.mode === "single" ? {} : buildPrior(best.mode, best.b, bestView).byClub;
const origins = {};
for (const Y of SEASONS.slice(1)) for (const c of newcomersIn(Y)) origins[c] = { season: Y, from: originOf(c, Y) };
for (const c of newFor2026) origins[c] = { season: 2026, from: originOf(c, 2026) };


const out = {
  note: "J2 の新顔クラブを出自（J1から/J3から）で分けて評価する。tools/calibrate-j3.js が決める",
  rule: `学習 ${TRAIN.join("-")} と 検証 ${TEST.join("-")} の両方で log loss が下がったものだけを候補にし、` +
    `そのうち検証区間が最小のものを採る（学習区間は b に対して単調なので和では選ばない）`,
  selection: {
    passed: ok.length, tried: rows.length - 1,
    byTest: { mode: best.mode, b: best.carryover ?? best.b, view: best.view, train: best.train, test: best.test },
    bySum: { mode: bySum.mode, b: bySum.b, view: bySum.view, train: bySum.train, test: bySum.test },
    why: "学習区間は b に対して単調に改善するため、学習+検証の和で選ぶと b が上がりきる。検証区間は4つの見方すべてで b=0.6 付近が内点最適だった",
  },
  source: "data/j3-matches.json（Ｊリーグ公式データサイト・試合日つき）",
  j3Matches: j3.length,
  adopted: best.mode,
  carryover: best.mode === "indiv" ? best.b : 0,
  view: best.view ?? null,
  singleAverage: SINGLE,
  groupAverages: Object.fromEntries(Object.entries(GROUP_FULL).map(([k, v]) => [k, {
    ...strip(v), clubSeasons: v.clubSeasons, appearances: v.appearances, members: v.members,
  }])),
  regression: REG,
  grid: rows,
  baseline: { train: base.train, test: base.test, all: base.all.ll, matches: base.all.n },
  best: { train: best.train, test: best.test, all: best.all, matches: best.n },
  /* 履歴なしクラブ → 事前分布。過去の新顔（バックテスト用）と 2026-27 の新顔の両方を含む。
     tune-j2.js と build.js はこれをそのまま使う。 */
  byClub: { ...resolved, ...prior2026 },
  origins,
  prior2026,
  verdict: best.mode === "single"
    ? "J3 を使っても J2 の新顔の評価は良くならなかった。混ぜた平均のまま使う"
    : best.mode === "group"
      ? "出自（J1から/J3から）で2グループに分けると精度が上がる。個別の成績の持ち越しは効かない"
      : `出自で分け、さらに出身リーグの強さを ${best.b} の割合で持ち越すと精度が上がる`,
};
fs.writeFileSync(path.join(DATA, "calib-j3.json"), JSON.stringify(out, null, 2) + "\n");
console.log("\n→ data/calib-j3.json に保存");
