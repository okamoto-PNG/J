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

const ROOT = path.join(__dirname, "..");
let ng = 0, ok = 0;

function check(label, cond, detail = "") {
  if (cond) { ok++; console.log(`  ✅ ${label}`); }
  else { ng++; console.log(`  ❌ ${label}${detail ? "  … " + detail : ""}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

/* ═══════════════════════════════════════════════════ 1. J1 の過去成績 */

section("1. J1 2015-2025（学習データ）");

const j1 = load("j1-matches.json");
check("3588試合ある", j1.length === 3588, `実際 ${j1.length}`);

/** 各シーズンの理論試合数。2015-16は2ステージ制、20クラブ年は380 */
const EXPECT = {
  2015: 306, 2016: 306, 2017: 306, 2018: 306, 2019: 306, 2020: 306,
  2021: 380, 2022: 306, 2023: 306, 2024: 380, 2025: 380,
};
for (const [y, n] of Object.entries(EXPECT)) {
  const got = j1.filter((m) => m.s === Number(y)).length;
  check(`${y}年 ${n}試合`, got === n, `実際 ${got}`);
}

check("重複した（季・ホーム・アウェイ）が無い",
  new Set(j1.map((m) => `${m.s}|${m.h}|${m.a}`)).size === j1.length);
check("全試合にスコアがある", j1.every((m) => Number.isInteger(m.hg) && Number.isInteger(m.ag) && m.hg >= 0 && m.ag >= 0));
check("全試合に試合日がある", j1.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date)));
check("試合日がシーズン年と矛盾しない",
  j1.every((m) => { const y = Number(m.date.slice(0, 4)); return y === m.s || y === m.s + 1; }));

/* 各クラブ ホーム19/アウェイ19（20クラブ・1回総当たり2回制のシーズン） */
for (const y of [2021, 2024, 2025]) {
  const s = j1.filter((m) => m.s === y);
  const clubs = [...new Set(s.flatMap((m) => [m.h, m.a]))];
  const bad = clubs.filter((c) =>
    s.filter((m) => m.h === c).length !== 19 || s.filter((m) => m.a === c).length !== 19);
  check(`${y}年 各クラブ ホーム19・アウェイ19試合`, clubs.length === 20 && bad.length === 0, bad.join(","));
}

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

section("2. 2026-27 シーズンの対戦カード");

const f26 = load("j1-2026.json");
check("380試合ある", f26.length === 380, `実際 ${f26.length}`);
const rounds = [...new Set(f26.map((m) => m.round))].sort((a, b) => a - b);
check("38節ある", rounds.length === 38 && rounds[0] === 1 && rounds[37] === 38);
check("どの節も10試合", rounds.every((r) => f26.filter((m) => m.round === r).length === 10));

const clubs26 = [...new Set(f26.flatMap((m) => [m.h, m.a]))].sort();
check("20クラブ", clubs26.length === 20, clubs26.join(","));
check("どの節にも20クラブが1回ずつ出る", rounds.every((r) => {
  const w = f26.filter((m) => m.round === r);
  return new Set(w.flatMap((m) => [m.h, m.a])).size === 20;
}));
check("順序付きの組み合わせ380種が重複なく全部そろう",
  new Set(f26.map((m) => `${m.h}|${m.a}`)).size === 380);
check("各クラブ ホーム19・アウェイ19試合", clubs26.every((c) =>
  f26.filter((m) => m.h === c).length === 19 && f26.filter((m) => m.a === c).length === 19));

const dated = f26.filter((m) => m.date);
check(`試合日がある（${dated.length}/380）`, dated.length >= 379);
check("節が進むと日付も進む（節ごとの中央値が単調）", (() => {
  const med = rounds.map((r) => {
    const ds = f26.filter((m) => m.round === r && m.date).map((m) => dayNum(m.date)).sort((a, b) => a - b);
    return ds[Math.floor(ds.length / 2)];
  });
  return med.every((d, i) => i === 0 || d >= med[i - 1]);
})());
check("結果は未記入（これから予想するシーズン）", f26.every((m) => m.hg === null));

const first = f26.filter((m) => m.round === 1).sort((a, b) => dayNum(a.date) - dayNum(b.date))[0];
console.log(`     開幕: ${first.date} ${first.h} vs ${first.a}（${first.venue}）`);
console.log(`     最終節: ${f26.filter((m) => m.round === 38)[0].date}`);

/* ═══════════════════════════════════════════════════ 3. カップ戦・J2 */

section("3. ルヴァン杯・J2");

const ylc = load("ylc-matches.json");
const j2 = load("j2-matches.json");
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
check("検証した試合数が2670（2018-2025）", r.n === 2670, `実際 ${r.n}`);
check("基準率より log loss が小さい", r.ll < r.llBase);
check("一様(1/3)より log loss が小さい", r.ll < Math.log(3));
check("基準率より的中率が高い", r.hit > r.hitBase);
check("日程補正は θ=0（実測で効果なし）", params.fatigue.theta === 0);

/* ═══════════════════════════════════════════════════ 5. アプリとの整合 */

section("5. アプリ（HTML）とデータの整合");

for (const file of ["index.html", "節別予想.html"]) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  const CLUBS = JSON.parse(html.match(/const CLUBS = (\[[\s\S]*?\]);/)[1]);
  // DATA は 100文字ずつ折って "…" + "…" の形で書かれているので、連結して1本に戻す
  const dm = html.match(/const DATA =([\s\S]*?);\n/);
  const DATA = [...dm[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
  const embedded = DATA.split(";").map((row) => {
    const [s, h, a, hg, ag] = row.split(".").map(Number);
    return { s: 2015 + s, h: CLUBS[h], a: CLUBS[a], hg, ag };
  });
  const key = (m) => `${m.s}|${m.h}|${m.a}|${m.hg}|${m.ag}`;
  const A = new Set(j1.map(key)), B = new Set(embedded.map(key));
  const onlyData = [...A].filter((k) => !B.has(k));
  const onlyHtml = [...B].filter((k) => !A.has(k));
  check(`${file} の埋め込み試合数が3588`, embedded.length === 3588, `${embedded.length}`);
  check(`${file} の埋め込みデータが data/j1-matches.json と完全一致`,
    onlyData.length === 0 && onlyHtml.length === 0,
    `data側のみ${onlyData.length}件 / HTML側のみ${onlyHtml.length}件  例: ${onlyHtml[0] ?? onlyData[0] ?? ""}`);

  /* パラメータ定数の一致 */
  const pm = html.match(/const P = \{([\s\S]*?)\};/);
  if (pm) {
    const got = {};
    for (const mm of pm[1].matchAll(/(\w+):\s*([\d.eE+-]+)/g)) got[mm[1]] = Number(mm[2]);
    const diff = Object.entries(params.model)
      .filter(([k, v]) => got[k] !== undefined && !near(got[k], v, 1e-9))
      .map(([k, v]) => `${k}: HTML ${got[k]} / params ${v}`);
    check(`${file} のパラメータが data/params.json と一致`, diff.length === 0, diff.join(", "));
  }

  /* 昇格クラブの事前分布 */
  const prm = html.match(/const PROMOTED = \{([^}]*)\}/);
  if (prm) {
    const got = {};
    for (const mm of prm[1].matchAll(/(\w+):\s*([\d.]+)/g)) got[mm[1]] = Number(mm[2]);
    const pr = load("promoted.json").promotedAverage;
    const diff = Object.entries(pr).filter(([k, v]) => !near(got[k], v, 5e-5)).map(([k, v]) => `${k}: ${got[k]}≠${v}`);
    check(`${file} の PROMOTED が data/promoted.json と一致`, diff.length === 0, diff.join(", "));
  }
}

/* 節別アプリの日程が公式データと一致するか */
const wk = fs.readFileSync(path.join(ROOT, "節別予想.html"), "utf8");
const J1LIST = JSON.parse(wk.match(/const J1 = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, "]"));
const AB = wk.match(/const AB = "([^"]*)";/)[1];
const RAW = [...wk.matchAll(/^\s*"([0-9A-J]+)"\s*[+;]/gm)].map((m) => m[1]).join("");
check("FIXTURES_RAW が760文字（38節×20文字）", RAW.length === 760, `${RAW.length}文字`);
if (RAW.length === 760) {
  const embeddedFix = [];
  for (let w = 0; w < 38; w++)
    for (let i = 0; i < 10; i++)
      embeddedFix.push({
        round: w + 1,
        h: J1LIST[AB.indexOf(RAW[w * 20 + i * 2])],
        a: J1LIST[AB.indexOf(RAW[w * 20 + i * 2 + 1])],
      });
  const kf = (m) => `${m.round}|${m.h}|${m.a}`;
  const off = new Set(f26.map(kf)), emb = new Set(embeddedFix.map(kf));
  const miss = [...off].filter((k) => !emb.has(k));
  check("節別アプリの日程が公式データと完全一致（節・ホーム・アウェイ）",
    miss.length === 0, `不一致 ${miss.length}件  例: ${miss.slice(0, 3).join(" / ")}`);
}

/* ═══════════════════════════════════════════════════ 6. アプリのコードを実際に動かす */

section("6. アプリのモデルを Node で実行");

/**
 * HTML から「データ＋モデル」部分だけを切り出して評価する。
 * 描画（DOM を触る部分）より前で切るので、ブラウザなしで動く。
 * これで「表示している精度＝実際に動いているコードの精度」を保証できる。
 */
function loadAppModel(file) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  const script = html.match(/<script>\n?"use strict";([\s\S]*?)<\/script>/)[1];
  const cut = script.indexOf("   3) 状態");
  const body = script.slice(0, script.lastIndexOf("/* ===", cut));
  // STATE は描画側で定義されるので、モデルだけ動かすための最小の器を足す
  // 2つのアプリで fitRatings / predict の引数が違うので、呼び分けをここで吸収する
  const src = `"use strict";\n${body}\nvar STATE = { cond: {}, fit: null };\n` +
    `const NEUTRAL = { rest:6, acl:false, aclAway:false, cup:false, nextBig:false };\n` +
    `return {\n` +
    `  CLUBS, MATCHES, P, PROMOTED, outcome,\n` +
    `  SEASON: typeof SEASON !== "undefined" ? SEASON : null,\n` +
    `  J1: typeof J1 !== "undefined" ? J1 : null,\n` +
    `  FIXTURES: typeof FIXTURES !== "undefined" ? FIXTURES : null,\n` +
    `  ROUND_DATES: typeof ROUND_DATES !== "undefined" ? ROUND_DATES : null,\n` +
    `  fit: () => { STATE.fit = fitRatings.length >= 2 ? fitRatings(MATCHES, SEASON) : fitRatings([]);\n` +
    `               return STATE.fit; },\n` +
    `  predict: (h, a) => predict.length >= 4 ? predict(h, a, NEUTRAL, NEUTRAL) : predict(h, a, false),\n` +
    `};`;
  return new Function(src)();
}

/** <script> の中身全体が構文的に正しいか（描画部分も含めて）確かめる */
function syntaxOk(file) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  try {
    // 関数本体として構文解析させる。実行はしない（DOM が無いので実行はできない）
    new Function(script);
    return null;
  } catch (e) { return e.message; }
}

for (const file of ["index.html", "節別予想.html"]) {
  const err = syntaxOk(file);
  check(`${file} のスクリプト全体が構文エラーなし`, err === null, err ?? "");

  let app;
  try { app = loadAppModel(file); }
  catch (e) { check(`${file} のモデルが Node で動く`, false, e.message); continue; }
  check(`${file} のモデルが Node で動く`, true);
  check(`${file} MATCHES が3588件に展開される`, app.MATCHES.length === 3588, `${app.MATCHES.length}`);

  /* 学習して代表的な予想を出す */
  const fit = app.fit();
  const p1 = app.predict("鹿島", "浦和");
  const p2 = app.predict("浦和", "鹿島");
  check(`${file} 勝分敗の合計が1`, near(p1.hw + p1.dr + p1.aw, 1, 1e-9));
  check(`${file} 期待得点が現実的（0.3〜3.5）`,
    p1.lh > 0.3 && p1.lh < 3.5 && p1.la > 0.3 && p1.la < 3.5, `${p1.lh.toFixed(2)}-${p1.la.toFixed(2)}`);
  check(`${file} ホームアドバンテージが効く（鹿島ホーム時の鹿島勝率 > 浦和ホーム時）`,
    p1.hw > p2.aw, `${(p1.hw*100).toFixed(1)}% vs ${(p2.aw*100).toFixed(1)}%`);
  console.log(`     鹿島ホーム: 鹿島勝ち ${(p1.hw*100).toFixed(1)}% / 分 ${(p1.dr*100).toFixed(1)}% / 浦和勝ち ${(p1.aw*100).toFixed(1)}%`);
  console.log(`     浦和ホーム: 鹿島勝ち ${(p2.aw*100).toFixed(1)}%`);

  /* 履歴なしクラブが昇格クラブの平均像から始まっているか */
  const noHist = ["水戸", "千葉"].filter((c) => !fit.R[c]);
  check(`${file} 水戸・千葉は J1 履歴なしとして扱われる`, noHist.length === 2, `${noHist.join(",")}`);

  /* 2026-27 全380試合で確率が壊れないか（節別アプリのみ） */
  if (app.FIXTURES) {
    let bad = 0, minL = 9, maxL = 0;
    for (const week of app.FIXTURES) for (const m of week) {
      const p = app.predict(m.h, m.a);
      if (!near(p.hw + p.dr + p.aw, 1, 1e-9)) bad++;
      minL = Math.min(minL, p.lh, p.la); maxL = Math.max(maxL, p.lh, p.la);
    }
    check(`${file} 380試合すべてで確率の合計が1`, bad === 0, `壊れ ${bad}件`);
    check(`${file} 380試合の期待得点が 0.3〜3.5 に収まる`, minL > 0.3 && maxL < 3.5,
      `${minL.toFixed(2)}〜${maxL.toFixed(2)}`);
    check(`${file} 全38節の開催日が埋まっている`,
      app.ROUND_DATES && app.ROUND_DATES.filter(Boolean).length === 38,
      `${app.ROUND_DATES ? app.ROUND_DATES.filter(Boolean).length : "なし"}/38`);
    console.log(`     380試合の期待得点レンジ ${minL.toFixed(2)}〜${maxL.toFixed(2)}`);
    console.log(`     第1節 ${app.ROUND_DATES?.[0]} 〜 第38節 ${app.ROUND_DATES?.[37]}`);
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
const addonFile = path.join(ROOT, "publish", "sync-addon.html");

if (!fs.existsSync(pubFile) || !fs.existsSync(addonFile)) {
  check("publish/index.html と publish/sync-addon.html がある", false, "publish/build.js を実行していない？");
} else {
  const pub = fs.readFileSync(pubFile, "utf8");
  const addon = fs.readFileSync(addonFile, "utf8").trim();
  const i = pub.indexOf(S_TAG), j = pub.indexOf(E_TAG);
  check("アドオンのブロックが入っている", i >= 0 && j > i);

  /* アドオンを剥がした残りが本体そのものか（＝公開版が本体に追いついているか） */
  const stripped = i >= 0 && j > i
    ? pub.slice(0, i).replace(/\s*$/, "\n") + pub.slice(j + E_TAG.length).replace(/^\s*/, "\n")
    : pub;
  const norm = (s) => s.replace(/\s*$/, "\n");
  check("アドオンを除いた中身が 節別予想.html と完全一致", norm(stripped) === norm(wk),
    "publish/ で node build.js ../節別予想.html を実行すること");
  check("埋め込まれたアドオンが publish/sync-addon.html と一致",
    i >= 0 && j > i && pub.slice(i, j + E_TAG.length).trim() === addon);

  /* アドオンが本体から借りている名前。本体の作りが変わると噛み合わなくなる */
  const missing = ["const FIXTURES =", "const STATE", "function save(", "function refit(", "function renderAll("]
    .filter((n) => !stripped.includes(n));
  check("アドオンが借りている名前が本体にそろっている", missing.length === 0, missing.join(" / "));

  /* 公開物として出して良い中身か（publish/build.js と同じ観点を毎回確かめる） */
  const leaks = [/岡本/, /kakeru/i, /ge-creative/i, /GE00525/, /OneDrive/i, /C:\\/].filter((re) => re.test(pub));
  check("個人情報らしき文字列が入っていない", leaks.length === 0, leaks.join(", "));
  const ext = [...pub.matchAll(/<(?:script|link|img|iframe|source)[^>]*\b(?:src|href)="(?!data:|#)([^"]+)"/gi)];
  check("外部から読み込むリソースが0件（1ファイルで完結する）", ext.length === 0, ext.map((m) => m[1]).join(", "));

  /* アドオン込みで構文が通るか。<script> が複数あるので全部見る */
  const broken = [];
  for (const m of pub.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try { new Function(m[1]); } catch (e) { broken.push(e.message); }
  }
  check("全スクリプトが構文エラーなし（アドオン込み）", broken.length === 0, broken.join(" / "));

  /* 本体一致で担保されるが、落ちたとき原因が分かるように直接も測る */
  const pp = {};
  for (const mm of pub.match(/const P = \{([\s\S]*?)\};/)[1].matchAll(/(\w+):\s*([\d.eE+-]+)/g)) pp[mm[1]] = Number(mm[2]);
  const pdiff = Object.entries(params.model)
    .filter(([k, v]) => pp[k] !== undefined && !near(pp[k], v, 1e-9))
    .map(([k, v]) => `${k}: 公開版 ${pp[k]} / params ${v}`);
  check("パラメータが data/params.json と一致", pdiff.length === 0, pdiff.join(", "));

  console.log(`     ${(pub.length / 1024).toFixed(0)}KB ＝ 本体 ${(stripped.length / 1024).toFixed(0)}KB ＋ アドオン ${(addon.length / 1024).toFixed(0)}KB`);
}

/* ═══════════════════════════════════════════════════ 結果 */

console.log(`\n${"═".repeat(64)}`);
console.log(ng === 0 ? `全 ${ok} 項目 合格` : `${ok} 件 合格 / ${ng} 件 不合格`);
process.exit(ng === 0 ? 0 : 1);
