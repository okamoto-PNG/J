/**
 * データとアプリの整合性を全部まとめて検算する。
 *
 *   node tools/verify.js
 *
 * 「取れた」と「正しい」は別。データが満たすべき条件を書き出して機械に確かめさせる。
 * データやアプリを触ったら、必ずこれを通すこと。
 * 落ちた項目があれば終了コード 1 で終わる。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { load, dayNum } = require("./lib/data");
/* ★年・試合数・節数を直書きしない。すべて data/season.json とデータ自身から出す。
   直書きすると来季この検算ファイルを手で直すことになり、必ず直し忘れる。 */
const SEASON_INFO = require("./lib/season").require();

const ROOT = path.join(__dirname, "..");
let ng = 0, ok = 0;

function check(label, cond, detail = "") {
  if (cond) { ok++; console.log(`  ✅ ${label}`); }
  else { ng++; console.log(`  ❌ ${label}${detail ? "  … " + detail : ""}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
/**
 * ★中身を見るための読み取りは、必ずこれを通すこと。
 *   このリポジトリは core.autocrlf=true なので、git pull / checkout のたびに
 *   作業ツリーが CRLF になる。行で区切って探す検算はそれだけで落ちる
 *   （実際「節別予想.html のモデルが Node で動く」が2度落ちた）。
 *   ファイルが壊れていないかを見る検算（auto.js の退避と復元）は
 *   1バイトも変えてはいけないので、そちらは素の readFileSync のままにする。
 */
const readText = (...p2) => fs.readFileSync(path.join(...p2), "utf8").replace(/\r\n/g, "\n");
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

/* ═══════════════════════════════════════════════════ 1. J1 の過去成績 */

const SI = SEASON_INFO;

/* ═══════════════════════════════════════════════════ 0. シーズン境界の自己整合 */

section("0. シーズンの境界（data/season.json）");

/* ★ここが「来季コードを触らない」ための土台。
   season.json は parse.js がデータから導いたもの。導出規則どおりになっているかを確かめる。
   ここが狂うと下流の全部が静かにずれるので、いちばん先に見る。 */
check(`予想対象は ${SI.label}（学習は ${SI.first}-${SI.histEnd}）`,
  SI.upcoming === SI.histEnd + 1 && SI.first < SI.histEnd);
check("採点開始が「最初の3季を履歴に回した年」", SI.firstEval === Math.min(SI.first + 3, SI.histEnd),
  `${SI.firstEval} / 期待 ${Math.min(SI.first + 3, SI.histEnd)}`);
check("検証区間が消化済みの最後の区間で終わる", SI.test[1] === SI.histEnd, SI.test.join("-"));
check("学習区間と検証区間が重なっていない", SI.train[1] < SI.test[0], `${SI.train} / ${SI.test}`);
check("学習区間が採点開始から始まる", SI.train[0] === SI.firstEval, SI.train.join("-"));
check("学習区間が空でない", SI.train[0] <= SI.train[1], SI.train.join("-"));
check("予想対象シーズンのファイル名が実在する",
  ["J1", "J2", "J3"].every((k) => fs.existsSync(path.join(ROOT, "data", SI.files[k]))),
  JSON.stringify(SI.files));
check("締切の基準日が予想対象シーズンの最も早い試合日", (() => {
  const ds = ["J1", "J2", "J3"].flatMap((k) => load(SI.files[k]).map((m) => m.date))
    .filter(Boolean).sort();
  return SI.koEpochUTC === Date.parse(ds[0] + "T00:00:00Z") && SI.koEpochDate === ds[0];
})(), SI.koEpochDate);
check("どの試合も基準日以降（負の日数が出ない）", (() => {
  const bad = ["J1", "J2", "J3"].flatMap((k) => load(SI.files[k]))
    .filter((m) => m.date && Date.parse(m.date + "T00:00:00Z") < SI.koEpochUTC);
  return bad.length === 0 || bad.slice(0, 3).map((m) => m.date).join(",");
})() === true, "");
check("古いシーズンの予想対象ファイルが残っていない", (() => {
  const stray = fs.readdirSync(path.join(ROOT, "data"))
    .filter((f) => /^(j1|j2|j3)-(\d{4})\.json$/.test(f))
    .filter((f) => Number(/(\d{4})/.exec(f)[1]) !== SI.upcoming);
  return stray.length === 0 || stray.join(",");
})() === true, "");
console.log(`     学習 ${SI.first}-${SI.histEnd} / 予想対象 ${SI.label} / ` +
  `採点開始 ${SI.firstEval} / 学習区間 ${SI.train.join("-")} / 検証区間 ${SI.test.join("-")}`);
for (const k of ["J1", "J2", "J3"]) {
  const L = SI.leagues[k];
  console.log(`     ${k}: ${L.clubs}クラブ ${L.weeks}節 1節${L.perWeek}試合 計${L.matches}試合`);
}

section(`1. J1 ${SI.first}-${SI.histEnd}（学習データ）`);

const j1 = load("j1-matches.json");
check(`学習データが season.json の記録（${SI.history.J1.matches}試合）と一致`,
  j1.length === SI.history.J1.matches, `実際 ${j1.length}`);
check(`学習データが ${SI.first}-${SI.histEnd} に収まっている`,
  j1.every((m) => m.s >= SI.first && m.s <= SI.histEnd));
check("シーズンが途切れていない（欠けた年が無い）", (() => {
  const ys = [...new Set(j1.map((m) => m.s))].sort((a, b) => a - b);
  return ys.length === SI.histEnd - SI.first + 1 &&
    ys.every((y, i) => y === SI.first + i);
})(), [...new Set(j1.map((m) => m.s))].sort((a, b) => a - b).join(","));

/**
 * ★各シーズンの試合数を表で直書きせず、不変式で確かめる。
 * n クラブが k 回総当たりなら 試合数 = n(n-1)/2 × k で、k は整数になる。
 * 2015-16 の2ステージ制（18クラブ・306試合＝k2）も、20クラブ年（380＝k2）も、
 * これで同じ式に収まる。将来クラブ数が変わっても直さなくてよい。
 */
function roundRobinOk(rows, label) {
  const bad = [];
  for (const s of [...new Set(rows.map((m) => m.s))].sort((a, b) => a - b)) {
    const ms = rows.filter((m) => m.s === s);
    const n = new Set(ms.flatMap((m) => [m.h, m.a])).size;
    const pairs = (n * (n - 1)) / 2;
    const k = pairs ? ms.length / pairs : 0;
    if (!Number.isInteger(k) || k < 1 || k > 4) bad.push(`${s}(${n}クラブ${ms.length}試合)`);
  }
  check(`${label} 各シーズンの試合数がクラブ数と整合する（n(n-1)/2 × 整数回）`,
    bad.length === 0, bad.join(" "));
}
roundRobinOk(j1, "J1");

check("重複した（季・ホーム・アウェイ）が無い",
  new Set(j1.map((m) => `${m.s}|${m.h}|${m.a}`)).size === j1.length);
check("全試合にスコアがある", j1.every((m) => Number.isInteger(m.hg) && Number.isInteger(m.ag) && m.hg >= 0 && m.ag >= 0));
check("全試合に試合日がある", j1.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date)));
/* ★ date が null の試合が混ざっても例外で落ちないようにする（filter を先に置く）。
   検算スクリプトは「落ちる」のではなく「不合格を報告する」のが仕事。
   来季を模擬したとき、ここが TypeError で止まって他の項目が全部見えなくなった。 */
check("試合日がシーズン年と矛盾しない",
  j1.filter((m) => typeof m.date === "string").every((m) => {
    const y = Number(m.date.slice(0, 4));
    return y === m.s || y === m.s + 1;
  }));

/* 各クラブのホーム数とアウェイ数が等しいか。年やクラブ数を直書きせず全シーズン見る
   （2ステージ制の年も「ホームとアウェイが同数」は成り立つ） */
check("どのシーズンも各クラブのホーム数＝アウェイ数", (() => {
  const bad = [];
  for (const s of [...new Set(j1.map((m) => m.s))]) {
    const ms = j1.filter((m) => m.s === s);
    for (const c of new Set(ms.flatMap((m) => [m.h, m.a]))) {
      const h = ms.filter((m) => m.h === c).length, a = ms.filter((m) => m.a === c).length;
      if (h !== a) bad.push(`${s} ${c}(H${h}/A${a})`);
    }
  }
  return bad.length === 0 || bad.join(" ");
})() === true, "");

/* リーグ平均。J1の一般的な水準と一致するか */
const lgH = j1.reduce((s, m) => s + m.hg, 0) / j1.length;
const lgA = j1.reduce((s, m) => s + m.ag, 0) / j1.length;
const hw = j1.filter((m) => m.hg > m.ag).length / j1.length;
const dr = j1.filter((m) => m.hg === m.ag).length / j1.length;
console.log(`     平均得点 ホーム ${lgH.toFixed(3)} / アウェイ ${lgA.toFixed(3)}（差 ${((lgH/lgA-1)*100).toFixed(1)}%）`);
console.log(`     ホーム勝率 ${(hw*100).toFixed(1)}% / 引分率 ${(dr*100).toFixed(1)}% / 平均総得点 ${(lgH+lgA).toFixed(2)}`);
check("ホームがアウェイより得点が多い（ホームアドバンテージ）", lgH > lgA);
check("平均総得点が 2.3〜2.9 の範囲", lgH + lgA > 2.3 && lgH + lgA < 2.9);
check("ホーム勝率が 38〜45%", hw > 0.38 && hw < 0.45);
check("引分率が 22〜28%", dr > 0.22 && dr < 0.28);

/* ═══════════════════════════════════════════════════ 2. 2026-27 の日程 */

section(`2. ${SI.label} シーズンの対戦カード`);

const SH = SI.leagues.J1;                       // 予想対象シーズンの構造（クラブ数・節数など）
const f26 = load(SI.files.J1);
const HALF = SH.clubs - 1;                      // 総当たり2回制ならホーム数＝クラブ数−1
check(`${SH.matches}試合ある`, f26.length === SH.matches, `実際 ${f26.length}`);
const rounds = [...new Set(f26.map((m) => m.round))].sort((a, b) => a - b);
check(`${SH.weeks}節ある`,
  rounds.length === SH.weeks && rounds[0] === 1 && rounds[rounds.length - 1] === SH.weeks);
check(`どの節も${SH.perWeek}試合`,
  rounds.every((r) => f26.filter((m) => m.round === r).length === SH.perWeek));

const clubs26 = [...new Set(f26.flatMap((m) => [m.h, m.a]))].sort();
check(`${SH.clubs}クラブ`, clubs26.length === SH.clubs, clubs26.join(","));
check(`どの節にも${SH.clubs}クラブが1回ずつ出る`, rounds.every((r) => {
  const w = f26.filter((m) => m.round === r);
  return new Set(w.flatMap((m) => [m.h, m.a])).size === SH.clubs;
}));
check(`順序付きの組み合わせ${SH.matches}種が重複なく全部そろう`,
  new Set(f26.map((m) => `${m.h}|${m.a}`)).size === SH.matches);
check(`各クラブ ホーム${HALF}・アウェイ${HALF}試合`, clubs26.every((c) =>
  f26.filter((m) => m.h === c).length === HALF && f26.filter((m) => m.a === c).length === HALF));

const dated = f26.filter((m) => m.date);
check(`試合日がある（${dated.length}/${SH.matches}）`, dated.length >= SH.matches - 1);
check("節が進むと日付も進む（節ごとの中央値が単調）", (() => {
  const med = rounds.map((r) => {
    const ds = f26.filter((m) => m.round === r && m.date).map((m) => dayNum(m.date)).sort((a, b) => a - b);
    return ds[Math.floor(ds.length / 2)];
  });
  return med.every((d, i) => i === 0 || d >= med[i - 1]);
})());
/* 開幕前は全部未記入だが、開幕すれば埋まっていく。season.json の定義は
   「まだ結果が無い試合がある最後のシーズン」なので、見るべきは“残っているか”。
   全部埋まっていたら、そのシーズンはもう予想対象ではない（境界の導出が狂っている）。*/
check("予想対象シーズンに未消化の試合が残っている", f26.some((m) => m.hg === null),
  `未消化 ${f26.filter((m) => m.hg == null).length}/${f26.length}試合`);

const first = f26.filter((m) => m.round === 1).sort((a, b) => dayNum(a.date) - dayNum(b.date))[0];
console.log(`     開幕: ${first.date} ${first.h} vs ${first.a}（${first.venue}）`);
console.log(`     最終節: ${f26.filter((m) => m.round === SH.weeks)[0].date}`);

/* ═══════════════════════════════════════════════════ 3. カップ戦・J2・J3 */

section("3. ルヴァン杯・J2・J3");

const ylc = load("ylc-matches.json");
const j2 = load("j2-matches.json");
const j3 = load("j3-matches.json");
check("ルヴァン杯にデータがある", ylc.length > 600, `${ylc.length}試合`);
check("ルヴァン杯に試合日がある", ylc.filter((m) => m.date).length / ylc.length > 0.98);
check("J2にデータがある", j2.length > 5000, `${j2.length}試合`);
check("J2に試合日がある", j2.filter((m) => m.date).length / j2.length > 0.98);
check("水戸・千葉のJ2成績がある",
  ["水戸", "千葉"].every((c) => j2.filter((m) => (m.h === c || m.a === c) && m.hg != null).length > 300));
for (const c of ["水戸", "千葉"]) {
  const n = j2.filter((m) => (m.h === c || m.a === c) && m.hg != null).length;
  console.log(`     ${c}: J2 ${n}試合`);
}

/* J3。J2 の新顔（J3から上がってきたクラブ）を個別に評価するのに使う */
const j3played = j3.filter((m) => m.hg != null);
check("J3にデータがある", j3.length > 3000, `${j3.length}試合`);
check(`J3が${SI.first}-${SI.upcoming}の全シーズンそろっている`,
  [...new Set(j3.map((m) => m.s))].sort((a, b) => a - b).join(",") ===
  Array.from({ length: SI.upcoming - SI.first + 1 }, (_, i) => SI.first + i).join(","),
  [...new Set(j3.map((m) => m.s))].sort((a, b) => a - b).join(","));
check("J3に試合日がある", j3.filter((m) => m.date).length / j3.length > 0.98);
check(`J3 ${SI.first}-${SI.histEnd} は全試合にスコアがある`,
  j3.filter((m) => m.s <= SI.histEnd).every((m) => Number.isInteger(m.hg)),
  `未消化 ${j3.filter((m) => m.s <= SI.histEnd && m.hg == null).length}件`);
check(`J3 ${SI.label} に未消化の試合が残っている`,
  j3.filter((m) => m.s === SI.upcoming).some((m) => m.hg == null),
  `未消化 ${j3.filter((m) => m.s === SI.upcoming && m.hg == null).length}/` +
  `${j3.filter((m) => m.s === SI.upcoming).length}試合`);
/* ★ J1・J2 と違い、J3 では「同じ順序ペアがシーズン中1回だけ」が成り立たない。
   2015年は13クラブしかなく、同じ組み合わせを最大3回戦っている（総当たり3回制）。
   だから (季・ホーム・アウェイ) の一意性で検算してはいけない。
   代わりに「試合日まで含めれば完全に一意」を確かめる（取得の重複はこれで捕まる）。 */
check("完全な重複（季・試合日・ホーム・アウェイが同じ）が無い（J3）",
  new Set(j3.map((m) => `${m.s}|${m.date}|${m.h}|${m.a}`)).size === j3.length,
  `${j3.length - new Set(j3.map((m) => `${m.s}|${m.date}|${m.h}|${m.a}`)).size}件`);
roundRobinOk(j3, "J3");
console.log(`     J3 ${j3.length}試合（消化 ${j3played.length}）` +
  ` / クラブ ${new Set(j3.flatMap((m) => [m.h, m.a])).size}`);

/* 2026-27 の J2 新顔が J3 側に見つかるか。ここが空だと個別評価が効かない */
const calibJ3 = load("calib-j3.json");
const upFromJ3 = Object.entries(calibJ3.origins ?? {})
  .filter(([, v]) => v.season === SEASON_INFO.upcoming && v.from === "J3").map(([c]) => c);
const j2NoHist = (() => {
  const hist = new Set(j2.filter((m) => m.s <= SI.histEnd && m.hg != null).flatMap((m) => [m.h, m.a]));
  return [...new Set(load(SI.files.J2).flatMap((m) => [m.h, m.a]))].filter((c) => !hist.has(c));
})();
check(`${SI.label} の J2 新顔の出自が J3 として特定できている`,
  j2NoHist.length === 0 || upFromJ3.length > 0,
  j2NoHist.length ? `履歴なし [${j2NoHist}] のうち J3 由来 [${upFromJ3}]` : "新顔なし");
check("その新顔にJ3での成績がある",
  upFromJ3.every((c) => j3played.filter((m) => m.h === c || m.a === c).length > 30),
  upFromJ3.map((c) => `${c}:${j3played.filter((m) => m.h === c || m.a === c).length}`).join(" "));
console.log(`     ${SI.label} J2 の新顔: ${upFromJ3.map((c) =>
  `${c}(J3 ${j3played.filter((m) => m.h === c || m.a === c).length}試合)`).join(" / ")}`);

/* 採用の記録が採用規則と矛盾していないか */
check("calib-j3.json の採否が採用規則と整合している",
  calibJ3.adopted === "single" ||
  (calibJ3.best.train < calibJ3.baseline.train - 1e-9 && calibJ3.best.test < calibJ3.baseline.test - 1e-9),
  `学習 ${calibJ3.baseline.train?.toFixed(5)}→${calibJ3.best.train?.toFixed(5)} / ` +
  `検証 ${calibJ3.baseline.test?.toFixed(5)}→${calibJ3.best.test?.toFixed(5)}`);
console.log(`     J3の採否: ${calibJ3.adopted}（b=${calibJ3.carryover} / ${calibJ3.view ?? "—"}）` +
  `  新顔戦 学習 ${calibJ3.baseline.train.toFixed(5)}→${calibJ3.best.train.toFixed(5)}` +
  ` 検証 ${calibJ3.baseline.test.toFixed(5)}→${calibJ3.best.test.toFixed(5)}`);

/* ═══════════════════════════════════════════════════ 4. パラメータと精度 */

section("4. パラメータと精度");

const params = load("params.json");
const { run } = require("./backtest");
const r = run(params.model, params.fatigue.theta);
console.log(`     log loss ${r.ll.toFixed(5)}  的中率 ${(r.hit*100).toFixed(2)}%  (${r.n}試合)`);
console.log(`     基準率   ${r.llBase.toFixed(5)}         ${(r.hitBase*100).toFixed(2)}%`);
check("params.json に書いてある精度が再現する",
  near(r.ll, params.accuracy.logLoss, 1e-6) && r.n === params.accuracy.matches,
  `実測 ${r.ll.toFixed(6)} / 記録 ${params.accuracy.logLoss.toFixed(6)}`);
check(`検証した試合数が params.json の記録（${params.accuracy.matches}）と一致`,
  r.n === params.accuracy.matches, `実際 ${r.n}`);
check("基準率より log loss が小さい", r.ll < r.llBase);
check("一様(1/3)より log loss が小さい", r.ll < Math.log(3));
check("基準率より的中率が高い", r.hit > r.hitBase);
check("日程補正は θ=0（実測で効果なし）", params.fatigue.theta === 0);

/* ═══════════════════════════════════════════════════ 5. アプリとの整合 */

section("5. アプリ（HTML）とデータの整合");

const j2hist = load("j2-matches.json").filter((m) => m.s <= SI.histEnd && m.hg != null);
const f26j2 = load(SI.files.J2);
const paramsJ2 = load("params-j2.json");
const promotedAvg = load("promoted.json").promotedAverage;

/** HTML に埋め込まれたオブジェクトリテラルを取り出す */
function appConst(html, name) {
  const m = html.match(new RegExp("const " + name + " = (\\{[\\s\\S]*?\\n\\});"));
  if (!m) return null;
  return new Function("return " + m[1])();
}

/** 圧縮データを試合の配列に戻す。基準年は直書きせず season.json の最初のシーズンを使う
    （build.js も学習データの最小シーズンを基準にしている） */
const expand = (clubs, data) => data.split(";").map((row) => {
  const [s, h, a, hg, ag] = row.split(".").map(Number);
  return { s: SI.first + s, h: clubs[h], a: clubs[a], hg, ag };
});
const mkey = (m) => m.s + "|" + m.h + "|" + m.a + "|" + m.hg + "|" + m.ag;

/* --- index.html（J1 単発型。従来の作りのまま） --- */
{
  const html = readText(ROOT, "index.html");
  const CLUBS = JSON.parse(html.match(/const CLUBS = (\[[\s\S]*?\]);/)[1]);
  const dm = html.match(/const DATA =([\s\S]*?);\n/);
  const DATA = [...dm[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
  const embedded = expand(CLUBS, DATA);
  const A = new Set(j1.map(mkey)), B = new Set(embedded.map(mkey));
  check(`index.html の埋め込み試合数が${j1.length}`, embedded.length === j1.length, String(embedded.length));
  check("index.html の埋め込みデータが data/j1-matches.json と完全一致",
    [...A].every((k) => B.has(k)) && [...B].every((k) => A.has(k)));

  const got = {};
  for (const mm of html.match(/const P = \{([\s\S]*?)\};/)[1].matchAll(/(\w+):\s*([\d.eE+-]+)/g)) got[mm[1]] = Number(mm[2]);
  check("index.html のパラメータが data/params.json と一致",
    Object.entries(params.model).every(([k, v]) => got[k] === undefined || near(got[k], v, 1e-9)));

  const gp = {};
  for (const mm of html.match(/const PROMOTED = \{([^}]*)\}/)[1].matchAll(/(\w+):\s*([\d.]+)/g)) gp[mm[1]] = Number(mm[2]);
  check("index.html の PROMOTED が data/promoted.json と一致",
    Object.entries(promotedAvg).every(([k, v]) => near(gp[k], v, 5e-5)));
}

/* --- 節別予想.html（J1・J2 の2リーグ） --- */
const wk = readText(ROOT, "節別予想.html");
const HIST = appConst(wk, "HIST");
const LEAGUES = appConst(wk, "LEAGUES");
const AB = wk.match(/const AB = "([^"]*)";/)[1];

check("節別予想.html に HIST と LEAGUES がある", !!HIST && !!LEAGUES);
check("2リーグ（J1・J2）ぶんある",
  !!(HIST && HIST.J1 && HIST.J2 && LEAGUES && LEAGUES.J1 && LEAGUES.J2));

const LG_SPEC = [
  { key: "J1", hist: j1,     fixtures: f26,   params: params.model,   prior: promotedAvg,       n: j1.length },
  { key: "J2", hist: j2hist, fixtures: f26j2, params: paramsJ2.model, prior: paramsJ2.newcomer, n: j2hist.length },
];

for (const L of LG_SPEC) {
  const H = HIST[L.key], G = LEAGUES[L.key];
  if (!H || !G) { check(L.key + " のデータが埋め込まれている", false); continue; }

  /* 学習データ */
  const emb = expand(H.clubs, H.data);
  const A = new Set(L.hist.map(mkey)), B = new Set(emb.map(mkey));
  check(L.key + " の学習データが " + L.n + "試合", emb.length === L.n, String(emb.length));
  check(L.key + " の学習データが data/ と完全一致",
    [...A].every((k) => B.has(k)) && [...B].every((k) => A.has(k)));

  /* パラメータと事前分布 */
  check(L.key + " のパラメータが data/params" + (L.key === "J2" ? "-j2" : "") + ".json と一致",
    Object.entries(L.params).every(([k, v]) => near(G.P[k], v, 1e-9)),
    JSON.stringify(G.P));
  check(L.key + " の事前分布（履歴なしクラブ）が data/ と一致",
    ["atkH", "defH", "atkA", "defA"].every((k) => near(G.promoted[k], L.prior[k], 5e-5)));

  /* クラブ個別の事前分布（J2 の新顔を J3 から評価した結果）。
     ここが食い違うのは「calib-j3.json を作り直したのに build.js を通していない」場合。 */
  const embByClub = G.promotedByClub ?? {};
  const hasHist = new Set(L.hist.flatMap((m) => [m.h, m.a]));
  const wantByClub = {};
  if (L.key === "J2" && calibJ3.adopted !== "single") {
    for (const c of G.teams) if (calibJ3.byClub?.[c] && !hasHist.has(c)) wantByClub[c] = calibJ3.byClub[c];
  }
  check(L.key + " の個別事前分布のクラブが data/calib-j3.json と一致",
    Object.keys(embByClub).sort().join(",") === Object.keys(wantByClub).sort().join(","),
    `HTML [${Object.keys(embByClub).sort()}] / data [${Object.keys(wantByClub).sort()}]`);
  check(L.key + " の個別事前分布の値が data/calib-j3.json と一致",
    Object.entries(wantByClub).every(([c, v]) =>
      embByClub[c] && ["atkH", "defH", "atkA", "defA"].every((k) => near(embByClub[c][k], v[k], 5e-5))),
    Object.keys(wantByClub).filter((c) => !embByClub[c]).join(","));
  check(L.key + " 個別事前分布は履歴なしクラブにだけ付いている",
    Object.keys(embByClub).every((c) => !hasHist.has(c)),
    Object.keys(embByClub).filter((c) => hasHist.has(c)).join(","));
  if (Object.keys(embByClub).length) {
    console.log(`     ${L.key} 個別事前分布: ` + Object.entries(embByClub)
      .map(([c, v]) => `${c}(atkH ${v.atkH.toFixed(3)})`).join(" / "));
  }

  /* 予想の締切に使うキックオフ。1試合4文字（日付2＋時刻2） */
  const N_MATCH = SI.leagues[L.key].matches;
  check(L.key + ` の kickoffs が${N_MATCH * 4}文字（${N_MATCH}試合×4文字）`,
    G.kickoffs?.length === N_MATCH * 4, String(G.kickoffs?.length));
  if (G.kickoffs?.length === N_MATCH * 4 && G.fixturesRaw?.length === N_MATCH * 2) {
    const EPOCH = SI.koEpochUTC;
    /* 節の中の並びは、利用者の入力を守るため前回のHTMLから引き継ぐことがある
       （tools/build.js の prevWeekOrder）。なので日付順を決め打ちで再現せず、
       「その位置に埋まっている対戦カード」を読んで、その試合の日時と突き合わせる。 */
    const perW = SI.leagues[L.key].perWeek, clubs = SI.leagues[L.key].clubs;
    const byCard = new Map(L.fixtures.map((m) => [m.round + "|" + m.h + "|" + m.a, m]));
    const want = [];
    for (let w = 0; w < SI.leagues[L.key].weeks; w++) {
      for (let i2 = 0; i2 < perW; i2++) {
        const at = w * clubs + i2 * 2;
        const h = G.teams[AB.indexOf(G.fixturesRaw[at])];
        const a = G.teams[AB.indexOf(G.fixturesRaw[at + 1])];
        want.push(byCard.get((w + 1) + "|" + h + "|" + a) ?? { round: w + 1, h, a });
      }
    }
    let bad = 0, noDate = 0, noKo = 0, firstBad = "";
    for (let n = 0; n < N_MATCH; n++) {
      const m = want[n];
      const code = G.kickoffs.slice(n * 4, n * 4 + 4);
      const d = code.slice(0, 2), t = code.slice(2, 4);
      if (!m.date) {
        noDate++;
        if (code !== "....") { bad++; if (!firstBad) firstBad = `第${m.round}節 日程未定なのに ${code}`; }
        continue;
      }
      const days = Math.round((Date.parse(m.date + "T00:00:00Z") - EPOCH) / 86400000);
      const wantD = days.toString(36).padStart(2, "0");
      const tm = m.ko ? m.ko.match(/^(\d{1,2}):(\d{2})$/) : null;
      const wantT = tm
        ? Math.floor((Number(tm[1]) * 60 + Number(tm[2])) / 5).toString(36).padStart(2, "0")
        : "..";
      if (!tm) noKo++;
      if (d !== wantD || t !== wantT) {
        bad++;
        if (!firstBad) firstBad = `第${m.round}節 ${m.h}-${m.a} ${m.date} ${m.ko ?? "未定"} → ${code}（期待 ${wantD}${wantT}）`;
      }
    }
    check(L.key + " の kickoffs が data/ の試合日・K/O時刻と完全一致", bad === 0, firstBad);
    console.log(`     ${L.key} 締切: 日程未定 ${noDate}試合 / K/O時刻未発表 ${noKo}試合（当日0時締切になる）`);
  }

  /* 焼き込んだ公式の結果。
     ★これがアプリの結果の出どころ。Wikipedia ではなく Jリーグ公式データを
       build.js が焼き込んでいるので、ブラウザは通信せずに結果を出せる。
     ★並びは前回から引き継ぐことがあるので、位置ではなく**対戦カード**で突き合わせる。 */
  if (typeof G.results === "string" && G.fixturesRaw?.length === N_MATCH * 2) {
    check(L.key + ` の results が${N_MATCH * 2}文字（${N_MATCH}試合×2文字）`,
      G.results.length === N_MATCH * 2, String(G.results.length));
    const perW = SI.leagues[L.key].perWeek, clubs = SI.leagues[L.key].clubs;
    const byCard = new Map(L.fixtures.map((m) => [m.round + "|" + m.h + "|" + m.a, m]));
    const one = (g) => Math.max(0, Math.min(35, g)).toString(36);
    let bad = 0, filled = 0, firstBad = "";
    for (let w = 0; w < SI.leagues[L.key].weeks; w++) {
      for (let i2 = 0; i2 < perW; i2++) {
        const at = w * clubs + i2 * 2;
        const h = G.teams[AB.indexOf(G.fixturesRaw[at])];
        const a = G.teams[AB.indexOf(G.fixturesRaw[at + 1])];
        const m = byCard.get((w + 1) + "|" + h + "|" + a);
        const code = G.results.slice((w * perW + i2) * 2, (w * perW + i2) * 2 + 2);
        const want = (!m || m.hg == null || m.ag == null) ? ".." : one(m.hg) + one(m.ag);
        if (code !== "..") filled++;
        if (code !== want) {
          bad++;
          if (!firstBad) firstBad = `第${w + 1}節 ${h}-${a} 埋め込み"${code}" / 公式"${want}"`;
        }
      }
    }
    const official = L.fixtures.filter((m) => m.hg != null).length;
    check(L.key + " の results が公式データと一致（対戦カードで突き合わせ）", bad === 0, firstBad);
    check(L.key + ` の results の件数が公式と同じ（${official}試合）`,
      filled === official, `埋め込み${filled} / 公式${official}`);
  } else {
    check(L.key + " に results が焼き込まれている", false,
      "build.js を実行して results を入れること");
  }

  /* 日程 */
  check(L.key + ` の fixturesRaw が${N_MATCH * 2}文字`, G.fixturesRaw.length === N_MATCH * 2, G.fixturesRaw.length + "文字");
  check(L.key + ` の所属クラブが${SI.leagues[L.key].clubs}`, G.teams.length === SI.leagues[L.key].clubs, String(G.teams.length));
  if (G.fixturesRaw.length === N_MATCH * 2 && G.teams.length === SI.leagues[L.key].clubs) {
    const emb2 = [];
    for (let w = 0; w < SI.leagues[L.key].weeks; w++) for (let i2 = 0; i2 < SI.leagues[L.key].perWeek; i2++)
      emb2.push({ round: w + 1,
        h: G.teams[AB.indexOf(G.fixturesRaw[w * SI.leagues[L.key].clubs + i2 * 2])],
        a: G.teams[AB.indexOf(G.fixturesRaw[w * SI.leagues[L.key].clubs + i2 * 2 + 1])] });
    const kf = (m) => m.round + "|" + m.h + "|" + m.a;
    const off = new Set(L.fixtures.map(kf)), e2 = new Set(emb2.map(kf));
    check(L.key + " の日程が公式データと完全一致（節・ホーム・アウェイ）",
      [...off].every((k) => e2.has(k)) && off.size === e2.size,
      "公式" + off.size + "件 / 埋め込み" + e2.size + "件");
    /* 総当たりの制約 */
    let badWeek = 0;
    for (let w = 1; w <= 38; w++) {
      const t = new Set(emb2.filter((m) => m.round === w).flatMap((m) => [m.h, m.a]));
      if (t.size !== 20) badWeek++;
    }
    check(L.key + " どの節も20クラブが1回ずつ", badWeek === 0, badWeek + "節で違反");
    const pairs = new Set(emb2.map((m) => m.h + "|" + m.a));
    check(L.key + " 順序付き380通りが重複なくそろう", pairs.size === 380, String(pairs.size));
  }
  check(L.key + ` の全${SI.leagues[L.key].weeks}節に開催日がある`,
    Array.isArray(G.roundDates) && G.roundDates.filter(Boolean).length === 38,
    (G.roundDates ? G.roundDates.filter(Boolean).length : 0) + "/38");
}

/* ═══════════════════════════════════════════════════ 6. アプリのコードを実際に動かす */

section("6. アプリのモデルを Node で実行");

/**
 * HTML から「データ＋モデル」部分だけを切り出して評価する。
 * 描画（DOM を触る部分）より前で切るので、ブラウザなしで動く。
 * これで「表示している精度＝実際に動いているコードの精度」を保証できる。
 */
function loadAppModel(file) {
  const html = readText(ROOT, file);
  const script = html.match(/<script>\n?"use strict";([\s\S]*?)<\/script>/)[1];
  const cut = script.indexOf("   3) 状態");
  const body = script.slice(0, script.lastIndexOf("/* ===", cut));
  const src = '"use strict";\n' + body + "\nvar STATE = { cond: {}, fit: null };\n" +
    "const NEUTRAL = { rest:6, acl:false, aclAway:false, cup:false, nextBig:false };\n" +
    "return {\n" +
    "  outcome,\n" +
    "  hasLeagues: typeof useLeague !== 'undefined',\n" +
    "  use: (k) => { if (typeof useLeague !== 'undefined') useLeague(k); },\n" +
    "  get CLUBS(){ return CLUBS; },\n" +
    "  get MATCHES(){ return MATCHES; },\n" +
    "  get P(){ return P; },\n" +
    "  get PROMOTED(){ return PROMOTED; },\n" +
    "  get TEAMS(){ return typeof TEAMS !== 'undefined' ? TEAMS : (typeof J1 !== 'undefined' ? J1 : null); },\n" +
    "  get FIXTURES(){ return typeof FIXTURES !== 'undefined' ? FIXTURES : null; },\n" +
    "  get ROUND_DATES(){ return typeof ROUND_DATES !== 'undefined' ? ROUND_DATES : null; },\n" +
    "  fit: () => { STATE.fit = fitRatings.length >= 2 ? fitRatings(MATCHES, SEASON) : fitRatings([]);\n" +
    "               return STATE.fit; },\n" +
    "  predict: (h, a) => predict.length >= 4 ? predict(h, a, NEUTRAL, NEUTRAL) : predict(h, a, false),\n" +
    "};";
  return new Function(src)();
}

/** <script> の中身全体が構文的に正しいか（描画部分も含めて）確かめる */
function syntaxOk(file) {
  const html = readText(ROOT, file);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  try { new Function(script); return null; } catch (e) { return e.message; }
}

for (const file of ["index.html", "節別予想.html"]) {
  const err = syntaxOk(file);
  check(file + " のスクリプト全体が構文エラーなし", err === null, err ?? "");

  let app;
  try { app = loadAppModel(file); }
  catch (e) { check(file + " のモデルが Node で動く", false, e.message); continue; }
  check(file + " のモデルが Node で動く", true);

  /* 2リーグ対応なら両方まわす。index.html は J1 のみ */
  const targets = app.hasLeagues ? LG_SPEC : [LG_SPEC[0]];
  for (const L of targets) {
    const tag = file + (app.hasLeagues ? " [" + L.key + "]" : "");
    app.use(L.key);
    check(tag + " MATCHES が " + L.n + "件に展開される", app.MATCHES.length === L.n, String(app.MATCHES.length));
    const fit = app.fit();

    /* そのリーグの代表的な1カードで、確率と期待得点が壊れていないか */
    const t = app.TEAMS ?? Object.keys(fit.R);
    const [x, y] = [t[0], t[1]];
    const p1 = app.predict(x, y), p2 = app.predict(y, x);
    check(tag + " 勝分敗の合計が1", near(p1.hw + p1.dr + p1.aw, 1, 1e-9));
    check(tag + " 期待得点が現実的（0.3〜3.5）",
      p1.lh > 0.3 && p1.lh < 3.5 && p1.la > 0.3 && p1.la < 3.5,
      p1.lh.toFixed(2) + "-" + p1.la.toFixed(2));

    /* ホームアドバンテージ。
       クラブごとにホーム/アウェイを別々に持つモデルなので、
       「アウェイの方が強いクラブ」では個別カードで逆転しうる（それが狙い）。
       だからリーグ全体で見る。 */
    check(tag + " リーグ平均でホームの方が得点が多い",
      fit.lgH > fit.lgA,
      "ホーム " + fit.lgH.toFixed(3) + " / アウェイ " + fit.lgA.toFixed(3) +
      "（+" + ((fit.lgH / fit.lgA - 1) * 100).toFixed(1) + "%）");
    let haOk = 0, haNg = 0;
    for (const a1 of t) for (const b1 of t) {
      if (a1 === b1) continue;
      const q1 = app.predict(a1, b1), q2 = app.predict(b1, a1);
      if (q1.hw > q2.aw) haOk++; else haNg++;
    }
    check(tag + " 大半のカードでホーム側が有利になる（8割以上）",
      haOk / (haOk + haNg) >= 0.8,
      haOk + "/" + (haOk + haNg) + "カード（逆転 " + haNg + "件＝アウェイに強いクラブ）");

    /* 履歴なしクラブ（昇格したばかりで学習データに居ないクラブ）を
       アプリが「履歴なし」として扱えているか。
       クラブ名を直書きせず、data から出した集合と突き合わせる。
       今季は J1 なら水戸・千葉だが、来季は自動的に別のクラブになる。 */
    const upClubs = new Set(L.fixtures.flatMap((m) => [m.h, m.a]));
    const histClubs = new Set(L.hist.flatMap((m) => [m.h, m.a]));
    const wantNoHist = [...upClubs].filter((c) => !histClubs.has(c)).sort();
    const gotNoHist = [...upClubs].filter((c) => !fit.R[c]).sort();
    check(tag + ` 履歴なしクラブを data と同じに判定する（${wantNoHist.join("・") || "なし"}）`,
      gotNoHist.join(",") === wantNoHist.join(","),
      `アプリ [${gotNoHist}] / data [${wantNoHist}]`);

    /* J2 の新顔が「クラブごとに別の評価」になっているか。
       ここが同じ値なら、個別事前分布が実際には効いていない（埋め込んだだけで使われていない）。
       calib-j3.json の byClub が本当にモデルまで届いているかを、動かして確かめる。 */
    if (L.key === "J2" && Object.keys(calibJ3.priorNext ?? {}).length > 1) {
      const cs = Object.keys(calibJ3.priorNext).filter((c) => (app.TEAMS ?? []).includes(c));
      /* 相手は「履歴のあるクラブ」1つに固定する。相手を変えると比較にならない */
      const foe = (app.TEAMS ?? []).find((c) => fit.R[c] && !cs.includes(c));
      const lam = cs.map((c) => ({ c, l: app.predict(c, foe).lh, atkH: calibJ3.priorNext[c].atkH }));

      check(tag + " 新顔クラブが個別に評価されている（同じ相手でも値が違う）",
        foe && cs.length > 1 && new Set(lam.map((x) => x.l.toFixed(6))).size === cs.length,
        `相手 ${foe} / ` + lam.map((x) => `${x.c}:${x.l.toFixed(4)}`).join(" "));

      /* J3 で攻撃力が高かったクラブほど、J2 での期待得点も高いはず */
      const sorted = [...lam].sort((a, b) => b.atkH - a.atkH);
      check(tag + " 事前分布の攻撃力が高い順に期待得点も高い",
        sorted.every((x, i) => i === 0 || sorted[i - 1].l >= x.l - 1e-9),
        sorted.map((x) => `${x.c}(atkH ${x.atkH.toFixed(3)} → λ ${x.l.toFixed(4)})`).join(" "));

      console.log(`     ${tag} 新顔の期待得点（対 ${foe}）: ` +
        sorted.map((x) => `${x.c} ${x.l.toFixed(3)}`).join(" / "));
    }

    /* 今季の全380試合で確率が壊れないか */
    if (app.FIXTURES) {
      let bad = 0, minL = 9, maxL = 0, n = 0;
      for (const week of app.FIXTURES) for (const m of week) {
        const p = app.predict(m.h, m.a);
        if (!near(p.hw + p.dr + p.aw, 1, 1e-9)) bad++;
        minL = Math.min(minL, p.lh, p.la); maxL = Math.max(maxL, p.lh, p.la); n++;
      }
      check(tag + " " + n + "試合すべてで確率の合計が1", bad === 0, "壊れ " + bad + "件");
      check(tag + " 期待得点が 0.3〜3.5 に収まる", minL > 0.3 && maxL < 3.5,
        minL.toFixed(2) + "〜" + maxL.toFixed(2));
      console.log("     " + tag + " 期待得点レンジ " + minL.toFixed(2) + "〜" + maxL.toFixed(2) +
        " / 第1節 " + app.ROUND_DATES?.[0] + " 〜 第38節 " + app.ROUND_DATES?.[37]);
    }
  }
}

/* ═══════════════════════════════════════════════════ 6-b. 予想の採点と共有 */

section("6-b. 予想の採点と共有（節別予想.html）");

/**
 * 採点と共有は描画（5章）より前に置いてあるので、そこまで切り出せば DOM 無しで動く。
 * localStorage / location / history だけ差し替える。
 * 「表示している的中率＝実際に動いているコードの的中率」を保証するため、
 * 数字を目で確かめるのではなく、答えの分かっている入力を通して検算する。
 */
function loadAppScoring() {
  const html = readText(ROOT, "節別予想.html");
  const script = html.match(/<script>\n?"use strict";([\s\S]*?)<\/script>/)[1];
  const cut = script.indexOf("   5) 描画");
  if (cut < 0) return null;
  const body = script.slice(0, script.lastIndexOf("/* ===", cut));
  const stubs = `
    const localStorage = { getItem: (k) => (__s.has(k) ? __s.get(k) : null),
                           setItem: (k, v) => __s.set(k, String(v)) };
    const location = { href: "https://example.test/a.html", hash: "" };
    const history = { replaceState: () => {} };`;
  const api = `
    return { useLeague, bindLeague, refit, save, load,
      get LG(){ return LG; }, get STATE(){ return STATE; }, get STORE(){ return STORE; },
      get PEERS(){ return PEERS; }, get ME(){ return ME; }, set ME(v){ ME = v; },
      get WEEKS(){ return WEEKS; }, get PER_WEEK(){ return PER_WEEK; },
      get TEAMS(){ return TEAMS; }, get FIXTURES(){ return FIXTURES; },
      scoreboard, fitBefore, baseRates, outcomeOf, recentForm, oddsOf,
      oddsString, parseOddsShare, importOdds, scrapeOdds, scrapeWinner, jstLabel,
      oddsLink, importFromUrl, set hash(v){ location.hash = v; }, get href(){ return location.href; },
      parseOptLabel, modelPOf, clubsIn, predict, optForScore,
      snapshot, undoInfo, undoRestore, firstOpenWeek,
      deadlineOf, isClosed, koKnown, onTime, deadlineLabel,
      encodePicks, decodePicks, encodeFlags, decodeFlags, encodeSealed, decodeSealed,
      encodeBody4, decodeBody4, encodeFlags4, decodeFlags4, encodeSealed4, decodeSealed4,
      importShareAll,
      sha256Hex, sealPayload, sealCodeOf, myCode, ensureSalt, roundDeadline, roundClosed,
      isSealed, sealRound, unsealRound, sealMessage, checkCode,
      parseShare, shareString, shareLink, importShare };`;
  return new Function("__s", '"use strict";' + stubs + body + api)(new Map());
}

const sc = loadAppScoring();
if (!sc) {
  check("節別予想.html から採点部分を切り出せる", false, "「5) 描画」の区切りが見つからない");
} else {
  check("採点・共有のコードが Node で動く", true);
  sc.useLeague("J1"); sc.bindLeague(); sc.refit();
  sc.ME = { name: "検算" };

  /* --- 共有文字列 --- */
  const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  const slots = sc.WEEKS * sc.PER_WEEK * 2;
  const sample = { "1.0": [2, 1], "1.9": [0, 0], "20.4": [10, 35], "38.9": [3, 12] };
  const enc = sc.encodePicks(sample);
  check(`共有文字列が固定長（${sc.WEEKS}節×${sc.PER_WEEK}試合×2文字）`, enc.length === slots, `${enc.length}/${slots}`);
  check("共有文字列が URL に載せられる文字だけ", /^[0-9a-z.]+$/.test(enc));
  check("共有文字列が往復して一致する", canon(sc.decodePicks(enc)) === canon(sample));
  check("長さの違う共有文字列は拒否する", sc.decodePicks(enc.slice(1)) === null);
  for (const k of Object.keys(sc.STATE.picks)) delete sc.STATE.picks[k];
  sc.STATE.picks["1.0"] = [2, 1];
  const ps = sc.parseShare(sc.shareString());
  check("名前と予想が往復する（日本語名も）", ps && ps.name === "検算" && canon(ps.picks) === canon(sc.STATE.picks));
  check("リンク形式（#p=…）からも読める", canon(sc.parseShare(sc.shareLink())?.picks ?? {}) === canon(sc.STATE.picks));
  check("壊れた共有文字列は拒否する",
    sc.parseShare("ゴミ") === null && sc.parseShare("1~J9~a~" + enc) === null);

  /* --- WINNER の倍率（スコア別・表示だけ）--- */
  {
    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    for (const k of Object.keys(sc.STATE.oddsAt)) delete sc.STATE.oddsAt[k];
    check("倍率を入れる前は null", sc.oddsOf("1.0") === null);

    /* 札の読み方。"2 - 1" のような画面の表記も、書き出した "H4" も読めること。
       ★ここが片方だけだと、保存や共有から読み直したときにその口だけ集計から抜ける。 */
    const f0 = sc.FIXTURES[0][0];
    const L = (t) => sc.parseOptLabel(t, f0.h, f0.a);
    check("スコアの札を読める", L("2 - 1")?.label === "2-1" && L("2 - 1").k === "h" &&
      L("0-0")?.k === "d" && L("1 - 2")?.k === "a");
    check("「◯◯4点以上」をどちら側か判別できる",
      L(f0.h + "4点以上")?.label === "H4" && L(f0.a + "4点以上")?.label === "A4" &&
      L("引分4点以上")?.label === "D4");
    check("書き出した札（H4/D4/A4）を読み戻せる",
      L("H4")?.k === "h" && L("D4")?.k === "d" && L("A4")?.k === "a");
    check("知らない札は null", L("とくべつ賞") === null);

    /* 倍率を入れて、割り戻した割合が1になること */
    sc.STATE.odds["1.0"] = { "1-0": 8.7, "0-0": 9.5, "0-1": 7.9, H4: 26.5, D4: 90, A4: 31 };
    sc.STATE.oddsAt["1.0"] = 1789000000000;
    const od = sc.oddsOf("1.0");
    check("口ごとの割合の合計が1",
      Math.abs(od.opts.reduce((a, o) => a + o.p, 0) - 1) < 1e-12);
    check("勝/分/負にまとめても合計が1（打ち切りの口も入る）",
      Math.abs(od.g.h + od.g.d + od.g.a - 1) < 1e-12,
      [od.g.h, od.g.d, od.g.a].map((x) => (x * 100).toFixed(1)).join("/"));
    check("倍率が低い口ほど金が入っている", od.opts[0].odds <= od.opts[1].odds,
      od.opts.slice(0, 2).map((o) => o.label + ":" + o.odds).join(" "));
    check("還元率が 1/Σ(1/倍率) になる", (() => {
      const inv = Object.values(sc.STATE.odds["1.0"]).reduce((a, x) => a + 1 / x, 0);
      return Math.abs(od.payout - 1 / inv) < 1e-12;
    })());
    check("取得時刻が付く", od.at === 1789000000000);
    check("壊れた倍率は受け取らない", (() => {
      sc.STATE.odds["1.1"] = [2, 3, 4];                 // 昔の3択の形
      sc.STATE.odds["1.2"] = {};
      return sc.oddsOf("1.1") === null && sc.oddsOf("1.2") === null;
    })());
    delete sc.STATE.odds["1.1"]; delete sc.STATE.odds["1.2"];

    /* スコアから、対応する口を引けること。
       ぴったりが無ければ「◯点以上」に落とす。ここを間違えると
       「あなたの予想は何倍だったか」が別の口の倍率になる。 */
    {
      const o2 = sc.oddsOf("1.0");
      check("ぴったりの口を引ける", sc.optForScore(o2, 1, 0)?.label === "1-0");
      check("無いスコアは「◯点以上」に落ちる",
        sc.optForScore(o2, 5, 0)?.label === "H4" && sc.optForScore(o2, 0, 7)?.label === "A4" &&
        sc.optForScore(o2, 5, 5)?.label === "D4",
        [sc.optForScore(o2, 5, 0)?.label, sc.optForScore(o2, 0, 7)?.label,
         sc.optForScore(o2, 5, 5)?.label].join("/"));
      check("打ち切りに届かないスコアは引けない（3-0 の口が無ければ null）",
        sc.optForScore(o2, 3, 0) === null);
      check("倍率が無ければ null", sc.optForScore(null, 1, 0) === null);
    }

    /* モデル側の同じ口の確率。打ち切り（4点以上）は足し合わせる */
    const pr = sc.predict(f0.h, f0.a, false);
    const one = sc.modelPOf(pr.grid, L("1 - 0"));
    check("モデル側の1口の確率が grid と一致", Math.abs(one - pr.grid[1][0]) < 1e-12);
    check("打ち切りの口はモデル側も足し合わせる", (() => {
      let want = 0;
      for (let i = 4; i < pr.grid.length; i++) for (let j = 0; j < i; j++) want += pr.grid[i][j];
      return Math.abs(sc.modelPOf(pr.grid, L("H4")) - want) < 1e-12;
    })());
    check("モデル側もすべての口を足すと1に近い", (() => {
      const all = [];
      for (let i = 0; i <= 3; i++) for (let j = 0; j <= 3; j++) all.push(L(i + "-" + j));
      all.push(L("H4"), L("A4"), L("D4"));
      const s2 = all.reduce((a, o) => a + sc.modelPOf(pr.grid, o), 0);
      return s2 > 0.98 && s2 <= 1.0000001;
    })());
  }

  /* --- 倍率を配る（予想の共有とは別枠）--- */
  {
    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    for (const k of Object.keys(sc.STATE.oddsAt)) delete sc.STATE.oddsAt[k];
    check("倍率が1つも無ければ配る文字列は出ない", sc.oddsString(3) === null);

    const at = 1789000000000;
    const one = { "1-0": 8.7, "2-1": 8.8, H4: 26.5, "0-0": 9.5, A4: 31 };
    sc.STATE.odds["3.0"] = one;
    sc.STATE.oddsAt["3.0"] = at;
    const str = sc.oddsString(3);
    check("配る文字列が o2 で始まる", str.startsWith("o2~"), str.slice(0, 20) + "…");
    const got = sc.parseOddsShare(str);
    check("配る文字列が往復して一致する",
      got && got.w === 3 && JSON.stringify(got.odds["3.0"]) === JSON.stringify(one),
      JSON.stringify(got?.odds));
    check("取得時刻も往復する", got && got.at === at, String(got?.at));
    check("壊れた倍率の文字列は拒否する",
      sc.parseOddsShare("o2~J9~3~x~0:1-0/8.7") === null &&
      sc.parseOddsShare("o2~J1~99~" + at.toString(36) + "~0:1-0/8.7") === null &&
      sc.parseOddsShare("o2~J1~3~" + at.toString(36) + "~0:1-0/0") === null &&
      sc.parseOddsShare("o2~J1~3~" + at.toString(36) + "~0:とくべつ/8.7") === null &&
      sc.parseOddsShare("4~J1~x~y~z~w~v") === null);

    /* 受け取り側。予想と結果に触っていないこと */
    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    for (const k of Object.keys(sc.STATE.oddsAt)) delete sc.STATE.oddsAt[k];
    sc.STATE.picks["3.0"] = [2, 1];
    sc.STATE.results["3.0"] = [0, 0];
    const imp = sc.importOdds(str);
    check("受け取った倍率が入る", imp && imp.n === 1 && sc.oddsOf("3.0").raw["1-0"] === 8.7);
    check("受け取った倍率に取得時刻が付く", sc.oddsOf("3.0").at === at);
    check("倍率を受け取っても自分の予想と結果は変わらない",
      JSON.stringify(sc.STATE.picks["3.0"]) === "[2,1]" &&
      JSON.stringify(sc.STATE.results["3.0"]) === "[0,0]");
    delete sc.STATE.picks["3.0"]; delete sc.STATE.results["3.0"];

    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    const r2 = sc.importShareAll("これ今節の倍率ね\n" + str + "\nよろしく");
    check("まとめ貼りの欄に倍率を貼っても拾う",
      r2.odds.length === 1 && r2.done.length === 0, JSON.stringify(r2.odds?.length));
    check("倍率以外の行は読み飛ばす", r2.skipped === 2, String(r2.skipped));
    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    for (const k of Object.keys(sc.STATE.oddsAt)) delete sc.STATE.oddsAt[k];

    /* リンクで配る道。予想の共有リンク（#p=）と同じ仕組み */
    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    for (const k of Object.keys(sc.STATE.oddsAt)) delete sc.STATE.oddsAt[k];
    sc.STATE.odds["3.0"] = one;
    sc.STATE.oddsAt["3.0"] = at;
    const link = sc.oddsLink(3);
    check("倍率のリンクが作れる", link === sc.href.split("#")[0] + "#o=" + sc.oddsString(3), link);
    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    for (const k of Object.keys(sc.STATE.oddsAt)) delete sc.STATE.oddsAt[k];
    sc.hash = "#o=" + str;
    const viaLink = sc.importFromUrl();
    check("リンクから倍率が入る",
      viaLink && viaLink.kind === "odds" && viaLink.w === 3 &&
      sc.oddsOf("3.0")?.raw["1-0"] === 8.7, JSON.stringify(viaLink?.kind));
    /* 貼る途中で % エンコードされても戻せること */
    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    sc.hash = "#o=" + encodeURIComponent(str);
    check("％エンコードされたリンクでも入る",
      sc.importFromUrl()?.kind === "odds" && sc.oddsOf("3.0")?.raw["1-0"] === 8.7);
    /* WINNER のページのリンクを貼っても何も起きないこと */
    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    sc.hash = "#o=https://www.toto-dream.com/winner/index.html";
    check("WINNER のページのリンクでは何も入らない",
      sc.importFromUrl() === null && sc.oddsOf("3.0") === null);
    check("よその文字列を貼っても倍率にはならない",
      sc.importShareAll("https://www.toto-dream.com/winner/index.html").odds.length === 0);
    sc.hash = "";
    for (const k of Object.keys(sc.STATE.odds)) delete sc.STATE.odds[k];
    for (const k of Object.keys(sc.STATE.oddsAt)) delete sc.STATE.oddsAt[k];

    check("日本時間の表示（タイムゾーンに左右されない）",
      sc.jstLabel(Date.parse("2026-09-19T18:40:00+09:00")) === "9/19 18:40",
      sc.jstLabel(Date.parse("2026-09-19T18:40:00+09:00")));
  }

  /* --- WINNER の画面からの読み取り ---
     段組みに依存しないよう「オッズ」の直前が札・直後が倍率という規則だけを使う。
     画面のカードは通し番号つきで縦に並ぶので、その番号を飛ばせることも見る。 */
  {
    const fx = sc.FIXTURES[0][0];
    const card = (n, label, odds) => n + "\n" + label + "\nオッズ\n" + odds + "\n0\n払戻想定金額\n- 円\n";
    const page =
      fx.h + " 対 " + fx.a + "\n" + fx.h + " 勝利 （ホーム勝利）\n1口200円\n" +
      card(1, "1 - 0", "8.7") + card(2, "2 - 0", "16.4") + card(3, "2 - 1", "8.8") +
      card(7, fx.h + "4点以上", "26.5") +
      "引分\n" + card(1, "0 - 0", "9.5") + card(2, "1 - 1", "6.2") + card(5, "引分4点以上", "90.0") +
      fx.a + " 勝利 （アウェイ勝利）\n" +
      card(1, "0 - 1", "7.9") + card(3, "1 - 2", "8.1") + card(7, fx.a + "4点以上", "31.0");
    const got = sc.scrapeWinner(page);
    check("WINNER の画面から倍率を読み取れる", got && Object.keys(got.raw).length === 10,
      got ? Object.keys(got.raw).length + "口" : "読めなかった");
    check("どの試合かを日程から特定する", got && got.w === 1 && got.i === 0 && got.h === fx.h);
    check("カードの通し番号を札と間違えない", got && got.raw["1-0"] === 8.7 && got.raw["2-1"] === 8.8,
      JSON.stringify(got?.raw));
    check("「◯◯4点以上」も拾う",
      got && got.raw.H4 === 26.5 && got.raw.A4 === 31 && got.raw.D4 === 90);
    check("読めなかった札は報告される", got && Array.isArray(got.unknown));
    check("クラブが1つしか出てこない文章は読まない", sc.scrapeWinner("オッズ\n8.7\n" + fx.h) === null);
    check("今季の日程にない組み合わせは読まない",
      sc.scrapeWinner(fx.h + " 対 " + fx.h + "\n1 - 0\nオッズ\n8.7") === null);
    check("クラブ名は長いほうから当てる（略称に食われない）", (() => {
      const cs = sc.clubsIn(fx.h + " 対 " + fx.a);
      return cs.includes(fx.h) && cs.includes(fx.a);
    })());

    /* ★複数試合を続けて貼ったとき、別の試合の倍率が1試合に混ざらないこと。
       混ざっても黙って入るので、ここが崩れると気づけない。 */
    const mk = (fx3, base) =>
      fx3.h + " 勝利 （ホーム勝利）\n1口200円\n" +
      card(1, "1 - 0", String(base)) + card(2, "2 - 1", String(base + 1)) +
      "引分\n" + card(1, "0 - 0", "6.0") +
      fx3.a + " 勝利 （アウェイ勝利）\n" + card(1, "0 - 1", "7.0");
    const g0 = sc.FIXTURES[1][0], g1 = sc.FIXTURES[1][1], g2 = sc.FIXTURES[1][2];
    const glued = mk(g0, 8.5) + mk(g1, 3.2) + mk(g2, 5);      // 区切りの空行なし
    const three = sc.scrapeOdds(glued, 2);
    check("続けて貼った3試合ぶんを別々に読む（空行が無くても）", three.length === 3,
      three.map((x) => x.h + "-" + x.a).join(" / "));
    check("別の試合の倍率が混ざらない",
      three[0]?.raw["1-0"] === 8.5 && three[1]?.raw["1-0"] === 3.2 && three[2]?.raw["1-0"] === 5,
      three.map((x) => x.raw["1-0"]).join(","));
    check("1試合あたりの口数が増えていない（混ざっていない証拠）",
      three.every((x) => Object.keys(x.raw).length === 4),
      three.map((x) => Object.keys(x.raw).length).join(","));

    /* 「ホーム勝利」のところだけコピーした場合。クラブ名が1つしか写らない */
    const partial = g0.h + " 勝利 （ホーム勝利）\n" + card(1, "1 - 0", "8.5") + card(3, "2 - 1", "5.4");
    check("見ている節が分かっていれば、クラブ名1つでも試合を決められる",
      sc.scrapeOdds(partial, 2)[0]?.i === 0, JSON.stringify(sc.scrapeOdds(partial, 2)[0]?.raw));
    check("節が分からなければ決め打ちしない（取り違えるくらいなら読まない）",
      sc.scrapeOdds(partial).length === 0);

    /* 2試合ぶんを空行で区切って貼った場合（見出しが無い形） */
    const fx2 = sc.FIXTURES[0][1];
    const page2 = fx2.h + " 対 " + fx2.a + "\n" + card(1, "1 - 0", "5.5") + card(2, "2 - 1", "7.0");
    const two = sc.scrapeOdds(page + "\n\n\n" + page2);
    check("空行で区切った2試合ぶんも別々に読む", two.length === 2,
      two.map((x) => x.h + "-" + x.a).join(" / "));
  }


  /* --- 上書きを取り消せること ---
     「読み込み」と「全部消す」は中身を丸ごと置き換える。向きを間違えると戻せないので、
     直前を1つ取っておく。ここが効かないと、間違えた人は泣き寝入りになる。 */
  {
    const n2 = (o) => Object.keys(o ?? {}).length;
    /* いったん綺麗にしてから、戻したい中身を作る */
    for (const o of [sc.STATE.results, sc.STATE.picks, sc.STATE.pickAt, sc.STATE.sealed,
                     sc.STATE.odds, sc.STATE.oddsAt]) {
      for (const k of Object.keys(o)) delete o[k];
    }
    sc.PEERS.J1 = {};
    sc.STATE.results["1.0"] = [2, 1];
    sc.STATE.results["1.1"] = [0, 0];
    sc.STATE.picks["8.0"] = [1, 0];
    sc.PEERS.J1["たろう"] = { picks: { "8.0": [0, 1] }, flags: {}, salt: "", sealed: {} };
    sc.save();

    sc.snapshot("全部消す");
    const info = sc.undoInfo();
    check("上書きの直前を取っておける",
      info && info.why === "全部消す" && info.results === 2 && info.picks === 1 && info.peers === 1,
      JSON.stringify(info));

    /* 消してから戻す */
    for (const o of [sc.STATE.results, sc.STATE.picks]) for (const k of Object.keys(o)) delete o[k];
    sc.PEERS.J1 = {};
    sc.save();
    check("消えた状態になる", n2(sc.STATE.results) === 0 && n2(sc.PEERS.J1) === 0);
    check("元に戻せる", sc.undoRestore() === true);
    check("結果も予想も仲間の予想も戻る",
      n2(sc.STATE.results) === 2 && n2(sc.STATE.picks) === 1 && n2(sc.PEERS.J1) === 1,
      `結果${n2(sc.STATE.results)} 予想${n2(sc.STATE.picks)} 仲間${n2(sc.PEERS.J1)}`);
    check("戻したあと保存にも残る（再読み込みで消えない）", (() => {
      sc.save(); sc.load(); sc.bindLeague();
      return n2(sc.STATE.results) === 2 && n2(sc.PEERS.J1) === 1;
    })());
    /* もう一度押すと、戻す前に行ける（行き来できる） */
    check("押し直すと戻す前に行ける", (() => {
      sc.undoRestore();
      return n2(sc.STATE.results) === 0 && n2(sc.PEERS.J1) === 0;
    })());
    check("さらに押すとまた戻る", (() => {
      sc.undoRestore();
      return n2(sc.STATE.results) === 2 && n2(sc.PEERS.J1) === 1;
    })());

    for (const o of [sc.STATE.results, sc.STATE.picks]) for (const k of Object.keys(o)) delete o[k];
    sc.PEERS.J1 = {};
    sc.save();
  }

  /* --- 「全部消す」が保存まで消えること ---
     STATE と STORE は同じ実体を指している（bindLeague）。
     STATE.results = {} のように入れ替えると STORE 側に古い中身が残り、
     画面からは消えたのに再読み込みで戻ってくる。実際それが起きていた。 */
  {
    check("STATE と STORE が同じ実体を指している（消去が保存に届く）",
      sc.STATE.results === sc.STORE[sc.LG].results &&
      sc.STATE.odds === sc.STORE[sc.LG].odds);
    /* コメントは外してから見る。外さないと、この決まりを説明した注意書き自身に当たる */
    const code = readText(ROOT, "節別予想.html")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("入れ替えでの消去が残っていない（STATE.results = {} と書かない）",
      !/STATE\.(results|cond|picks|pickAt|sealed|odds)\s*=\s*\{\s*\}/.test(code),
      (code.match(/STATE\.\w+\s*=\s*\{\s*\}/g) ?? []).join(" / "));
  }

  /* --- 直近5試合（順位表の丸）--- */
  {
    for (const k of Object.keys(sc.STATE.results)) delete sc.STATE.results[k];
    const f1 = sc.FIXTURES[0][0];                       // 第1節の1試合目
    sc.STATE.results["1.0"] = [2, 0];                   // ホームの勝ち
    sc.STATE.results["2.0"] = [0, 0];                   // 引き分け
    const f2 = sc.FIXTURES[1][0];
    const fm = sc.recentForm();
    check("直近5：勝ちが w、負けが l になる",
      fm[f1.h][0].r === "w" && fm[f1.a][0].r === "l",
      `${f1.h}=${fm[f1.h][0].r} / ${f1.a}=${fm[f1.a][0].r}`);
    check("直近5：引き分けが d になる",
      fm[f2.h].at(-1).r === "d" && fm[f2.a].at(-1).r === "d");
    check("直近5：得点はそのクラブから見た向きで入る",
      fm[f1.h][0].gf === 2 && fm[f1.h][0].ga === 0 &&
      fm[f1.a][0].gf === 0 && fm[f1.a][0].ga === 2);
    check("直近5：ホーム・アウェイと相手が入る",
      fm[f1.h][0].home === true && fm[f1.h][0].opp === f1.a &&
      fm[f1.a][0].home === false && fm[f1.a][0].opp === f1.h);
    check("直近5：結果が無いクラブは空", (() => {
      const used = new Set([f1.h, f1.a, f2.h, f2.a]);
      return sc.TEAMS.filter((c) => !used.has(c)).every((c) => fm[c].length === 0);
    })());

    /* 6節ぶん入れて、古いほうが落ちること・並びが節の順であることを見る */
    for (const k of Object.keys(sc.STATE.results)) delete sc.STATE.results[k];
    for (let w = 1; w <= 6; w++) {
      for (let i = 0; i < sc.PER_WEEK; i++) sc.STATE.results[`${w}.${i}`] = [1, 0];
    }
    const fm6 = sc.recentForm();
    const some = sc.TEAMS[0];
    check("直近5：6試合入れても5件に切られる", fm6[some].length === 5, String(fm6[some].length));
    check("直近5：節の早い順に並ぶ（末尾が最新）",
      fm6[some].map((m) => m.w).join(",") === "2,3,4,5,6", fm6[some].map((m) => m.w).join(","));
    check("直近5：件数を指定できる", sc.recentForm(3)[some].length === 3);
    for (const k of Object.keys(sc.STATE.results)) delete sc.STATE.results[k];
    sc.refit();
  }

  /* --- 版4（短い共有文字列）---
     「版3と同じ中身を詰め直しただけ」が版4の主張なので、
     往復・版3との一致・短さ・壊れた入力の拒否を見る。 */
  {
    const v4sample = { "1.0": [2, 1], "1.9": [0, 0], "20.4": [10, 35], "38.9": [3, 12] };
    const b4 = sc.encodeBody4(v4sample);
    check("版4の本体が往復して一致する", canon(sc.decodeBody4(b4)) === canon(v4sample));
    check("版4の本体が URL に載せられる文字だけ", /^[0-9a-z.-]+$/.test(b4), b4.slice(0, 20) + "…");
    check("版4も得点0〜35を運べる（版3と同じ範囲）",
      sc.decodeBody4(sc.encodeBody4({ "1.0": [0, 35], "1.1": [35, 0] }))["1.0"][1] === 35);
    check("枠をはみ出す版4の本体は拒否する", sc.decodeBody4("-zz-zz-zz-zz-zz") === null);
    check("桁が足りない版4の本体は拒否する",
      sc.decodeBody4("2") === null && sc.decodeBody4("-1") === null);

    const sl = { 1: 1, 17: 1, 38: 1 };
    check(`版4の封印済みの節が${Math.ceil(sc.WEEKS / 4)}文字`,
      sc.encodeSealed4(sl).length === Math.ceil(sc.WEEKS / 4), sc.encodeSealed4(sl));
    check("版4の封印済みの節が往復して一致する",
      canon(sc.decodeSealed4(sc.encodeSealed4(sl))) === canon(sl));
    check("長さの違う版4の封印は拒否する", sc.decodeSealed4("0") === null);

    const fp = { "1.0": [1, 0], "1.1": [1, 0], "1.2": [1, 0] };
    const at0 = { "1.0": 0, "1.1": 0, "1.2": 0 };                 // 3つとも締切後
    const f4 = sc.encodeFlags4(fp, at0);
    check("版4のフラグが連長圧縮される（3試合ぶんが3文字）", f4.length === 3, f4);
    check("版4のフラグが版3と同じ中身になる",
      canon(sc.decodeFlags4(f4, fp)) === canon(sc.decodeFlags(sc.encodeFlags(fp, at0))));
    check("予想の数より多い版4のフラグは拒否する", sc.decodeFlags4("x0z", fp) === null);
  }

  /* ★「出す形」と「読める形」は別物。
     出すのは**誰でも読める版3**。短い版4で出すと、ページを更新していない相手が
     読めなくなる（実際それで仲間が読み込めなくなった）。
     読むほうは版1〜4すべて。すでに配った版4のリンクを無駄にしないため。 */
  {
    for (const k of Object.keys(sc.STATE.picks)) delete sc.STATE.picks[k];
    for (let i = 0; i < sc.PER_WEEK; i++) sc.STATE.picks[`1.${i}`] = [i % 4, (i + 1) % 3];
    const out = sc.shareString();
    check("いま出す共有文字列は版3（古いページでも読める形）",
      out.startsWith("3~"), out.slice(0, 2));
    check("出した文字列を自分でも読み戻せる",
      canon(sc.parseShare(out)?.picks ?? {}) === canon(sc.STATE.picks));

    /* 版4（短い形）も読めること。送る側が古い版を出しても困らないこと */
    const v4 = ["4", sc.LG, encodeURIComponent(sc.ME.name),
      sc.encodeBody4(sc.STATE.picks), sc.encodeFlags4(sc.STATE.picks, sc.STATE.pickAt),
      sc.ME.salt || "0".repeat(16), sc.encodeSealed4(sc.STATE.sealed)].join("~");
    check("短い版4はたしかに短い", v4.length < out.length,
      `版4 ${v4.length}文字 / 版3 ${out.length}文字`);
    const p4 = sc.parseShare(v4), p3 = sc.parseShare(out);
    check("版4と版3で読み取れる予想が同じ", canon(p4.picks) === canon(p3.picks));
    check("版4と版3で読み取れるフラグが同じ", canon(p4.flags) === canon(p3.flags));
    check("版4でも salt と封印済みの節が往復する",
      p4.salt === p3.salt && canon(p4.sealed) === canon(p3.sealed));
    check("版4もリンク形式（#p=…）から読める",
      canon(sc.parseShare("https://example.test/a.html#p=" + v4)?.picks ?? {}) === canon(p4.picks));
    check("壊れた版4は拒否する",
      sc.parseShare(v4.replace("4~J1~", "4~J9~")) === null &&
      sc.parseShare(v4.replace(/~[0-9a-f]{16}~/, "~zzzz~")) === null);
    /* 版1・版2（もっと古い形）も読めること。仲間のページがどれだけ古くても受け取れる */
    check("版1・版2の古い形も読める",
      sc.parseShare("1~J1~" + encodeURIComponent("旧") + "~" + sc.encodePicks(sc.STATE.picks)) &&
      sc.parseShare(["2", "J1", encodeURIComponent("旧"), sc.encodePicks(sc.STATE.picks),
        sc.encodeFlags(sc.STATE.picks, {})].join("~")) !== null);
  }

  /* --- まとめ貼り（チャットの画面をそのまま貼る）--- */
  {
    const mk = (nm, picks) => ["3", "J1", encodeURIComponent(nm), sc.encodePicks(picks),
      sc.encodeFlags(picks, {}), "abcdef0123456789", sc.encodeSealed({})].join("~");
    const paste = [
      "たろう 20:14",
      "https://okamoto.example/J/#p=" + mk("たろう", { "2.0": [1, 0] }),
      "",
      "じろう 20:31",
      mk("じろう", { "2.0": [0, 2], "2.1": [1, 1] }),
      "さぶろう 21:02",
      "今週は堅く行くわ " + mk("さぶろう", { "2.2": [2, 2] }) + "。",
      "しろう 21:05",
      "明日出す",
    ].join("\n");
    const r = sc.importShareAll(paste);
    check("まとめ貼りで3人ぶんを一度に取り込む", r.done.length === 3,
      r.done.map((d) => d.name + ":" + d.n).join(" / "));
    check("まとめ貼りで名前・時刻・雑談の行は読み飛ばす", r.skipped === 5, String(r.skipped));
    check("まとめ貼りした予想が PEERS に入る",
      sc.PEERS.J1["たろう"]?.picks?.["2.0"]?.[0] === 1 &&
      sc.PEERS.J1["じろう"]?.picks?.["2.1"]?.[1] === 1 &&
      sc.PEERS.J1["さぶろう"]?.picks?.["2.2"]?.[0] === 2);
    check("行末に句点が付いていても読める", r.done.some((d) => d.name === "さぶろう"));
    const self = sc.importShareAll(mk(sc.ME.name, { "3.0": [9, 9] }));
    check("まとめ貼りでも自分と同じ名前は取り込まない",
      self.done.length === 0 && self.self.length === 1, self.self.join(","));
    check("予想が1つも無い貼り付けは何も取り込まない", (() => {
      const z = sc.importShareAll("おつかれ\n明日やる");
      return z.done.length === 0 && z.self.length === 0 && z.skipped === 2;
    })());
  }

  /* --- 締切（キックオフ）--- */
  const dl10 = sc.deadlineOf(1, 0);
  check("第1節の締切が epoch ms で取れる", Number.isFinite(dl10), String(dl10));
  /* data/ 側の第1節（日付順の先頭）の日時と一致するか。時刻は日本時間として扱う */
  {
    const wk1 = load(SI.files.J1).filter((m) => m.round === 1)
      .sort((a, b) => ((a.date ?? "9") < (b.date ?? "9") ? -1 : 1));
    const m0 = wk1[0];
    const want = Date.parse(m0.date + "T" + (m0.ko ? m0.ko : "00:00") + ":00+09:00");
    /* K/O は5分単位で持っている（tools/build.js の koCode）。端数は切り捨てるので、
       締切は公式のキックオフと同じか、最大5分早い。後になってはいけない。 */
    check("締切が公式のキックオフを過ぎていない", dl10 <= want,
      `${new Date(dl10).toISOString()} vs ${new Date(want).toISOString()}（${m0.date} ${m0.ko ?? "未定"}）`);
    check("締切と公式のキックオフの差が5分未満（5分単位で持っているため）",
      want - dl10 < 5 * 60000, `差 ${((want - dl10) / 60000).toFixed(0)}分（${m0.ko ?? "未定"}）`);
    check("K/O時刻の有無を正しく判定する", sc.koKnown(1, 0) === Boolean(m0.ko));
  }
  /* 2026-08-07 が開幕なので、開幕前の時刻では締まっておらず、シーズン後なら締まっている */
  check("締切の前後を判定できる", (() => {
    const before = dl10 - 1000, after = dl10 + 1000;
    return sc.onTime("1.0", before) === "o" && sc.onTime("1.0", after) === "x";
  })());
  check("時刻が分からない予想は不明（?）扱い", sc.onTime("1.0", null) === "?");
  check("日程未定の試合は締切なし・締まらない", (() => {
    /* J1 第20節に1件だけ日付未定がある。その位置を探す */
    const wk = load(SI.files.J1).filter((m) => !m.date ? true : false).length
      ? load(SI.files.J1).filter((m) => m.round === load(SI.files.J1).find((x) => !x.date).round)
      : load(SI.files.J1).filter((m) => m.round === 1)
      .sort((a, b) => ((a.date ?? "9") < (b.date ?? "9") ? -1 : 1));
    const idx = wk.findIndex((m) => !m.date);
    if (idx < 0) return true;                       // 全部発表済みになったら自動的に通る
    return sc.deadlineOf(20, idx) === null && sc.isClosed(20, idx) === false
      && sc.onTime(`20.${idx}`, null) === "o";      // 締まらない試合は「締切後」になり得ない
  })());

  /* --- 締切前フラグの往復 --- */
  check(`フラグ文字列が${sc.WEEKS * sc.PER_WEEK}文字（1試合1文字）`,
    sc.encodeFlags({ "1.0": [1, 0] }, { "1.0": dl10 - 1000 }).length === sc.WEEKS * sc.PER_WEEK);
  check("締切前は o・締切後は x になる", (() => {
    const f = sc.decodeFlags(sc.encodeFlags(
      { "1.0": [1, 0], "1.1": [2, 2] }, { "1.0": dl10 - 1000, "1.1": sc.deadlineOf(1, 1) + 1000 }));
    return f["1.0"] === "o" && f["1.1"] === "x";
  })());
  check("知らない文字のフラグ列は拒否する", sc.decodeFlags("z".repeat(sc.WEEKS * sc.PER_WEEK)) === null);
  check("長さの違うフラグ列は拒否する", sc.decodeFlags("o".repeat(sc.WEEKS * sc.PER_WEEK - 1)) === null);
  check("版1（フラグなし）の共有文字列も読める", (() => {
    const v1 = "1~J1~" + encodeURIComponent("旧版") + "~" + sc.encodePicks({ "1.0": [1, 0] });
    const p = sc.parseShare(v1);
    return p && p.name === "旧版" && p.picks["1.0"][0] === 1 && Object.keys(p.flags).length === 0;
  })());

  /* --- 封印コード（締切をチャットの投稿時刻に証明させる仕組み）--- */

  /* ★ SHA-256 を自分で書いているので、Node の crypto と突き合わせて正しさを確かめる。
     crypto.subtle は file:// で使えない環境があるため自前実装にした。
     境界（55/56/63/64/65バイト＝パディングが1ブロック増える境目）を必ず通す。 */
  {
    const nodeCrypto = require("crypto");
    const cases = ["", "a", "abc", "あいうえお".repeat(20),
      "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(65), "x".repeat(200),
      sc.sealPayload("J1", 1, "0123456789abcdef", { "1.0": [2, 1] })];
    const bad = cases.filter((t) =>
      sc.sha256Hex(t) !== nodeCrypto.createHash("sha256").update(t, "utf8").digest("hex"));
    check("自前の SHA-256 が Node の crypto と一致する（境界長も含め11通り）",
      bad.length === 0, bad.length ? `len=${bad.map((t) => t.length).join(",")}` : "");
  }

  /* 封印できるのは締切前の節だけ。シーズンが進めば第1節は締切後になるので、
     固定せず「まだ締切が来ていない最初の節」を選ぶ。
     全節が締切後（シーズン終了後）なら、封印できることの検算は成り立たないので飛ばす。 */
  let openW = 0, closedW = 0;
  for (let w = 1; w <= sc.WEEKS; w++) {
    if (!openW && !sc.roundClosed(w)) openW = w;
    if (!closedW && sc.roundClosed(w)) closedW = w;
  }
  console.log(`     封印の検算に使う節: 締切前=${openW || "なし"} / 締切後=${closedW || "なし"}`);

  sc.ME = { name: "検算", salt: "0123456789abcdef" };
  for (const k of Object.keys(sc.STATE.picks)) delete sc.STATE.picks[k];
  for (const k of Object.keys(sc.STATE.sealed)) delete sc.STATE.sealed[k];
  sc.STATE.picks["1.0"] = [2, 1];
  sc.STATE.picks["1.1"] = [0, 0];

  const code1 = sc.myCode(1);
  check("封印コードが 4桁-4桁-4桁 の形", /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/.test(code1), code1);
  check("同じ予想なら同じコードになる（再現する）", sc.myCode(1) === code1);
  /* ★予想を1つ変えたらコードが変わること。ここが崩れると封印の意味が無い */
  sc.STATE.picks["1.1"] = [0, 1];
  const code2 = sc.myCode(1);
  check("予想を1つ変えるとコードが変わる（書き換えを検出できる）", code2 !== code1, `${code1} → ${code2}`);
  sc.STATE.picks["1.1"] = [0, 0];
  check("元に戻せばコードも戻る", sc.myCode(1) === code1);
  /* 未記入も封印の対象。あとから足せないようにするため */
  sc.STATE.picks["1.5"] = [1, 1];
  check("未記入だった試合に後から入れてもコードが変わる", sc.myCode(1) !== code1);
  delete sc.STATE.picks["1.5"];
  check("salt が違えば別のコードになる（総当たりで中身を当てられない）",
    sc.sealCodeOf("J1", 1, "fedcba9876543210", sc.STATE.picks) !== code1);
  check("節が違えば別のコードになる", sc.myCode(2) !== code1);
  check("リーグが違えば別のコードになる",
    sc.sealCodeOf("J2", 1, sc.ME.salt, sc.STATE.picks) !== code1);

  /* 封印すると予想が動かせなくなる（変えたらコードが合わなくなるため） */
  if (openW) {
    check(`締切前なら封印できる（第${openW}節）`,
      sc.sealRound(openW) === true && sc.isSealed(openW));
    check(`封印を解ける（第${openW}節）`,
      sc.unsealRound(openW) === true && !sc.isSealed(openW));
    sc.sealRound(openW);
  } else {
    console.log("  ・ 締切前の節が無いため、封印できることの検算は飛ばした（シーズン終了後）");
  }
  if (closedW) {
    /* シーズンが進むと本物の「締切後の節」ができる。開幕前は作れなかった検算。 */
    const wasSealed = sc.isSealed(closedW);
    check(`締切後は封印できない（第${closedW}節）`, sc.sealRound(closedW) === false);
    check(`締切後は封印を解けない（第${closedW}節）`,
      sc.unsealRound(closedW) === false && sc.isSealed(closedW) === wasSealed);
  } else {
    console.log("  ・ 締切後の節がまだ無いため、封印を拒むことの検算は飛ばした（開幕前）");
  }
  check("節の締切は10試合のうち最も早いキックオフ", (() => {
    const all = Array.from({ length: sc.PER_WEEK }, (_, i) => sc.deadlineOf(1, i)).filter((x) => x != null);
    return sc.roundDeadline(1) === Math.min(...all);
  })());
  check("チャット用の文面にコードと名前が入る", (() => {
    const msg = sc.sealMessage(1);
    return msg.includes(code1) && msg.includes("検算") && msg.includes("第1節");
  })());

  /* 照合。共有された予想＋salt からコードを再計算して突き合わせる */
  check("自分のコードを照合できる", (() => {
    const hit = sc.checkCode(code1);
    return hit && hit.week === 1 && hit.me === true;
  })());
  check("区切り文字が無くても照合できる", Boolean(sc.checkCode(code1.replace(/-/g, ""))));
  check("大文字でも照合できる", Boolean(sc.checkCode(code1.toUpperCase())));
  check("でたらめなコードは一致しない", sc.checkCode("0000-0000-0000") === null ||
    sc.checkCode("0000-0000-0000").code !== code1);
  check("桁が足りないコードは拒否する", sc.checkCode("a3f9-21c8") === null);

  /* いま出す共有文字列（版4）に salt と封印済みの節が乗るか */
  const v3 = sc.shareString();
  const p3 = sc.parseShare(v3);
  check("共有文字列に salt が乗る", p3 && p3.salt === sc.ME.salt, p3 && p3.salt);
  if (openW) {
    check("共有文字列に封印済みの節が乗る", p3 && p3.sealed[String(openW)] === 1,
      JSON.stringify(p3?.sealed));
  }
  check(`封印済みの節の文字列が${sc.WEEKS}文字`, sc.encodeSealed({ 1: 1 }).length === sc.WEEKS);
  check("壊れた封印済み文字列は拒否する",
    sc.decodeSealed("2".repeat(sc.WEEKS)) === null && sc.decodeSealed("1".repeat(sc.WEEKS - 1)) === null);
  check("salt が16桁の16進でなければ版3を拒否する",
    sc.parseShare(v3.replace(/~[0-9a-f]{16}~/, "~zzzz~")) === null);
  check("他の人の予想を版3で取り込むと、その人のコードを照合できる", (() => {
    const other = ["3", "J1", encodeURIComponent("佐藤2"),
      sc.encodePicks({ "3.0": [1, 0] }), sc.encodeFlags({ "3.0": [1, 0] }, { "3.0": 0 }),
      "abcdef0123456789", sc.encodeSealed({ 3: 1 })].join("~");
    if (!sc.importShare(other)) return false;
    const want = sc.sealCodeOf("J1", 3, "abcdef0123456789", { "3.0": [1, 0] });
    const hit = sc.checkCode(want);
    return hit && hit.name === "佐藤2" && hit.week === 3 && hit.me === false;
  })());
  delete sc.PEERS.J1["佐藤2"];

  /* 封印した節は予想を変更できない（UI側の判定に使う） */
  if (openW) check("封印した節は変更できない扱いになる", sc.isSealed(openW) === true);
  for (const k of Object.keys(sc.STATE.sealed)) delete sc.STATE.sealed[k];

  /* --- 採点の算数。答えが分かっている入力を通す --- */
  for (const k of Object.keys(sc.STATE.results)) delete sc.STATE.results[k];
  for (const k of Object.keys(sc.STATE.picks)) delete sc.STATE.picks[k];
  const R = [[2, 0], [1, 1], [0, 2], [3, 1], [0, 0]];        // 勝 分 敗 勝 分
  R.forEach((v, i) => { sc.STATE.results["1." + i] = v; });
  Object.assign(sc.STATE.picks, {
    "1.0": [2, 0],   // スコアまで的中
    "1.1": [0, 0],   // 引分的中（スコア違い）
    "1.2": [1, 3],   // アウェイ勝ち的中
    "1.3": [0, 1],   // はずれ
    "1.4": [2, 1],   // はずれ
  });
  let sb = sc.scoreboard();
  const me = sb.people[0];
  check("採点数が「予想を出した試合」の数", me.n === 5, String(me.n));
  check("的中率が 3/5 = 60%", near(me.hitRate, 0.6, 1e-12), String(me.hitRate));
  check("スコア完全的中が 1/5 = 20%", near(me.exactRate, 0.2, 1e-12), String(me.exactRate));
  check("言い切りの予想の Brier が 0.8（的中0・はずれ2）", near(me.brierAvg, 0.8, 1e-12), String(me.brierAvg));
  check("言い切りの予想に log loss は出さない（0%で外すと無限大になる）", me.llAvg === null);
  check("モデルには log loss が出る", Number.isFinite(sb.model.llAvg), String(sb.model.llAvg));
  check("モデルの Brier が 0〜2（確率の合計が1である証拠）",
    sb.model.brierAvg >= 0 && sb.model.brierAvg <= 2, String(sb.model.brierAvg));
  check("基準率の合計が1", near(sb.rate.h + sb.rate.d + sb.rate.a, 1, 1e-12));

  delete sc.STATE.picks["1.4"];
  sb = sc.scoreboard();
  check("予想を出していない試合は採点しない（出さない人が有利にならない）",
    sb.people[0].n === 4 && near(sb.people[0].hitRate, 0.75, 1e-12) && sb.model.n === 5,
    `あなた ${sb.people[0].n}試合 / モデル ${sb.model.n}試合`);
  sc.STATE.picks["1.4"] = [2, 1];

  /* ★締切後に入れた予想を採点に混ぜていないか。
     混ぜると「試合を見てから入力すれば的中率100%」になり、数字の意味が無くなる。 */
  for (let i = 0; i < 5; i++) sc.STATE.pickAt["1." + i] = sc.deadlineOf(1, i) - 1000;   // 全部締切前
  const allOnTime = sc.scoreboard().people[0];
  /* はずれの2件だけを「締切後に入れた」ことにする。的中率が上がってはいけない…
     ではなく、除外されるので 3/3 = 100% になる。件数が減ることが本質 */
  sc.STATE.pickAt["1.3"] = sc.deadlineOf(1, 3) + 1000;
  sc.STATE.pickAt["1.4"] = sc.deadlineOf(1, 4) + 1000;
  const withLate = sc.scoreboard().people[0];
  check("締切前だけなら5試合・的中率60%", allOnTime.n === 5 && near(allOnTime.hitRate, 0.6, 1e-12),
    `${allOnTime.n}試合 ${(allOnTime.hitRate * 100).toFixed(1)}%`);
  check("締切後の予想は採点から外れ、件数が別に数えられる",
    withLate.n === 3 && withLate.late === 2, `採点${withLate.n}試合 / 締切後${withLate.late}件`);
  check("時刻を記録していない予想は「不明」として数える", (() => {
    for (let i = 0; i < 5; i++) delete sc.STATE.pickAt["1." + i];
    const u = sc.scoreboard().people[0];
    return u.n === 5 && u.unknown === 5 && u.late === 0;
  })());

  /* --- ★ここが一番大事：あとで入れた結果でモデルを採点していないか --- */
  const p1 = sc.scoreboard().perMatch.find((m) => m.w === 1 && m.i === 0).model;
  for (let i = 0; i < 10; i++) { sc.STATE.results["2." + i] = [3, 0]; sc.STATE.results["3." + i] = [0, 4]; }
  const sb2 = sc.scoreboard();
  const p2 = sb2.perMatch.find((m) => m.w === 1 && m.i === 0).model;
  check("後の節の結果を入れても第1節のモデル確率が変わらない（未来を使っていない）",
    near(p1.h, p2.h, 1e-12) && near(p1.d, p2.d, 1e-12) && near(p1.a, p2.a, 1e-12),
    `前 ${p1.h.toFixed(6)} → 後 ${p2.h.toFixed(6)}`);
  check("採点数が結果の件数（25）に追いつく", sb2.model.n === 25, String(sb2.model.n));
  const fitH = sc.STATE.fit.lgH;
  sc.scoreboard();
  check("採点しても表示用の fit を壊さない", sc.STATE.fit.lgH === fitH);

  /* --- 他の人の予想 --- */
  sc.PEERS.J1["佐藤"] = { "1.0": [2, 0], "1.1": [1, 0], "1.2": [0, 1] };
  sb = sc.scoreboard();
  const sato = sb.people.find((p) => p.name === "佐藤");
  check("他の人が採点対象に入り、別々に集計される",
    sato && sato.n === 3 && near(sato.hitRate, 2 / 3, 1e-12) && sb.people[0].n === 5,
    sato ? `佐藤 ${sato.n}試合 ${(sato.hitRate * 100).toFixed(1)}%` : "佐藤が居ない");
  const mine = JSON.stringify(sc.STATE.picks);
  sc.importShare("1~J1~" + encodeURIComponent("検算") + "~" + sc.encodePicks({ "5.0": [9, 9] }));
  check("自分と同じ名前の共有は取り込まない（自分の予想を上書きしない）",
    JSON.stringify(sc.STATE.picks) === mine && !sc.PEERS.J1["検算"]);
  /* 版1（フラグなし）で受けてから、版2で送り直す */
  sc.importShare("1~J1~" + encodeURIComponent("鈴木") + "~" + sc.encodePicks({ "1.0": [0, 5] }));
  check("版1の共有も他の人として取り込める", sc.PEERS.J1["鈴木"]?.picks?.["1.0"]?.[1] === 5,
    JSON.stringify(sc.PEERS.J1["鈴木"]));
  const two = { "1.0": [1, 1], "1.1": [1, 1] };
  sc.importShare(["2", "J1", encodeURIComponent("鈴木"), sc.encodePicks(two),
    sc.encodeFlags(two, { "1.0": dl10 - 1000, "1.1": sc.deadlineOf(1, 1) - 1000 })].join("~"));
  const suzu = sc.PEERS.J1["鈴木"];
  check("同じ名前で送り直しても増殖しない（1人のまま）",
    Object.keys(sc.PEERS.J1).filter((k) => k === "鈴木").length === 1);
  check("同じ試合は新しいほうで上書きされる", suzu?.picks?.["1.0"]?.[1] === 1,
    JSON.stringify(suzu?.picks?.["1.0"]));
  /* ★中身の薄い共有文字列が届いても、前に受け取った予想を消さないこと。
     相手がデータを失って送り直したときに、こちらの控えまで道連れにしない。 */
  {
    const before = Object.keys(sc.PEERS.J1["鈴木"].picks).length;
    sc.importShare(["3", "J1", encodeURIComponent("鈴木"),
      sc.encodePicks({ "9.9": [3, 3] }), sc.encodeFlags({ "9.9": [3, 3] }, {}),
      "abcdef0123456789", sc.encodeSealed({})].join("~"));
    const after = sc.PEERS.J1["鈴木"].picks;
    check("中身の薄い共有が来ても、前の予想は残る",
      Object.keys(after).length === before + 1 && after["1.0"] && after["9.9"],
      `${before}件 → ${Object.keys(after).length}件`);
    delete after["9.9"];
  }
  check("他の人の締切前フラグも受け取れる", suzu?.flags?.["1.0"] === "o" && suzu?.flags?.["1.1"] === "o",
    JSON.stringify(suzu?.flags));
  check("旧形式（予想だけ）で保存された他の人も採点できる", (() => {
    sc.PEERS.J1["旧データ"] = { "1.0": [2, 0] };      // {picks,flags} でない形
    const r = sc.scoreboard().people.find((p) => p.name === "旧データ");
    return r && r.n === 1;
  })());

  /* --- 保存形式 --- */
  sc.save();
  console.log(`     採点 ${sb2.model.n}試合で検算 / 共有文字列 ${slots}文字`);
}

/* ═══════════════════════════════════════════════════ 6-d. 自動更新の安全網 */

section("6-d. 自動更新の安全網（tools/auto.js）");

/**
 * auto.js は無人で走る。失敗したときに中途半端な状態を残すと、
 * 次に開いたとき何が正しいのか分からなくなる。
 * だから「退避 → 実行 → 落ちたら復元」の復元がちゃんと働くことを、
 * 実際にファイルを壊して確かめる。ここが効かない安全網は無いのと同じ。
 */
{
  const auto = require("./auto");
  const target = path.join(ROOT, "data", "season.json");
  const original = fs.readFileSync(target, "utf8");

  const kept = auto.backup();
  check("退避が生成物を拾える（10ファイル以上）", kept >= 10, `${kept}ファイル`);
  check("退避先がプロジェクトの外（OneDriveを汚さない）",
    !auto.BACKUP.startsWith(ROOT), auto.BACKUP);

  /* わざと壊してから戻す */
  fs.writeFileSync(target, '{"壊した":true}');
  const strayName = "j1-9999.json";                 // 新しい年が生まれた状況も作る
  const stray = path.join(ROOT, "data", strayName);
  fs.writeFileSync(stray, "[]");

  const restored = auto.restore();
  check("復元でファイルが戻る", restored >= 10, `${restored}ファイル`);
  check("壊したファイルが元の中身に戻る", fs.readFileSync(target, "utf8") === original);
  check("退避後に生まれた予想対象ファイルは消される（新旧が混ざらない）",
    !fs.existsSync(stray), strayName);

  if (fs.existsSync(stray)) fs.unlinkSync(stray);       // 念のため
  auto.clearBackup();
  check("後片付けで退避が消える",
    !fs.existsSync(auto.BACKUP) || fs.readdirSync(auto.BACKUP).length === 0);
  /* 最後にもう一度、本物が壊れていないことを確かめる */
  check("検算の後もデータが元のまま", fs.readFileSync(target, "utf8") === original);
}

/* ═══════════════════════════════════════════ 6-f. 画面が最後まで描けること */

section("6-f. 画面が最後まで描けること（節別予想.html）");

/**
 * ★6-b までの検算は「描画」の手前までしか動かしていない。
 *   そのため renderWeek が例外で落ちても気づけず、
 *   **節ビューに10試合が1つも出ない**状態で公開しかけた（倍率が入っていない試合で
 *   od.opts を触っていた）。画面は検算の外、では済まないのでここで丸ごと走らせる。
 *
 * 本物のブラウザは用意できないので、最低限の代用品の上で動かす。
 * 見るのは「例外を投げずに最後まで行くか」と「入るべきものが入ったか」だけ。
 */
function runWithFakeDom(seed) {
  const src = readText(ROOT, "節別予想.html")
    .match(/<script>\n?"use strict";([\s\S]*?)<\/script>/)[1];
  const made = new Map();
  const mkEl = (id) => ({
    id, innerHTML: "", textContent: "", value: "", disabled: false, dataset: {},
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, click() {}, focus() {}, select() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    querySelectorAll: () => [], querySelector: () => null, closest: () => null,
    appendChild: (x) => x, insertAdjacentHTML() {},
  });
  const el = (id) => { if (!made.has(id)) made.set(id, mkEl(id)); return made.get(id); };
  const store = new Map();
  if (seed) store.set("jleague-2627-weekly", seed);
  const doc = {
    getElementById: el, querySelectorAll: () => [], querySelector: () => null,
    createElement: (t) => mkEl("<" + t + ">"),
    documentElement: mkEl("html"), head: mkEl("head"), body: mkEl("body"), addEventListener() {},
  };
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const loc = { href: "https://example.test/a.html", hash: "" };
  const win = { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}, localStorage: ls };
  const nav = { clipboard: { writeText: async () => {}, readText: async () => "" } };
  new Function("document", "localStorage", "location", "history", "window", "navigator",
    "alert", "confirm", '"use strict";' + src)(
    doc, ls, loc, { replaceState() {} }, win, nav, () => {}, () => true);
  return made;
}

{
  const count = (t, re) => (String(t).match(re) ?? []).length;
  /* 1) まっさらな状態（倍率も結果も無い）。ふつうの人が最初に開く形 */
  let made = null, err = null;
  try { made = runWithFakeDom(null); } catch (e) { err = e; }
  check("まっさらな状態で最後まで描ける（例外を投げない）", !err,
    err ? err.message : "");
  if (made) {
    const wk = made.get("week")?.innerHTML ?? "";
    check("節ビューに10試合ぶんのカードが出る", count(wk, /<div class="match">/g) === 10,
      count(wk, /<div class="match">/g) + "枚");
    check("予想の入力欄が20個（10試合×2）", count(wk, /data-p="/g) === 20,
      count(wk, /data-p="/g) + "個");
    check("結果の入力欄も20個", count(wk, /data-k="/g) === 20, count(wk, /data-k="/g) + "個");
    /* 結果が入っている試合には確率バーを出さない（もう終わった試合なので）。
       公式の結果が焼き込まれたぶん、節によっては10本に満たない。
       「バー＋確定スコア＝10」で見る。 */
    check("確率バーと確定スコアの合計が10",
      count(wk, /<div class="prob">/g) + count(wk, /<div class="done">/g) === 10,
      `バー${count(wk, /<div class="prob">/g)} + 確定${count(wk, /<div class="done">/g)}`);
    check("順位表が描ける", (made.get("table")?.innerHTML ?? "").includes("<table>"));
    /* ★まっさらな状態でも、焼き込んだ公式の結果が入ること（通信は一切しない） */
    check("まっさらでも公式の結果が入る", (() => {
      const saved = made.get("__store__") ? null : null;   // 保存は runWithFakeDom の外
      return (made.get("table")?.innerHTML ?? "").match(/<b>[1-9]/) !== null;
    })(), "順位表に勝ち点が出ているかで見る");
    check("戻せるものが無ければ「元に戻す」は出ない",
      (made.get("undobox")?.innerHTML ?? "") === "",
      (made.get("undobox")?.innerHTML ?? "").slice(0, 40));
    check("的中率・シミュレーション・クラブ状況も描ける",
      (made.get("scoreout")?.innerHTML ?? "").length > 0 &&
      (made.get("simout")?.innerHTML ?? "").length > 0 &&
      (made.get("outList")?.innerHTML ?? "").length > 0);
  }

  /* 1-b) 封印した節。入力できない理由と、その場で解く手立てが出ること。
     「変更できません」とだけ言われて、どうすればいいか分からない状態を防ぐ。 */
  {
    const sealed = JSON.stringify({
      v: 4, lg: "J1",
      store: { J1: { results: {}, cond: {}, week: 38,
        picks: { "38.0": [1, 0] }, pickAt: { "38.0": 1 }, sealed: { 38: 1 },
        odds: {}, oddsAt: {} }, J2: {} },
      me: { name: "検算", salt: "0123456789abcdef" }, peers: { J1: {}, J2: {} },
    });
    let made3 = null, err3 = null;
    try { made3 = runWithFakeDom(sealed); } catch (e) { err3 = e; }
    check("封印した節でも最後まで描ける", !err3, err3 ? err3.message : "");
    if (made3) {
      const wk = made3.get("week")?.innerHTML ?? "";
      check("封印した節では予想を入力できない",
        (wk.match(/data-p="38\.\d+"[^>]*disabled/g) ?? []).length === 20,
        (wk.match(/data-p="38\.\d+"[^>]*disabled/g) ?? []).length + "個");
      check("封印した節でも結果は入力できる（止まるのは予想だけ）",
        !/data-k="38\.\d+"[^>]*disabled/.test(wk));
      /* 締切前なら解くボタン、締切後ならその旨。どちらも出ないのは不親切 */
      check("入力欄のそばに、解く手立てか理由が出る",
        wk.includes('data-unseal="38"') || wk.includes("締切も過ぎている"),
        wk.includes('data-unseal="38"') ? "解くボタンあり" : "締切後の説明あり");
    }
  }

  /* 2) 倍率・結果・予想・他の人の予想が入っている状態。カードの側の道を通す */
  const seed = JSON.stringify({
    v: 4, lg: "J1",
    store: { J1: { results: { "1.0": [2, 1] }, cond: {}, week: 1,
      picks: { "1.0": [1, 0] }, pickAt: { "1.0": 1 }, sealed: {},
      odds: { "1.0": { "1-0": 8.5, "2-1": 5.4, H4: 10.9, "0-0": 6, A4: 20 } },
      oddsAt: { "1.0": 1789000000000 } }, J2: {} },
    me: { name: "検算", salt: "0123456789abcdef" },
    peers: { J1: { 友達: { picks: { "1.0": [0, 2] }, flags: {}, salt: "", sealed: {} } }, J2: {} },
  });
  let made2 = null, err2 = null;
  try { made2 = runWithFakeDom(seed); } catch (e) { err2 = e; }
  check("倍率・結果・予想が入っていても最後まで描ける", !err2, err2 ? err2.message : "");
  if (made2) {
    const wk = made2.get("week")?.innerHTML ?? "";
    check("倍率が入っている試合にカードが出る", count(wk, /class="ocard/g) === 5,
      count(wk, /class="ocard/g) + "枚");
    check("いちばん金が入っている口に印が付く", count(wk, /class="ocard top"/g) === 1,
      count(wk, /class="ocard top"/g) + "個");
    check("倍率が無い試合でも試合カードは出る", count(wk, /<div class="match">/g) === 10,
      count(wk, /<div class="match">/g) + "枚");
    check("他の人の予想も出る", wk.includes("友達"));
    /* 倍率を入れる動機がここ（当てたときに何倍だったか）なので、出ることを見る */
    check("自分の予想が何倍かが出る", wk.includes("あなたの予想") && wk.includes("倍"),
      (wk.match(/あなたの予想 <b>\d+-\d+<\/b>[\s\S]{0,60}/) ?? [""])[0].replace(/<[^>]*>/g, ""));
    check("自分の予想の口に印が付く", wk.includes('class="mark me"'));
    check("結果の口にも印が付く", wk.includes('class="mark hit"'));
    check("順位表に直近5の丸が出る",
      (made2.get("table")?.innerHTML ?? "").includes('class="form"'));
  }
}

/* ═══════════════════════════════════════════════ 6-e. 節の並びが動かないこと */

section("6-e. 日程が変わっても節の中の並びが動かない（tools/build.js）");

/**
 * ★利用者の入力（結果・予想）は localStorage に「節.その節の中の位置」で入っている。
 *   位置は日付順で決めているので、1試合でも延期されると節ぜんたいの位置がずれ、
 *   入れてあった結果や予想が**黙って別の試合に付け替わる**。
 *   build.js の prevWeekOrder が前回の並びを引き継ぐことで防いでいる。
 *
 * 実際に延期を起こして確かめる。プロジェクトは触らず、
 * 一時フォルダにコピーしてそこで build.js を走らせる。
 */
{
  const os = require("os");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "jl-order-"));
  const rawOf = (html, key) => {
    const m = html.match(new RegExp(
      `\\n  ${key}: \\{\\n    label: "${key}",\\n    teams: (\\[[^\\]]*\\]),\\n` +
      `    fixturesRaw:((?:\\s*"[0-9A-Z]*"\\s*\\+?)+)`));
    return m ? m[2].match(/"[0-9A-Z]*"/g).map((x) => x.slice(1, -1)).join("") : null;
  };
  try {
    fs.mkdirSync(path.join(work, "data"));
    fs.mkdirSync(path.join(work, "tools"));
    for (const f of fs.readdirSync(path.join(ROOT, "data")))
      if (f.endsWith(".json")) fs.copyFileSync(path.join(ROOT, "data", f), path.join(work, "data", f));
    fs.mkdirSync(path.join(work, "tools", "lib"));
    for (const f of fs.readdirSync(path.join(ROOT, "tools")))
      if (f.endsWith(".js")) fs.copyFileSync(path.join(ROOT, "tools", f), path.join(work, "tools", f));
    for (const f of fs.readdirSync(path.join(ROOT, "tools", "lib")))          // build.js が require する
      fs.copyFileSync(path.join(ROOT, "tools", "lib", f), path.join(work, "tools", "lib", f));
    for (const f of ["節別予想.html", "index.html"])
      fs.copyFileSync(path.join(ROOT, f), path.join(work, f));

    const before = rawOf(readText(work, "節別予想.html"), "J1");

    /* 第2節の1試合を1週間ずらす（延期の再現） */
    const jf = path.join(work, "data", SI.files.J1.replace(/^.*[\\/]/, ""));
    const rows = JSON.parse(fs.readFileSync(jf, "utf8"));
    const target = rows.find((m) => m.s === SI.upcoming && m.round === 2 && m.date);
    const d = new Date(target.date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 7);
    target.date = d.toISOString().slice(0, 10);
    fs.writeFileSync(jf, JSON.stringify(rows));

    require("child_process").execFileSync(process.execPath, [path.join(work, "tools", "build.js")],
      { cwd: work, stdio: "pipe" });
    const after = rawOf(readText(work, "節別予想.html"), "J1");

    check("延期を起こしても節の中の並びが変わらない（入力が別の試合に付け替わらない）",
      Boolean(before) && before === after,
      before === after ? "" : `${[...(after ?? "")].filter((c, i) => c !== before[i]).length}文字ちがう`);

    /* 引き継ぎが効いていること自体の確認。日付順に並べ直すと本当に動くのか */
    const wk = rows.filter((m) => m.round === 2);
    const sorted = [...wk].sort((a, b) => ((a.date ?? "9") < (b.date ?? "9") ? -1 : 1))
      .map((m) => m.h + "|" + m.a).join(",");
    const kept = wk.map((m) => m.h + "|" + m.a).join(",");
    check("その延期は、日付順に並べ直せば実際に順番が変わるもの（検算が空振りしていない）",
      sorted !== kept, sorted === kept ? "順番が変わらない延期を選んでしまった" : "");
  } catch (e) {
    check("節の並びの検算が走る", false, String(e.message).slice(0, 120));
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 消せなくても害はない */ }
  }
}

/* ═══════════════════════════════════════════════════ 7. 公開用ページ */

section("7. 公開用ページ（publish/）");

/**
 * publish/index.html は「節別予想.html ＋ 結果の自動取得アドオン」。
 * publish/build.js が引数なしだと自分自身を元に組み直すので、
 * 本体を作り直したのに公開版を更新し忘れると、古いモデルのまま配ることになる。
 * ここで本体との一致を毎回確かめて、その取り残しを検出する。
 */
const S_TAG = "<!-- sync-addon:start -->", E_TAG = "<!-- sync-addon:end -->";
const pubFile = path.join(ROOT, "publish", "index.html");
/* アドオンのソースは tools/ にある（publish/ は生成物だけの置き場） */
const addonFile = path.join(ROOT, "tools", "sync-addon.html");

if (!fs.existsSync(pubFile) || !fs.existsSync(addonFile)) {
  check("publish/index.html と tools/sync-addon.html がある", false, "node tools/publish.js を実行していない？");
} else {
  const pub = readText(pubFile);
  const addon = readText(addonFile).trim();
  const i2 = pub.indexOf(S_TAG), j2 = pub.indexOf(E_TAG);
  check("アドオンのブロックが入っている", i2 >= 0 && j2 > i2);

  const stripped = i2 >= 0 && j2 > i2
    ? pub.slice(0, i2).replace(/\s*$/, "\n") + pub.slice(j2 + E_TAG.length).replace(/^\s*/, "\n")
    : pub;
  const norm = (s2) => s2.replace(/\s*$/, "\n");
  check("アドオンを除いた中身が 節別予想.html と完全一致", norm(stripped) === norm(wk),
    "node tools/publish.js を実行すること");
  check("埋め込まれたアドオンが tools/sync-addon.html と一致",
    i2 >= 0 && j2 > i2 && pub.slice(i2, j2 + E_TAG.length).trim() === addon);

  const missing = ["const LEAGUES", "const STATE", "function save(", "function refit(", "function renderAll("]
    .filter((n) => !stripped.includes(n));
  check("アドオンが借りている名前が本体にそろっている", missing.length === 0, missing.join(" / "));

  /* ★見張りが本当に働くかを、答えの分かる文字列で確かめる。
     「個人情報なし」と表示されても仕組みが壊れていれば意味がないので、機能として試す。
     data/leak-words.txt（自分固有の語）の有無は問わない。
     あのファイルは .gitignore してあるので CI には存在せず、
     「無ければ不合格」にすると CI が必ず落ちる（実際に落ちて気づいた）。 */
  const leakLib = require("./lib/leaks");
  check("個人情報の見張りが働く（ローカルの絶対パスを検出できる）",
    leakLib.find("C:\\Users\\someone\\OneDrive\\x").length > 0);
  check("問題ない文字列は検出しない（誤検出しない）",
    leakLib.find("鹿島 2-1 浦和 / 第5節").length === 0);
  if (!leakLib.hasLocalWords()) {
    console.log("     ℹ data/leak-words.txt が無いので汎用の語だけで見ています" +
      "（手元では氏名などを足すと安全です）");
  }
  const leaks = leakLib.find(pub);
  check("個人情報らしき文字列が入っていない", leaks.length === 0, leaks.join(", "));
  const ext = [...pub.matchAll(/<(?:script|link|img|iframe|source)[^>]*\b(?:src|href)="(?!data:|#)([^"]+)"/gi)];
  check("外部から読み込むリソースが0件（1ファイルで完結する）", ext.length === 0, ext.map((m) => m[1]).join(", "));

  const broken = [];
  for (const m of pub.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try { new Function(m[1]); } catch (e) { broken.push(e.message); }
  }
  check("全スクリプトが構文エラーなし（アドオン込み）", broken.length === 0, broken.join(" / "));

  /* 本体一致で担保されるが、落ちたとき原因が分かるように直接も測る */
  const pubL = appConst(pub, "LEAGUES");
  check("公開版のパラメータが data/params*.json と一致",
    !!pubL && LG_SPEC.every((L) => Object.entries(L.params).every(([k, v]) => near(pubL[L.key].P[k], v, 1e-9))),
    pubL ? JSON.stringify({ J1: pubL.J1.P, J2: pubL.J2.P }) : "LEAGUES が読めない");

  /* アドオンが両リーグに対応しているか（クラブコード表の取りこぼしは静かに効く） */
  const addonLeagues = (addon.match(/J1:\s*\{/g) || []).length && (addon.match(/J2:\s*\{/g) || []).length;
  check("アドオンが J1・J2 の両方を知っている", !!addonLeagues,
    "sync-addon.html の WIKI 定義を確認すること");

  console.log("     " + (pub.length / 1024).toFixed(0) + "KB ＝ 本体 " + (stripped.length / 1024).toFixed(0) +
    "KB ＋ アドオン " + (addon.length / 1024).toFixed(0) + "KB");
}

/* ═══════════════════════════════════════════ 7-b. 公開範囲ぜんたい */

section("7-b. リポジトリで公開される範囲（git の追跡ファイル）");

/**
 * 7章は publish/index.html だけを見ている。
 * だが GitHub に push した時点で、**追跡ファイルは全部が公開される**。
 * 公開ページに個人情報が無くても、ソースやデータに混ざっていれば同じことなので、
 * 範囲を「配るファイル1枚」から「リポジトリ全体」に広げる。
 *
 * ★ここで見るのは data/leak-words.txt の固有語（氏名・勤務先・ユーザー名）だけで、
 *   leaks.js の汎用パターンは使わない。
 *   汎用パターンは「生成物に絶対パスが混ざっていないか」を見るためのもので、
 *   ソースや解説文にはそれ自体を説明した記述が正当に出てくる。
 *   実際 OneDrive は罠の説明文に7件、C:\ は取得した生HTMLに含まれる
 *   New Relic の正規表現 `code:\d+` に52件反応する。どちらも実害が無い。
 *   全部を不合格にすると「いつも赤い検算」になり、本当の検出が埋もれる。
 *
 * 固有語は .gitignore してあるので CI には無い。そのときは実施しないと明示する
 * （「無ければ不合格」にすると CI が必ず落ちる。7章で一度踏んでいる）。
 */
let tracked = null;
try {
  tracked = require("child_process")
    .execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] })
    .split("\0").filter(Boolean);
} catch { /* git が無い・リポジトリでない */ }

if (!tracked) {
  console.log("     ℹ git の追跡ファイルが読めないので実施しません（リポジトリの外で動かした？）");
} else {
  check("追跡ファイルの一覧が取れる", tracked.length > 0, `${tracked.length}件`);

  /* ★これが最重要。leak-words.txt は「検出語そのもの」なので、
     追跡された時点で、漏洩を防ぐ仕掛けが漏洩源になる。 */
  check("data/leak-words.txt が追跡されていない（検出語ごと公開されない）",
    !tracked.includes("data/leak-words.txt"));

  /* publish/ は生成物。追跡すると CI の作り直しと衝突する（解説.md の設計） */
  check("publish/ が追跡されていない（生成物を持ち込まない）",
    !tracked.some((f) => f.startsWith("publish/")));

  /* 実行記録は環境ごとに違う。手元の絶対パスが載ることがある */
  check("data/auto-log.txt が追跡されていない",
    !tracked.includes("data/auto-log.txt"));

  const leakLib2 = require("./lib/leaks");
  const localPats = leakLib2.patterns().slice(leakLib2.GENERIC.length);
  if (localPats.length === 0) {
    console.log("     ℹ data/leak-words.txt が無いので固有語の検査は実施しません" +
      "（CI では常にこうなる。手元で氏名などを足すと本当の検査になります）");
  } else {
    /* 見つけても語そのものは出さない。出した時点で検算のログが漏洩源になる */
    const hits = tracked.filter((f) => {
      const p = path.join(ROOT, f);
      return fs.existsSync(p) && localPats.some((re) => re.test(fs.readFileSync(p, "utf8")));
    });
    check(`追跡ファイル ${tracked.length} 件に固有語が入っていない`, hits.length === 0,
      hits.length ? `該当: ${hits.join(" , ")}（語は伏せています）` : "");
  }
}

/* ═══════════════════════════════════════════════════ 結果 */

console.log(`\n${"═".repeat(64)}`);
console.log(ng === 0 ? `全 ${ok} 項目 合格` : `${ok} 件 合格 / ${ng} 件 不合格`);
process.exit(ng === 0 ? 0 : 1);
