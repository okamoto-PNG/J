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
/* シーズンの境界・区間・予想対象ファイル名はすべてここから。直書きしない */
const S = require("./lib/season").require();

const ROOT = path.join(__dirname, "..");
const DRY = process.argv.includes("--dry");

const j1 = load("j1-matches.json");
const f26 = load(S.files.J1);
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

/* ★節数・1節の試合数・クラブ数は data/season.json から取る（直書きしない）。
   J1・J2 は 20クラブ・38節だが、そう決め打つと構成が変わった年に静かに壊れる。 */
const WEEKS = S.leagues.J1.weeks;
const PER_WEEK = S.leagues.J1.perWeek;
const N_CLUBS = S.leagues.J1.clubs;

/** 予想対象シーズンの日程。1試合＝ホーム・アウェイの2文字、クラブ数ぶんの文字で1節 */
const AB = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, N_CLUBS);
const J1_2627 = keepOrder("節別予想.html", /const J1 = (\[[\s\S]*?\]);/,
  [...new Set(f26.flatMap((m) => [m.h, m.a]))].sort());
const J26 = new Map(J1_2627.map((c, i) => [c, i]));
let FIXTURES_RAW = "";
for (let w = 1; w <= WEEKS; w++) {
  const week = f26.filter((m) => m.round === w)
    .sort((a, b) => (a.date ?? "9") < (b.date ?? "9") ? -1 : 1);
  for (const m of week) FIXTURES_RAW += AB[J26.get(m.h)] + AB[J26.get(m.a)];
}

/** 節ごとの日付（先頭の試合日）。表示と「未消化の節」判定に使えるようにしておく */
const ROUND_DATES = Array.from({ length: WEEKS }, (_, i) => {
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

/* ★シーズンと構造の定数もここで生成する。
   以前はHTML側に 2026 / 38 / 10 / Date.UTC(2026,0,1) が直書きされていて、
   シーズンが変わるとHTMLを手で直す必要があった。verify.js が食い違いを検出する。 */
/* ★シーズンの定数は index.html と 節別予想.html の両方に入っている。
   共通の edits は index.html 用（wk では HIST/LEAGUES に置き換わる）なので、
   ここだけは別の配列にして両方に混ぜる。片方だけに入れて公開版が古いまま残ったことがある。 */
const seasonConsts = [];
const both = (label, re, next) => seasonConsts.push({ label, re, next });

both("SEASON", /const SEASON = \d+;/, `const SEASON = ${S.upcoming};`);
both("WEEKS・PER_WEEK", /const WEEKS = \d+, PER_WEEK = \d+;.*/,
  `const WEEKS = ${WEEKS}, PER_WEEK = ${PER_WEEK};   ` +
  `// data/season.json より（${N_CLUBS}クラブ・${WEEKS}節・1節${PER_WEEK}試合）`);
/* 締切を数える基準日。実データの最も早い試合日（data/season.json が導出） */
both("KO_EPOCH（締切の基準日）", /const KO_EPOCH = Date\.UTC\([^)]*\);.*/, () => {
  const [y, m, d] = S.koEpochDate.split("-").map(Number);
  return `const KO_EPOCH = Date.UTC(${y}, ${m - 1}, ${d});   // ${S.koEpochDate}（最も早い試合日）`;
});

/* index.html の所属クラブ。以前は手で並べていて、毎季ここを直す必要があった。
   5クラブずつ折り返して読みやすくしておく。 */
replace("TEAMS（予想対象シーズンの所属クラブ）", /const TEAMS = \[[\s\S]*?\n\];/, () => {
  const rows = [];
  for (let i = 0; i < J1_2627.length; i += 5) {
    rows.push("  " + J1_2627.slice(i, i + 5).map((c) => `"${c}"`).join(", ") + ",");
  }
  return `const TEAMS = [\n${rows.join("\n")}\n];`;
});

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
  `   0) データ（Ｊリーグ公式データサイトから取得した ${S.first}-${S.histEnd} の J1 全${j1.length}試合）\n` +
  `      tools/fetch.js → tools/parse.js → tools/build.js で生成。手で書き換えないこと\n`);

const idx = [
  ...edits,
  ...seasonConsts,
  {
    label: "見出しのデータ出典",
    re: /<p class="sub">過去[\s\S]*?<\/p>/,
    next: `<p class="sub">過去${S.histEnd - S.first + 1}シーズン（${S.first}-${S.histEnd}）のJ1全${j1.length}試合から算出。` +
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
      `      tools/tune.js が ${S.firstEval}-${S.histEnd} の ${accuracy.matches}試合を日付順にバックテストして決めた値。\n` +
      `      学習区間(${S.train.join("-")})と検証区間(${S.test.join("-")})の両方で log loss が下がったものだけを採用している。\n` +
      `      手で書き換えないこと（data/params.json が正）`,
  },
  {
    label: "日程補正の注記（画面）",
    re: /      日程の負荷は<b>実データから推定できない項目<\/b>です[\s\S]*?を参照してください。/,
    next: `      試合日を入れて実測した結果、<b>日程による有利不利は検出できませんでした</b>` +
      `（${S.firstEval}-${S.histEnd}の${accuracy.matches}試合）。\n` +
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
      `Ｊリーグ公式データサイト</a> の日程・結果（${S.first}-${S.histEnd} J1 全${j1.length}試合／試合日・会場つき）。<br>`,
  },
];

/* ------------------------------------------------------------ 節別予想.html 固有
   こちらは J1 と J2 の2リーグぶんを埋め込む。
   1リーグ = 学習データ（HIST）＋ 今季の日程とパラメータ（LEAGUES）。          */

const j2hist = load("j2-matches.json").filter((m) => m.s <= S.histEnd && m.hg != null);
const f26j2 = load(S.files.J2);
const paramsJ2 = load("params-j2.json");
/* J2 の新顔をクラブ別に評価した結果（tools/calibrate-j3.js）。
   採用されていなければ空にして、従来どおり混ぜた平均1組だけを埋め込む。 */
let byClubJ2 = {};
try {
  const cj3 = load("calib-j3.json");
  if (cj3.adopted && cj3.adopted !== "single") byClubJ2 = cj3.byClub ?? {};
} catch { /* 未実測。混ぜた平均のまま */ }

/** 1リーグぶんの学習データを圧縮する */
function histOf(rows, file, re) {
  const clubs = keepOrder(file, re, [...new Set(rows.flatMap((m) => [m.h, m.a]))].sort());
  const idx = new Map(clubs.map((c, i) => [c, i]));
  const base = Math.min(...rows.map((m) => m.s));
  const data = [...rows]
    .sort((a, b) => a.s - b.s || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
                    a.h.localeCompare(b.h, "ja"))
    .map((m) => `${m.s - base}.${idx.get(m.h)}.${idx.get(m.a)}.${m.hg}.${m.ag}`)
    .join(";");
  return { clubs, data, base };
}

/* 予想の締切に使う「試合ごとのキックオフ」。
   1節が2〜3日に分散するので、節単位で締めると日曜の試合を予想できなくなる。
   1試合4文字：日付（2026-01-01からの日数・36進数2桁）＋ K/O（5分単位・36進数2桁）。
   5分単位なので端数は**切り捨てる**。四捨五入だと 19:28 が 19:30 になり、
   締切がキックオフより後になってしまう（試合開始後に入れた予想が「締切前」になる）。
   日付が未発表なら "...."、時刻だけ未発表なら日付＋".."（アプリ側で当日0時として扱う）。
   ※K/O時刻はJリーグが数週間前に発表するので、取得時点では半分以上が未定。 */
const KO_EPOCH = S.koEpochUTC;   // 予想対象シーズンの1月1日（data/season.json）
const b36pad = (n) => n.toString(36).padStart(2, "0");
function koCode(m) {
  if (!m.date) return "....";
  const days = Math.round((Date.parse(m.date + "T00:00:00Z") - KO_EPOCH) / 86400000);
  if (days < 0 || days > 1295) throw new Error(`日付が想定の範囲外: ${m.date}`);
  const t = m.ko ? m.ko.match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!t) return b36pad(days) + "..";
  const min = Number(t[1]) * 60 + Number(t[2]);
  return b36pad(days) + b36pad(Math.floor(min / 5));
}

/**
 * すでに公開してあるHTMLから「節ごとの試合の並び」を取り出す。
 *
 * ★利用者の入力（結果・予想）は、その端末の localStorage に
 *   「節.その節の中の位置」で入っている。位置は日付順で決めているので、
 *   1試合でも延期されると節ぜんたいの位置がずれ、
 *   **入れてあった結果や予想が別の試合に付け替わる**。
 *   対戦カードの顔ぶれが同じ節は、並びを動かさないこと。
 *   （クラブの並びを keepOrder で守っているのと同じ理由）
 */
function prevWeekOrder(key) {
  const out = new Map();
  try {
    /* ★CRLF のままだと、下の正規表現（\n で区切っている）が当たらない。
       当たらなくても例外にはならず、「引き継ぐものが無い」と見なして
       並びを作り直してしまう＝守っているつもりで守れていない状態になる。
       core.autocrlf=true なので git pull のたびにこうなる。必ず LF に揃えること。 */
    const src = fs.readFileSync(path.join(ROOT, "節別予想.html"), "utf8").replace(/\r\n/g, "\n");
    /* leagueBlock が書く形にそのまま合わせる。緩くすると、
       HIST の "J2: { clubs: ..." に当たったあと J1 の teams を拾ってしまう。 */
    const blk = src.match(new RegExp(
      `\\n  ${key}: \\{\\n    label: "${key}",\\n    teams: (\\[[^\\]]*\\]),\\n` +
      `    fixturesRaw:((?:\\s*"[0-9A-Z]*"\\s*\\+?)+)`));
    if (!blk) return out;
    const teams = JSON.parse(blk[1]);
    const raw = (blk[2].match(/"[0-9A-Z]*"/g) ?? []).map((s) => s.slice(1, -1)).join("");
    const per = teams.length / 2;
    for (let w = 0; (w + 1) * per * 2 <= raw.length; w++) {
      const list = [];
      for (let i = 0; i < per; i++) {
        const at = (w * per + i) * 2;
        list.push(teams[AB.indexOf(raw[at])] + "|" + teams[AB.indexOf(raw[at + 1])]);
      }
      out.set(w + 1, list);
    }
  } catch { /* 初回など。引き継ぐものが無いだけ */ }
  return out;
}

/** 1リーグぶんの今季日程を圧縮する */
function fixturesOf(rows, teams, key) {
  const idx = new Map(teams.map((c, i) => [c, i]));
  const prev = key ? prevWeekOrder(key) : new Map();
  let raw = "", kicks = "", scores = "", kept = 0, redone = 0;
  for (let w = 1; w <= WEEKS; w++) {
    let week = rows.filter((m) => m.round === w)
      .sort((a, b) => ((a.date ?? "9") < (b.date ?? "9") ? -1 : 1));
    /* 顔ぶれが同じなら、前回の並びをそのまま使う（入力の付け替えを防ぐ） */
    const old = prev.get(w);
    if (old && old.length === week.length) {
      const byKey = new Map(week.map((m) => [m.h + "|" + m.a, m]));
      if (old.every((k) => byKey.has(k))) { week = old.map((k) => byKey.get(k)); kept++; }
      else { redone++; console.log(`  ℹ ${key} 第${w}節: 対戦カードが変わったので並びを作り直す`); }
    }
    for (const m of week) {
      raw += AB[idx.get(m.h)] + AB[idx.get(m.a)];
      kicks += koCode(m);
      /* 公式データの結果。1試合2文字（36進数で得点2つ）、未消化は ".."。
         これを焼き込んでおけば、アプリはどこにも通信せずに結果を出せる。 */
      /* 1試合2文字。b36pad は常に2桁に詰めるので、ここでは使わない（使うと4文字になる） */
      const one = (g) => Math.max(0, Math.min(35, g)).toString(36);
      scores += (m.hg == null || m.ag == null) ? ".." : one(m.hg) + one(m.ag);
    }
  }
  if (key) {
    const fresh = WEEKS - kept - redone;
    console.log(`  ・ ${key} 節の並び: ${kept}節を引き継ぎ / ${redone}節を作り直し / ${fresh}節は新規`);
    /* ★「全部が新規」は、初回を除けば引き継ぎに失敗した合図。
       黙って通すと、日程が変わったときに利用者の入力が別の試合に付け替わる。 */
    if (fresh === WEEKS && prev.size === 0) {
      console.log(`    ⚠ ${key}: 前回の並びを取り出せなかった。`
        + `初回なら正常。そうでなければ 節別予想.html の形か改行コードを確かめること`);
    }
  }
  const dates = Array.from({ length: WEEKS }, (_, i) => {
    const ds = rows.filter((m) => m.round === i + 1 && m.date).map((m) => m.date).sort();
    return ds[0] ?? null;
  });
  return { raw, dates, kicks, scores };
}

const HIST_J1 = histOf(j1, "節別予想.html", /J1: \{ clubs: (\[[\s\S]*?\]), data:/);
const HIST_J2 = histOf(j2hist, "節別予想.html", /J2: \{ clubs: (\[[\s\S]*?\]), data:/);
const J2_2627 = keepOrder("節別予想.html", /J2: \{ label: "J2", teams: (\[[\s\S]*?\]),/,
  [...new Set(f26j2.flatMap((m) => [m.h, m.a]))].sort());
const FX_J1 = fixturesOf(f26, J1_2627, "J1");
const FX_J2 = fixturesOf(f26j2, J2_2627, "J2");

const arr = (a) => `[${a.map((c) => `"${c}"`).join(",")}]`;
const num = (o) => `{ atkH:${o.atkH.toFixed(4)}, defH:${o.defH.toFixed(4)}, ` +
                   `atkA:${o.atkA.toFixed(4)}, defA:${o.defA.toFixed(4)} }`;
const pobj = (m) => "{ " + Object.entries(m)
  .map(([k, v]) => `${k}: ${v >= 1e9 ? "1e9" : v}`).join(", ") + " }";

/**
 * 履歴なしクラブの個別事前分布。
 * 埋め込むのは「今季このリーグにいて、かつ学習データに履歴が無い」クラブだけ。
 * 履歴があるクラブは実績から推定するので事前分布を引かない（入れても使われない）。
 */
const byClubBlock = (byClub, teams, hasHistory) => {
  const rows = teams
    .filter((c) => byClub[c] && !hasHistory.has(c))
    .map((c) => `      "${c}": ${num(byClub[c])},`);
  return rows.length ? `    promotedByClub: {\n${rows.join("\n")}\n    },\n` : "";
};

const leagueBlock = (key, label, teams, fx, P, prom, byClub = {}, hasHistory = new Set()) =>
  `  ${key}: {\n` +
  `    label: "${label}",\n` +
  `    teams: ${arr(teams)},\n` +
  `    fixturesRaw:\n      ${wrap(fx.raw, 80, "      ")},\n` +
  `    roundDates: ${JSON.stringify(fx.dates).replace(/","/g, '", "')},\n` +
  `    kickoffs:\n      ${wrap(fx.kicks, 80, "      ")},\n` +
  `    results:\n      ${wrap(fx.scores, 80, "      ")},\n` +   // 公式データの結果
  `    P: ${pobj(P)},\n` +
  `    promoted: ${num(prom)},\n` +
  byClubBlock(byClub, teams, hasHistory) +
  `  },\n`;

const HAS_HIST_J2 = new Set(j2hist.flatMap((m) => [m.h, m.a]));

const wk = [
  ...seasonConsts,
  {
    label: "HIST（両リーグの学習データ）",
    re: /const HIST = \{[\s\S]*?\n\};\n/,
    next: `const HIST = {\n` +
      `  J1: { clubs: ${arr(HIST_J1.clubs)},\n        data:\n  ${wrap(HIST_J1.data, 100, "  ")} },\n` +
      `  J2: { clubs: ${arr(HIST_J2.clubs)},\n        data:\n  ${wrap(HIST_J2.data, 100, "  ")} },\n` +
      `};\n`,
  },
  {
    label: "LEAGUES（両リーグの日程とパラメータ）",
    re: /const LEAGUES = \{[\s\S]*?\n\};\n/,
    next: `const LEAGUES = {\n` +
      leagueBlock("J1", "J1", J1_2627, FX_J1, params.model, promoted.promotedAverage) +
      leagueBlock("J2", "J2", J2_2627, FX_J2, paramsJ2.model, paramsJ2.newcomer, byClubJ2, HAS_HIST_J2) +
      `};\n`,
  },
  {
    label: "データ節の見出し",
    re: /   0\) データ.*\n(?:      [^\n]*\n)*/,
    next: `   0) データ（Ｊリーグ公式データサイト。J1 ${j1.length}試合 / J2 ${j2hist.length}試合、いずれも${S.first}-${S.histEnd}）\n` +
      `      tools/fetch.js → tools/parse.js → tools/build.js で生成。手で書き換えないこと\n`,
  },
  {
    label: "画面内『使っているデータ』",
    re: /      <h3>使っているデータ<\/h3>\n[\s\S]*?<\/p>\n/,
    next:
      `      <h3>使っているデータ</h3>\n` +
      `      <ul>\n` +
      `        <li><b>J1 ${S.first}-${S.histEnd} の全${j1.length}試合</b>（Ｊリーグ公式データサイト・試合日つき）</li>\n` +
      `        <li><b>J2 ${S.first}-${S.histEnd} の全${j2hist.length}試合</b>（同上）</li>\n` +
      `        <li><b>${S.label}シーズンの対戦カード J1・J2 各${S.leagues.J1.matches}試合</b>（同上・試合日つき）</li>\n` +
      `      </ul>\n` +
      `      <p>日程データは「順序付きの対戦カードはシーズン中ちょうど1回」「各節に20クラブが1回ずつ」\n` +
      `        という総当たりの制約で検算済みです。</p>\n`,
  },
  {
    label: "画面内『節が進むとどう変わるか』",
    re: /      <h3>節が進むとどう変わるか<\/h3>\n[\s\S]*?<\/ul>\n/,
    next:
      `      <h3>節が進むとどう変わるか</h3>\n` +
      `      <p>今季の試合は、過去シーズンの<b>J1で${params.model.CUR_W}倍・J2で${paramsJ2.model.CUR_W}倍</b>の重みで\n` +
      `        戦力の推定に混ざります。この値は勘ではなく、${S.firstEval}-${S.histEnd}を試合日順にバックテストし、\n` +
      `        <b>学習区間(${S.train.join("-")})と検証区間(${S.test.join("-")})の両方で改善したときだけ採用する</b>という規則で決めました。</p>\n` +
      `      <ul>\n` +
      `        <li>J2 のほうが今季を重く見ます（${paramsJ2.model.CUR_W} 対 ${params.model.CUR_W}）。\n` +
      `          記憶の長さも J2 は短め（HALF_LIFE ${paramsJ2.model.HALF_LIFE} 対 ${params.model.HALF_LIFE}）で、\n` +
      `          <b>J2 は入れ替わりが激しいぶん、古い成績があてにならない</b>ということです</li>\n` +
      `        <li>対戦相性（H2H）は<b>実測すると有害</b>でした。効き幅をほぼ無効（H2H_K=${params.model.H2H_K}）にしています</li>\n` +
      `        <li>中N日などの日程補正も<b>効果を検出できず</b>、既定では何も効きません</li>\n` +
      `      </ul>\n`,
  },
  {
    label: "画面内『どのくらい当たるのか』",
    /* 置換後の中身に </p> が2つある（導入の段落と結びの段落）ので、
       他の節と同じ「最初の </p> まで」では前半しか消せず、
       実行するたび <ul> と結びの段落が1組ずつ増えてしまう。
       次の <h3> の直前までを丸ごと入れ替えることで、何度実行しても同じ結果になる。 */
    re: /      <h3>どのくらい当たるのか<\/h3>\n[\s\S]*?(?=      <h3>)/,
    next: (() => {
      const a1 = params.accuracy, a2 = paramsJ2.accuracy;
      const p = (x) => (x * 100).toFixed(1);
      return `      <h3>どのくらい当たるのか</h3>\n` +
        `      <p>試合日順のバックテスト（その試合の前日までの情報だけで予測する）の結果です。</p>\n` +
        `      <ul>\n` +
        `        <li><b>J1</b>：的中率 <b>${p(a1.hitRate)}%</b>／log loss <b>${a1.logLoss.toFixed(4)}</b>\n` +
        `          （常にホーム勝ちなら ${p(a1.baselineHitRate)}%／${a1.baselineLogLoss.toFixed(4)}）　${a1.matches}試合</li>\n` +
        `        <li><b>J2</b>：的中率 <b>${p(a2.hitRate)}%</b>／log loss <b>${a2.logLoss.toFixed(4)}</b>\n` +
        `          （同 ${p(a2.baselineHitRate)}%／${a2.baselineLogLoss.toFixed(4)}）　${a2.matches}試合</li>\n` +
        `      </ul>\n` +
        `      <p>正直に言うと<b>この程度です</b>。一様に1/3ずつと答えると log loss は 1.0986 なので、\n` +
        `        ランダムよりは明確に良い、という水準にとどまります。サッカーは本質的に読めない競技で、\n` +
        `        ブックメーカーのオッズでも log loss は 1.0 前後です。\n` +
        `        <b>J2 のほうが当てにくい</b>のも数字に出ています。</p>\n`;
    })(),
  },
  {
    label: "フッタの出典",
    re: /    (?:日程|戦績|データ)出典：[\s\S]*?<br>\n(?:    [^\n]*試合。<br>\n)?/,
    next: `    データ出典：<a href="https://data.j-league.or.jp/SFMS01/" target="_blank" rel="noopener">` +
      `Ｊリーグ公式データサイト</a><br>\n` +
      `    ${S.label} 対戦カード J1・J2 各${S.leagues.J1.matches}試合（試合日つき）／学習データ J1 ${j1.length}試合・J2 ${j2hist.length}試合。<br>\n`,
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
console.log(`${S.label} 日程 ${FIXTURES_RAW.length / 2}試合 / 日付判明 ${ROUND_DATES.filter(Boolean).length}/${WEEKS}節`);
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
    re: /\/\* --- \d{4}-\d{2}シーズンのJ1所属\d+クラブ（[^\n]*--- \*\//,
    next: `/* --- ${S.label}シーズンのJ1所属${N_CLUBS}クラブ（data/${S.files.J1} より生成）--- */`,
  },
  {
    file: "index.html",
    label: "PROMOTED の説明",
    re: / \* ${S.first + 1}-${S.histEnd}の昇格\d+クラブ（[^）]*）から実測した。\n \* ホームとアウェイでリーグ平均得点が違う（[\d.]+ 対 [\d.]+）ので、/,
    next: ` * ${S.first + 1}-${S.histEnd}の昇格${promoted.sampleClubs}クラブ（${promoted.sampleAppearances}試合ぶんの出場）から実測した。\n` +
      ` * ホームとアウェイでリーグ平均得点が違う（` +
      `${promoted.leagueAverage.home.toFixed(3)} 対 ${promoted.leagueAverage.away.toFixed(3)}）ので、`,
  },
];

for (const file of ["index.html", "節別予想.html"]) {
  const list = extra.filter((e) => e.file === file);
  if (list.length) apply(file, list);
}
