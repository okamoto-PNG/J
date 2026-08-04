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

const j2hist = load("j2-matches.json").filter((m) => m.s <= 2025 && m.hg != null);
const f26j2 = load("j2-2026.json");
const paramsJ2 = load("params-j2.json");
const promotedAvg = load("promoted.json").promotedAverage;

/** HTML に埋め込まれたオブジェクトリテラルを取り出す */
function appConst(html, name) {
  const m = html.match(new RegExp("const " + name + " = (\\{[\\s\\S]*?\\n\\});"));
  if (!m) return null;
  return new Function("return " + m[1])();
}

/** 圧縮データを試合の配列に戻す */
const expand = (clubs, data) => data.split(";").map((row) => {
  const [s, h, a, hg, ag] = row.split(".").map(Number);
  return { s: 2015 + s, h: clubs[h], a: clubs[a], hg, ag };
});
const mkey = (m) => m.s + "|" + m.h + "|" + m.a + "|" + m.hg + "|" + m.ag;

/* --- index.html（J1 単発型。従来の作りのまま） --- */
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const CLUBS = JSON.parse(html.match(/const CLUBS = (\[[\s\S]*?\]);/)[1]);
  const dm = html.match(/const DATA =([\s\S]*?);\n/);
  const DATA = [...dm[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
  const embedded = expand(CLUBS, DATA);
  const A = new Set(j1.map(mkey)), B = new Set(embedded.map(mkey));
  check("index.html の埋め込み試合数が3588", embedded.length === 3588, String(embedded.length));
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
const wk = fs.readFileSync(path.join(ROOT, "節別予想.html"), "utf8");
const HIST = appConst(wk, "HIST");
const LEAGUES = appConst(wk, "LEAGUES");
const AB = wk.match(/const AB = "([^"]*)";/)[1];

check("節別予想.html に HIST と LEAGUES がある", !!HIST && !!LEAGUES);
check("2リーグ（J1・J2）ぶんある",
  !!(HIST && HIST.J1 && HIST.J2 && LEAGUES && LEAGUES.J1 && LEAGUES.J2));

const LG_SPEC = [
  { key: "J1", hist: j1,     fixtures: f26,   params: params.model,   prior: promotedAvg,          n: 3588 },
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

  /* 日程 */
  check(L.key + " の fixturesRaw が760文字（38節×20文字）", G.fixturesRaw.length === 760, G.fixturesRaw.length + "文字");
  check(L.key + " の所属クラブが20", G.teams.length === 20, String(G.teams.length));
  if (G.fixturesRaw.length === 760 && G.teams.length === 20) {
    const emb2 = [];
    for (let w = 0; w < 38; w++) for (let i2 = 0; i2 < 10; i2++)
      emb2.push({ round: w + 1,
        h: G.teams[AB.indexOf(G.fixturesRaw[w * 20 + i2 * 2])],
        a: G.teams[AB.indexOf(G.fixturesRaw[w * 20 + i2 * 2 + 1])] });
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
  check(L.key + " の全38節に開催日がある",
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
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
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
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
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

    if (L.key === "J1") {
      const noHist = ["水戸", "千葉"].filter((c) => !fit.R[c]);
      check(tag + " 水戸・千葉は J1 履歴なしとして扱われる", noHist.length === 2, noHist.join(","));
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
  const i2 = pub.indexOf(S_TAG), j2 = pub.indexOf(E_TAG);
  check("アドオンのブロックが入っている", i2 >= 0 && j2 > i2);

  const stripped = i2 >= 0 && j2 > i2
    ? pub.slice(0, i2).replace(/\s*$/, "\n") + pub.slice(j2 + E_TAG.length).replace(/^\s*/, "\n")
    : pub;
  const norm = (s2) => s2.replace(/\s*$/, "\n");
  check("アドオンを除いた中身が 節別予想.html と完全一致", norm(stripped) === norm(wk),
    "publish/ で node build.js ../節別予想.html を実行すること");
  check("埋め込まれたアドオンが publish/sync-addon.html と一致",
    i2 >= 0 && j2 > i2 && pub.slice(i2, j2 + E_TAG.length).trim() === addon);

  const missing = ["const LEAGUES", "const STATE", "function save(", "function refit(", "function renderAll("]
    .filter((n) => !stripped.includes(n));
  check("アドオンが借りている名前が本体にそろっている", missing.length === 0, missing.join(" / "));

  const leaks = [/岡本/, /kakeru/i, /ge-creative/i, /GE00525/, /OneDrive/i, /C:\\/].filter((re) => re.test(pub));
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

/* ═══════════════════════════════════════════════════ 結果 */

console.log(`\n${"═".repeat(64)}`);
console.log(ng === 0 ? `全 ${ok} 項目 合格` : `${ok} 件 合格 / ${ng} 件 不合格`);
process.exit(ng === 0 ? 0 : 1);
