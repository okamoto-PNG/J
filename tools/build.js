/**
 * data/ の内容から、アプリHTMLに埋め込む定数を作り直す。
 *
 *   node tools/build.js          … 書き換える
 *   node tools/build.js --dry    … 差分だけ表示して書き換えない
 *
 * HTMLを直接手で書き換えないこと。必ずここを通す。
 * データを取り直したら fetch → parse → tune → build → verify の順に回す。
 *
 * file:// で開いたHTMLは別ファイルの fetch が CORS でブロックされるので、
 * データは JSON を読むのではなくHTMLに埋め込む必要がある。
 * 1試合を "季.ホーム.アウェイ.得点.失点" に圧縮して ";" でつなぐ。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { load } = require("./lib/data");

const ROOT = path.join(__dirname, "..");
const DRY = process.argv.includes("--dry");

const j1 = load("j1-matches.json");
const f26 = load("j1-2026.json");
const params = load("params.json");
const promoted = load("promoted.json");

/* ------------------------------------------------------------ 圧縮データを作る */

/**
 * 既存HTMLに書かれている並びを取り出す。
 * 集合が同じなら並びを引き継ぐ（差分を小さくして目で確認しやすくするため）。
 * 並び自体には意味がなく、DATA / FIXTURES_RAW の添字と対応していればよい。
 */
function keepOrder(file, re, fresh) {
  try {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    const old = JSON.parse(src.match(re)[1].replace(/,(\s*\])/, "$1"));
    const same = old.length === fresh.length && fresh.every((c) => old.includes(c));
    if (same) return old;
    console.log(`  ℹ ${file}: クラブ構成が変わったので並びを作り直す`);
  } catch { /* 初回など。そのまま新しい並びを使う */ }
  return fresh;
}

/** DATA の添字になるクラブ一覧 */
const CLUBS = keepOrder("index.html", /const CLUBS = (\[[\s\S]*?\]);/,
  [...new Set(j1.flatMap((m) => [m.h, m.a]))].sort());
const IDX = new Map(CLUBS.map((c, i) => [c, i]));
const BASE_SEASON = Math.min(...j1.map((m) => m.s));

const sorted = [...j1].sort((a, b) =>
  a.s - b.s || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
  a.h.localeCompare(b.h, "ja"));
const DATA = sorted
  .map((m) => `${m.s - BASE_SEASON}.${IDX.get(m.h)}.${IDX.get(m.a)}.${m.hg}.${m.ag}`)
  .join(";");

/** 2026-27 の日程。1試合＝ホーム・アウェイの2文字、20文字で1節 */
const AB = "0123456789ABCDEFGHIJ";
const J1_2627 = keepOrder("節別予想.html", /const J1 = (\[[\s\S]*?\]);/,
  [...new Set(f26.flatMap((m) => [m.h, m.a]))].sort());
const J26 = new Map(J1_2627.map((c, i) => [c, i]));
let FIXTURES_RAW = "";
for (let w = 1; w <= 38; w++) {
  const week = f26.filter((m) => m.round === w)
    .sort((a, b) => (a.date ?? "9") < (b.date ?? "9") ? -1 : 1);
  for (const m of week) FIXTURES_RAW += AB[J26.get(m.h)] + AB[J26.get(m.a)];
}

/** 節ごとの日付（先頭の試合日）。表示と「未消化の節」判定に使えるようにしておく */
const ROUND_DATES = Array.from({ length: 38 }, (_, i) => {
  const ds = f26.filter((m) => m.round === i + 1 && m.date).map((m) => m.date).sort();
  return ds[0] ?? null;
});

/* ------------------------------------------------------------ 置換の道具 */

/** 80桁ずつに折って JS の文字列連結にする（1行が長くなりすぎないように） */
function wrap(str, per, indent) {
  const parts = [];
  for (let i = 0; i < str.length; i += per) parts.push(`"${str.slice(i, i + per)}"`);
  return parts.join(` +\n${indent}`);
}

const edits = [];
function replace(label, re, next) {
  edits.push({ label, re, next });
}

/* ------------------------------------------------------------ 共通の置換 */

const accuracy = params.accuracy;
const pct = (x) => (x * 100).toFixed(1);
const SOURCE_TEXT = "Ｊリーグ公式データサイト（data.j-league.or.jp）の日程・結果";

replace("CLUBS", /const CLUBS = \[[\s\S]*?\];/,
  `const CLUBS = [${CLUBS.map((c) => `"${c}"`).join(",")}];`);

replace("DATA", /const DATA =[\s\S]*?;\n/,
  `const DATA =\n  ${wrap(DATA, 100, "  ")};\n`);

replace("PROMOTED", /const PROMOTED = \{[^}]*\};/, () => {
  const p = promoted.promotedAverage;
  const f = (x) => x.toFixed(4);
  return `const PROMOTED = { atkH:${f(p.atkH)}, defH:${f(p.defH)}, atkA:${f(p.atkA)}, defA:${f(p.defA)} };`;
});

/** const P = { ... } の中の数値だけを params.json の値に差し替える */
replace("P（パラメータ）", /const P = \{[\s\S]*?\n\};/, (block) =>
  block.replace(/^(\s*)(\w+):\s*([\d.eE+-]+)(,?)(.*)$/gm, (line, sp, key, _old, comma, rest) => {
    if (!(key in params.model)) return line;
    let v = params.model[key];
    const shown = v >= 1e9 ? "1e9" : String(v);
    return `${sp}${key}: ${shown}${comma}${rest}`;
  }));

/* ------------------------------------------------------------ index.html 固有 */

/** 両ファイル共通：データ節の見出しコメント（既にある生成メモの行もまとめて置き換える） */
replace("データ節の見出し",
  /   0\) データ.*\n(?:      tools\/fetch\.js .*\n)*/,
  `   0) データ（Ｊリーグ公式データサイトから取得した 2015-2025 の J1 全${j1.length}試合）\n` +
  `      tools/fetch.js → tools/parse.js → tools/build.js で生成。手で書き換えないこと\n`);

const idx = [
  ...edits,
  {
    label: "見出しのデータ出典",
    re: /<p class="sub">過去[\s\S]*?<\/p>/,
    next: `<p class="sub">過去11シーズン（2015-2025）のJ1全${j1.length}試合から算出。` +
      `データ出典：${SOURCE_TEXT}（試合日つき）</p>`,
  },
  {
    label: "精度バッジ",
    re: /<span class="badge">検証 <b>[\s\S]*?（基準率 [\d.]+）<\/span>/,
    next: `<span class="badge">検証 <b>${accuracy.matches}試合</b>で的中率 ` +
      `<b>${pct(accuracy.hitRate)}%</b></span>\n` +
      `    <span class="badge">log loss <b>${accuracy.logLoss.toFixed(4)}</b>` +
      `（基準率 ${accuracy.baselineLogLoss.toFixed(4)}）</span>`,
  },
  {
    label: "パラメータの説明コメント",
    re: /   1\) モデルのパラメータ\n[\s\S]*?グリッドサーチして log loss を最小化した値（解説\.md「6\. 精度検証」）/,
    next: `   1) モデルのパラメータ\n` +
      `      tools/tune.js が 2018-2025 の ${accuracy.matches}試合を日付順にバックテストして決めた値。\n` +
      `      学習区間(2018-22)と検証区間(2023-25)の両方で log loss が下がったものだけを採用している。\n` +
      `      手で書き換えないこと（data/params.json が正）`,
  },
  {
    label: "日程補正の注記（画面）",
    re: /      日程の負荷は<b>実データから推定できない項目<\/b>です[\s\S]*?を参照してください。/,
    next: `      試合日を入れて実測した結果、<b>日程による有利不利は検出できませんでした</b>` +
      `（2018-2025の${accuracy.matches}試合）。\n` +
      `      補正を効かせるほど log loss は悪化します。そのため<b>既定では何も効きません</b>。\n` +
      `      ここは「もし中2日なら」と手で仮定を置くための欄で、<b>実測の裏付けはありません</b>。詳細は\n` +
      `      <a href="解説.md">解説.md</a> の「7. 日程補正の扱い」を参照してください。`,
  },
  {
    label: "日程補正のコメント（コード）",
    re: /\/\* 日程補正（★実測ではなく調整パラメータ）\*\//,
    next: `/* 日程補正。\n` +
      `   ★実測したところ効果は検出できず、効かせるほど精度が落ちた（data/params.json の fatigue）。\n` +
      `   既定値（中6日・カップなし）ではすべて 1.00 になり、予想に影響しない。\n` +
      `   手動で「もし中2日なら」と仮定を置くためだけに残してある。 */`,
  },
  {
    label: "フッタの出典",
    re: /    データ出典：<a href="https:\/\/ja\.wikipedia\.org[\s\S]*?（CC BY-SA）。<br>/,
    next: `    データ出典：<a href="https://data.j-league.or.jp/SFMS01/" target="_blank" rel="noopener">` +
      `Ｊリーグ公式データサイト</a> の日程・結果（2015-2025 J1 全${j1.length}試合／試合日・会場つき）。<br>`,
  },
];

/* ------------------------------------------------------------ 節別予想.html 固有 */

const wk = [
  ...edits,
  {
    label: "J1（2026-27の20クラブ）",
    // 直前の説明コメント（あれば）ごと置き換える。文面が変わっていても拾えるように緩くする
    re: /(?:\/\*[^*]*FIXTURES_RAW[^*]*\*\/\n)?const J1 = \[[\s\S]*?\];/,
    next: `/* 並び順は FIXTURES_RAW の添字と対応しているので変えないこと（tools/build.js が生成）*/\n` +
      `const J1 = [\n` +
      J1_2627.reduce((acc, c, i) => {
        const line = i % 5 === 0 ? (i ? acc + "\n  " : "  ") : acc + " ";
        return line + `"${c}",`;
      }, "") + `\n];`,
  },
  {
    label: "FIXTURES_RAW",
    // 末尾の ROUND_DATES まで含めて置き換える（何度実行しても増えないように）
    re: /\/\* 2026-27 J1 全38節の対戦カード。[\s\S]*?const FIXTURES_RAW =\n[\s\S]*?;\n(?:\/\* 各節の開催日[\s\S]*?\n)?(?:const ROUND_DATES = .*\n)*/,
    next: `/* 2026-27 J1 全38節の対戦カード。1試合＝ホーム・アウェイの2文字（J1 配列の添字）。\n` +
      `   出典はＪリーグ公式データサイト（data/j1-2026.json）。tools/verify.js が\n` +
      `   「各節に20クラブが1回ずつ」「順序付き380通りが重複なく全部そろう」まで検算している。 */\n` +
      `const AB = "${AB}";\n` +
      `const FIXTURES_RAW =\n  ${wrap(FIXTURES_RAW, 80, "  ")};\n` +
      `/* 各節の開催日（先頭の試合の日付）。公式発表。未定の節は null */\n` +
      `const ROUND_DATES = ${JSON.stringify(ROUND_DATES).replace(/","/g, '", "')};\n`,
  },
  {
    label: "フッタの出典",
    re: /    (?:日程|戦績)データ出典：[\s\S]*?（CC BY-SA）。<br>/,
    next: `    データ出典：<a href="https://data.j-league.or.jp/SFMS01/" target="_blank" rel="noopener">` +
      `Ｊリーグ公式データサイト</a><br>\n` +
      `    2026-27 対戦カード380試合（試合日つき）／2015-2025 J1 全${j1.length}試合。<br>`,
  },
];

/* ------------------------------------------------------------ 適用 */

function apply(file, list) {
  const p = path.join(ROOT, file);
  let src = fs.readFileSync(p, "utf8");
  const before = src;
  console.log(`\n${file}`);
  for (const { label, re, next } of list) {
    const m = src.match(re);
    if (!m) {
      // 一度きりの文面差し替えは、2回目以降は「もう当たっている」のが正常
      const done = typeof next === "string" && src.includes(next.trim().split("\n")[0].trim());
      console.log(done
        ? `  ・ ${label}: すでに反映済み`
        : `  ⚠ ${label}: 該当箇所が見つからない（HTMLの文面が変わった？要確認）`);
      continue;
    }
    const replacement = typeof next === "function" ? next(m[0]) : next;
    if (replacement === m[0]) { console.log(`  ・ ${label}: 変更なし`); continue; }
    src = src.slice(0, m.index) + replacement + src.slice(m.index + m[0].length);
    console.log(`  ✏ ${label}: ${m[0].length} → ${replacement.length} 文字`);
  }
  if (src === before) { console.log("  （このファイルは変更なし）"); return; }
  if (DRY) { console.log("  --dry のため書き込まない"); return; }
  fs.writeFileSync(p, src);
  console.log(`  → 書き込み完了（${(src.length / 1024).toFixed(0)}KB）`);
}

console.log("=== data/ からアプリの定数を再生成 ===");
console.log(`学習データ ${j1.length}試合 / クラブ ${CLUBS.length} / DATA ${(DATA.length / 1024).toFixed(1)}KB`);
console.log(`2026-27 日程 ${FIXTURES_RAW.length / 2}試合 / 日付判明 ${ROUND_DATES.filter(Boolean).length}/38節`);
apply("index.html", idx);
apply("節別予想.html", wk);
console.log("\n次は node tools/verify.js を実行して検算すること。");

/* ------------------------------------------------------------ 残った文面の追い込み
   build.js を通すたびに、出典やコメントの表記も data/ に合わせておく。
   一度きりの差し替えなので、2回目以降は「すでに反映済み」と出るだけ。          */

const AVG = promoted.promotedAverage;
const extra = [
  {
    file: "index.html",
    label: "所属クラブのコメント",
    re: /\/\* --- 2026-27シーズンのJ1所属20クラブ（Wikipedia[^\n]*--- \*\//,
    next: `/* --- 2026-27シーズンのJ1所属20クラブ（data/j1-2026.json より生成）--- */`,
  },
  {
    file: "index.html",
    label: "PROMOTED の説明",
    re: / \* 2016-2025の昇格\d+クラブ（[^）]*）から実測した。\n \* ホームとアウェイでリーグ平均得点が違う（[\d.]+ 対 [\d.]+）ので、/,
    next: ` * 2016-2025の昇格${promoted.sampleClubs}クラブ（${promoted.sampleAppearances}試合ぶんの出場）から実測した。\n` +
      ` * ホームとアウェイでリーグ平均得点が違う（` +
      `${promoted.leagueAverage.home.toFixed(3)} 対 ${promoted.leagueAverage.away.toFixed(3)}）ので、`,
  },
  {
    file: "節別予想.html",
    label: "画面内のデータ出典",
    re: /<li><b>2015-2025年のJ1 全3588試合<\/b>（Wikipedia[^<]*）<\/li>/,
    next: `<li><b>2015-2025年のJ1 全${j1.length}試合</b>（Ｊリーグ公式データサイト・試合日つき）</li>`,
  },
];

for (const file of ["index.html", "節別予想.html"]) {
  const list = extra.filter((e) => e.file === file);
  if (list.length) apply(file, list);
}
