/**
 * AI（Claude）に J1 の試合を予想させる。
 *
 *   node tools/ai-yosou.js                          … 次の節を全部
 *   node tools/ai-yosou.js --round 3                … 節を指定
 *   node tools/ai-yosou.js --home 鹿島 --away 浦和   … カードを指定
 *   node tools/ai-yosou.js --dry                    … プロンプトを表示してAPIは呼ばない
 *   node tools/ai-yosou.js --no-fetch               … 取得せず data/*.json だけで作る
 *   node tools/ai-yosou.js --model claude-sonnet-5  … モデルを変える
 *
 * 実行ごとに公式データサイトから今季のHTMLを取り直すので、
 * 節が進めば勝手に最新の順位・直近成績を見て予想する（キャッシュしない）。
 *
 * 出力：ターミナル＋ AI予想.html
 *
 * ⚠ index.html / 節別予想.html の統計モデルとは別物で、精度の裏付けはありません。
 *    こちらは「LLMに数字を渡したら何と言うか」を見るための実験です。
 *    確率の較正はLLMの得意分野ではないので、素直に信じないこと。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { parseHtml } = require("./parse.js");
const { load, dayNum, nakaDays, buildAppearances, previousMatch } = require("./lib/data.js");

const ROOT = path.join(__dirname, "..");
/* 予想対象シーズンと前季は data/season.json から。直書きしない */
const SEASON_INFO = require("./lib/season").require();
const SEASON = SEASON_INFO.upcoming;
const PREV = SEASON_INFO.histEnd;
const OUT = path.join(ROOT, "AI予想.html");

const MODEL = "claude-opus-5";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) jleague-study/1.0";
const WAIT_MS = 1200;           // 相手サーバに負荷をかけない間隔（fetch.js と同じ）

/** $/1Mトークン。実行コストを出すだけに使う */
const PRICES = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** J1 2015-2025 全3588試合から出した基準率。較正の錨として渡す（data/README.md 4章） */
const BASE = {
  homeWin: 0.407, draw: 0.250, awayWin: 0.343,
  homeGoals: 1.376, awayGoals: 1.212,
};

/* ================================================================== 引数 */

function args(argv) {
  const o = { round: null, home: null, away: null, dry: false, fetch: true, model: MODEL };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") o.dry = true;
    else if (a === "--no-fetch") o.fetch = false;
    else if (a === "--round") o.round = Number(argv[++i]);
    else if (a === "--home") o.home = argv[++i];
    else if (a === "--away") o.away = argv[++i];
    else if (a === "--model") o.model = argv[++i];
    else throw new Error(`知らない引数: ${a}`);
  }
  if (o.round != null && !Number.isInteger(o.round)) throw new Error("--round には節の数字を渡す");
  if ((o.home && !o.away) || (!o.home && o.away)) throw new Error("--home と --away は両方セットで渡す");
  return o;
}

/* ================================================================== 取得 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch.js と同じ URL・同じ再試行。ただしキャッシュせず、その場でパースする */
async function fetchLive(fid, year, tries = 4) {
  const url = `https://data.j-league.or.jp/SFMS01/search?competition_years=${year}&competition_frame_ids=${fid}`;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (body.length < 5000) throw new Error(`本文が短すぎる (${body.length}B)`);
      return parseHtml(body);
    } catch (e) {
      if (i === tries) throw e;
      const back = WAIT_MS * Math.pow(2, i);
      console.log(`    再試行 ${i}/${tries - 1}（${e.message}）${back}ms 待機`);
      await sleep(back);
    }
  }
}

/**
 * 予想に必要なデータを揃える。
 * 今季とルヴァン杯だけ取り直す。2015-2025 は動かないので data/*.json のまま使う。
 */
async function gather(doFetch) {
  const hist = load("j1-matches.json");   // J1 2015-2025
  const j2 = load("j2-matches.json");     // J2 2015-2026（昇格クラブの前季用）

  let season, ylc, source;
  if (doFetch) {
    console.log("今季のデータを取得中…");
    process.stdout.write("  J1 2026 ... ");
    season = await fetchLive(1, SEASON);
    console.log(`${season.length}試合`);
    await sleep(WAIT_MS);
    process.stdout.write("  ルヴァン 2026 ... ");
    ylc = await fetchLive(11, SEASON);
    console.log(`${ylc.length}試合`);
    source = "実行時に公式データサイトから取得";
  } else {
    season = load(SEASON_INFO.files.J1);
    ylc = load("ylc-matches.json").filter((m) => m.s === SEASON);
    source = "data/*.json（--no-fetch）";
  }

  const played = season.filter((m) => m.hg != null);
  console.log(`\n今季 ${season.length}試合中 ${played.length}試合が消化済み`);
  return { hist, j2, season, ylc, played, source };
}

/* ============================================================ 集計（特徴量） */

/** 試合配列から順位表を作る。勝点→得失点差→総得点 の順で並べる */
function table(rows) {
  const t = new Map();
  const get = (c) => t.get(c) ?? t.set(c, { club: c, gp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }).get(c);
  for (const m of rows) {
    if (m.hg == null || m.ag == null) continue;
    const h = get(m.h), a = get(m.a);
    h.gp++; a.gp++;
    h.gf += m.hg; h.ga += m.ag;
    a.gf += m.ag; a.ga += m.hg;
    if (m.hg > m.ag) { h.w++; a.l++; h.pts += 3; }
    else if (m.hg < m.ag) { a.w++; h.l++; a.pts += 3; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  return [...t.values()].sort((x, y) =>
    y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
}

const rankOf = (tbl, club) => {
  const i = tbl.findIndex((r) => r.club === club);
  return i < 0 ? null : i + 1;
};

/** あるクラブの直近N試合を新しい順に。"○ 2-1 H 浦和" の形の文字列にする */
function recent(rows, club, n) {
  const mine = rows
    .filter((m) => m.hg != null && (m.h === club || m.a === club))
    .sort((x, y) => (dayNum(y.date) ?? 0) - (dayNum(x.date) ?? 0))
    .slice(0, n);
  return mine.map((m) => {
    const home = m.h === club;
    const [gf, ga] = home ? [m.hg, m.ag] : [m.ag, m.hg];
    const mark = gf > ga ? "○" : gf < ga ? "●" : "△";
    return `${mark} ${gf}-${ga} ${home ? "H" : "A"} ${home ? m.a : m.h}`;
  });
}

/** ホーム/アウェイ別の成績 */
function split(rows, club, asHome) {
  const key = asHome ? "h" : "a";
  const mine = rows.filter((m) => m.hg != null && m[key] === club);
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  for (const m of mine) {
    const [x, y] = asHome ? [m.hg, m.ag] : [m.ag, m.hg];
    gf += x; ga += y;
    if (x > y) w++; else if (x < y) l++; else d++;
  }
  return { gp: mine.length, w, d, l, gf, ga };
}

/** 直接対戦の履歴（新しい順）。ホーム側から見た表記にする */
function h2h(rows, home, away, n) {
  return rows
    .filter((m) => m.hg != null &&
      ((m.h === home && m.a === away) || (m.h === away && m.a === home)))
    .sort((x, y) => (dayNum(y.date) ?? 0) - (dayNum(x.date) ?? 0))
    .slice(0, n)
    .map((m) => `${m.date} ${m.h} ${m.hg}-${m.ag} ${m.a}`);
}

/** 前季の立ち位置。J1にいなければ J2 の成績を返す */
function prevSeason(histTable, j2Table, club) {
  const j1 = histTable.find((r) => r.club === club);
  if (j1) return { league: "J1", rank: rankOf(histTable, club), ...j1 };
  const j2r = j2Table.find((r) => r.club === club);
  if (j2r) return { league: "J2", rank: rankOf(j2Table, club), ...j2r };
  return null;
}

/** 中N日と、その直前の公式戦 */
function rest(appearances, club, day) {
  const prev = previousMatch(appearances, club, SEASON, day);
  if (!prev) return null;
  return { naka: nakaDays(day - prev.day), comp: prev.comp, kind: prev.kind };
}

/** 1試合ぶんの「渡す材料」をまとめる */
function context(fixture, d) {
  const { hist, season, ylc, played } = d;
  const histPrev = hist.filter((m) => m.s === PREV);
  const j2Prev = d.j2.filter((m) => m.s === PREV);
  const tblPrevJ1 = table(histPrev);
  const tblPrevJ2 = table(j2Prev);
  const tblNow = table(played);

  const appearances = buildAppearances([
    { rows: season, kind: "league" },
    { rows: ylc, kind: "cup" },
  ]);
  const day = dayNum(fixture.date);

  const per = (club, asHome) => ({
    club,
    now: tblNow.find((r) => r.club === club) ?? null,
    rank: rankOf(tblNow, club),
    split: split(played, club, asHome),
    recent5: recent(season, club, 5),
    prev: prevSeason(tblPrevJ1, tblPrevJ2, club),
    rest: day == null ? null : rest(appearances, club, day),
  });

  return {
    fixture,
    home: per(fixture.h, true),
    away: per(fixture.a, false),
    h2h: h2h([...hist, ...played], fixture.h, fixture.a, 8),
    teams: tblNow.length,
  };
}

/* ================================================================== プロンプト */

const pctRow = (s) => `${s.gp}試合 ${s.w}勝${s.d}分${s.l}敗 得点${s.gf} 失点${s.ga}`;

function describe(side, label) {
  const L = [];
  L.push(`【${label}】${side.club}`);
  if (side.now) {
    L.push(`  今季通算: ${side.rank}位 勝点${side.now.pts} ${pctRow(side.now)}`);
  } else {
    L.push(`  今季通算: まだ試合なし`);
  }
  if (side.split.gp) L.push(`  ${label}での成績: ${pctRow(side.split)}`);
  L.push(`  直近5試合(新しい順): ${side.recent5.length ? side.recent5.join(" / ") : "なし"}`);
  if (side.prev) {
    L.push(`  前季(${PREV}): ${side.prev.league} ${side.prev.rank}位 勝点${side.prev.pts} ${pctRow(side.prev)}`);
  } else {
    L.push(`  前季(${PREV}): データなし`);
  }
  if (side.rest) {
    L.push(`  直前の公式戦から中${side.rest.naka}日（${side.rest.comp}）`);
  } else {
    L.push(`  直前の公式戦: なし（今季初戦）`);
  }
  return L.join("\n");
}

function prompt(ctx) {
  const f = ctx.fixture;
  return [
    `# 予想する試合`,
    `${f.seasonLabel} J1 第${f.round}節  ${f.date ?? "日付未定"} ${f.ko ?? ""}`,
    `${f.h}（ホーム） vs ${f.a}（アウェイ）  会場: ${f.venue ?? "未定"}`,
    ``,
    `# J1の基準率（2015-2025 全3588試合の実測）`,
    `ホーム勝ち ${(BASE.homeWin * 100).toFixed(1)}% / 引き分け ${(BASE.draw * 100).toFixed(1)}% / アウェイ勝ち ${(BASE.awayWin * 100).toFixed(1)}%`,
    `1試合平均得点 ホーム ${BASE.homeGoals} / アウェイ ${BASE.awayGoals}`,
    ``,
    `# 両クラブの状況`,
    describe(ctx.home, "ホーム"),
    ``,
    describe(ctx.away, "アウェイ"),
    ``,
    `# 直接対戦（新しい順・最大8件）`,
    ctx.h2h.length ? ctx.h2h.join("\n") : "記録なし",
  ].join("\n");
}

const SYSTEM = [
  "あなたはJリーグの試合結果を確率で予想します。渡された数字だけを根拠にしてください。",
  "",
  "守ること:",
  "- 3つの確率の合計を 1.0 にする。",
  "- 上に示した基準率から出発し、両クラブの差を根拠に動かす。理由なく極端な値にしない。",
  "- 引き分けの確率を不当に低く見積もらない。Jリーグでは実測で25%ある。",
  "- 消化試合数が少ない時期は標本が小さい。今季の数字を過大評価せず、前季の順位に重みを置く。",
  "- 知らないこと（移籍・負傷・監督交代・モチベーション）は推測しない。渡されていない情報は使わない。",
  "- reasons は数字に基づく事実を1文ずつ、最大3つ。印象論は書かない。",
  "- caveat には「この予想が外れるとしたら何が原因か」を1文で書く。",
].join("\n");

/** 数値制約（minimum/maximum）はスキーマで使えないので、合計は受け取ってから直す */
const SCHEMA = {
  type: "object",
  properties: {
    home_win: { type: "number", description: "ホーム勝利の確率。0〜1" },
    draw: { type: "number", description: "引き分けの確率。0〜1" },
    away_win: { type: "number", description: "アウェイ勝利の確率。0〜1" },
    score: { type: "string", description: 'もっとも可能性が高いスコア。"2-1" の形（ホーム-アウェイ）' },
    confidence: { type: "string", enum: ["低", "中", "高"], description: "この予想への自信" },
    reasons: { type: "array", items: { type: "string" }, description: "根拠。各1文、最大3つ" },
    caveat: { type: "string", description: "外れるとしたら何が原因か。1文" },
  },
  required: ["home_win", "draw", "away_win", "score", "confidence", "reasons", "caveat"],
  additionalProperties: false,
};

/* ================================================================== API */

async function ask(client, model, text) {
  const res = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: text }],
  });

  // Claude Opus 5 は安全性の判断で応答を止めることがある。content を読む前に確認する
  if (res.stop_reason === "refusal") {
    throw new Error(`モデルが応答を拒否しました（${res.stop_details?.category ?? "理由不明"}）`);
  }
  if (res.stop_reason === "max_tokens") {
    throw new Error("max_tokens に達して出力が途中で切れました");
  }

  const block = res.content.find((b) => b.type === "text");
  if (!block) throw new Error("テキストブロックが返りませんでした");

  return { ...normalize(JSON.parse(block.text)), usage: res.usage };
}

/**
 * 3つの確率を合計1に直す。ずれの大きさ（sumBefore）は捨てずに残す。
 * 「合計1にしろ」と指示してもモデルは外すことがあるので、こちらで直す。
 */
function normalize(raw) {
  const sum = raw.home_win + raw.draw + raw.away_win;
  if (!(sum > 0)) throw new Error(`確率の合計が ${sum} になっています`);
  return {
    ...raw,
    p: { home: raw.home_win / sum, draw: raw.draw / sum, away: raw.away_win / sum },
    sumBefore: sum,
  };
}

/* ================================================================== 出力 */

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function report(r) {
  const { fixture: f } = r.ctx;
  console.log(`\n${"─".repeat(56)}`);
  console.log(`第${f.round}節  ${f.h} vs ${f.a}   ${f.date ?? "日付未定"}`);
  if (r.error) {
    console.log(`  失敗: ${r.error}`);
    return;
  }
  const a = r.answer;
  console.log(`  ホーム ${pct(a.p.home)}  引分 ${pct(a.p.draw)}  アウェイ ${pct(a.p.away)}`);
  console.log(`  想定スコア ${a.score}   自信: ${a.confidence}`);
  if (Math.abs(a.sumBefore - 1) > 0.02) {
    console.log(`  ※ 合計が ${a.sumBefore.toFixed(3)} だったので正規化した`);
  }
  for (const s of a.reasons) console.log(`  ・${s}`);
  console.log(`  外れる要因: ${a.caveat}`);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function html(results, meta) {
  const cards = results.map((r) => {
    const f = r.ctx.fixture;
    const head = `<h3>${esc(f.h)} <span class="vs">vs</span> ${esc(f.a)}
      <span class="meta">第${f.round}節 ${esc(f.date ?? "日付未定")} ${esc(f.ko ?? "")} ${esc(f.venue ?? "")}</span></h3>`;
    if (r.error) return `<article class="card"><span class="err">失敗: ${esc(r.error)}</span>${head}</article>`;
    const a = r.answer;
    const bar = `<div class="prob">
      <div class="h" style="flex-grow:${a.p.home}">${pct(a.p.home)}</div>
      <div class="d" style="flex-grow:${a.p.draw}">${pct(a.p.draw)}</div>
      <div class="a" style="flex-grow:${a.p.away}">${pct(a.p.away)}</div>
    </div>
    <div class="plabels"><span>${esc(f.h)} 勝ち</span><span>引き分け</span><span>${esc(f.a)} 勝ち</span></div>`;
    return `<article class="card">
      ${head}
      ${bar}
      <p class="score">想定スコア <b>${esc(a.score)}</b><span class="pill">自信 ${esc(a.confidence)}</span></p>
      <ul>${a.reasons.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
      <p class="caveat"><b>外れる要因</b> ${esc(a.caveat)}</p>
    </article>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI予想 J1 ${SEASON}-27</title>
<style>
  :root{ --bg:#f5f6f8; --panel:#fff; --panel2:#fafbfc; --text:#16191d; --muted:#6b7280;
         --line:#e3e6ea; --home:#2563eb; --draw:#9ca3af; --away:#dc2626; --warn:#d97706; }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#121519; --panel:#1b1f24; --panel2:#22272d; --text:#e7eaee; --muted:#98a2ad;
           --line:#2d333a; --home:#60a5fa; --away:#f87171; }
  }
  *{box-sizing:border-box}
  body{margin:0;padding:20px 14px 60px;background:var(--bg);color:var(--text);
       font-family:system-ui,"Segoe UI","Hiragino Sans","Meiryo",sans-serif;line-height:1.6}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:1.25rem;margin:0 0 4px}
  .sub{color:var(--muted);font-size:.82rem;margin:0 0 14px}
  .warnbox{background:rgba(217,119,6,.1);border:1px solid rgba(217,119,6,.35);
           border-radius:8px;padding:10px 13px;font-size:.8rem;margin-bottom:18px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
        padding:14px 18px 16px;margin-bottom:14px}
  h3{font-size:1rem;margin:0 0 12px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  h3 .vs{color:var(--muted);font-weight:400;font-size:.85rem}
  h3 .meta{color:var(--muted);font-weight:400;font-size:.74rem;margin-left:auto}
  .prob{display:flex;height:34px;border-radius:8px;overflow:hidden;border:1px solid var(--line)}
  .prob div{display:flex;align-items:center;justify-content:center;font-size:.8rem;
            font-weight:700;color:#fff;min-width:0}
  .prob .h{background:var(--home)} .prob .d{background:var(--draw)} .prob .a{background:var(--away)}
  .plabels{display:flex;justify-content:space-between;font-size:.74rem;color:var(--muted);margin:6px 0 12px}
  .score{margin:0 0 8px;font-size:.9rem}
  .pill{display:inline-block;font-size:.7rem;padding:1px 7px;border-radius:4px;
        background:var(--line);color:var(--muted);margin-left:8px}
  ul{margin:0 0 10px;padding-left:1.25em;font-size:.84rem}
  li{margin-bottom:3px}
  .caveat{margin:0;padding-top:9px;border-top:1px dashed var(--line);font-size:.8rem;color:var(--muted)}
  .caveat b{color:var(--text)}
  .err{color:var(--away);font-size:.84rem}
  footer{font-size:.74rem;color:var(--muted);text-align:center;margin-top:24px;line-height:1.8}
</style>
</head>
<body>
<div class="wrap">
  <h1>AI予想 <span style="font-weight:400;font-size:.8rem;color:var(--muted)">J1 ${SEASON}-27</span></h1>
  <p class="sub">${esc(meta.model)} による予想 / 生成 ${esc(meta.at)} / データ: ${esc(meta.source)}</p>

  <div class="warnbox">
    これは<b>統計モデルではなく、大規模言語モデルに数字を読ませた結果</b>です。
    <a href="index.html">index.html</a> / <a href="節別予想.html">節別予想.html</a> のポアソンモデルとは別物で、
    <b>精度を検証していません</b>。確率の較正はLLMの得意分野ではないので、そのまま信じないでください。
    賭博などの用途を意図していません。
  </div>

${cards}

  <footer>
    データ出典：<a href="https://data.j-league.or.jp/SFMS01/" target="_blank" rel="noopener">Ｊリーグ公式データサイト</a><br>
    生成: <code>node tools/ai-yosou.js</code>　学習用に作成。
  </footer>
</div>
</body>
</html>
`;
}

/* ================================================================== 本体 */

async function main() {
  const o = args(process.argv);

  /* キーが無いなら取得の前に止める（無駄なリクエストを飛ばさない） */
  if (!o.dry && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY が設定されていません。\n" +
      "  PowerShell:  $env:ANTHROPIC_API_KEY = 'sk-ant-...'\n" +
      "  キーは https://platform.claude.com/ で作れます。\n" +
      "  先に中身だけ見たいときは --dry を付けてください。"
    );
  }

  const d = await gather(o.fetch);

  /* 予想する試合を決める */
  let targets;
  if (o.home) {
    targets = d.season.filter((m) => m.h === o.home && m.a === o.away);
    if (!targets.length) throw new Error(`${o.home}（H） vs ${o.away}（A）という試合が今季の日程にありません`);
  } else {
    const round = o.round ?? Math.min(...d.season.filter((m) => m.hg == null).map((m) => m.round));
    if (!Number.isFinite(round)) throw new Error("未実施の試合がありません（今季終了）");
    targets = d.season.filter((m) => m.round === round);
    if (!targets.length) throw new Error(`第${round}節が見つかりません`);
    console.log(`対象: 第${round}節 ${targets.length}試合`);
  }
  targets.sort((x, y) => String(x.date).localeCompare(String(y.date)) || x.h.localeCompare(y.h));

  const contexts = targets.map((f) => context(f, d));

  if (o.dry) {
    for (const ctx of contexts) {
      console.log(`\n${"=".repeat(60)}\n${prompt(ctx)}`);
    }
    console.log(`\n${"=".repeat(60)}\n--dry なのでAPIは呼びませんでした（${contexts.length}件）`);
    return;
  }

  const client = new Anthropic();
  const results = [];
  let inTok = 0, outTok = 0;

  console.log(`\n${o.model} に問い合わせ中…`);
  for (const ctx of contexts) {
    try {
      const answer = await ask(client, o.model, prompt(ctx));
      inTok += answer.usage.input_tokens;
      outTok += answer.usage.output_tokens;
      results.push({ ctx, answer });
    } catch (e) {
      results.push({ ctx, error: e.message });
    }
    report(results[results.length - 1]);
  }

  /* 実行コスト。学習用なので毎回出す */
  const price = PRICES[o.model];
  console.log(`\n${"─".repeat(56)}`);
  console.log(`トークン: 入力 ${inTok.toLocaleString()} / 出力 ${outTok.toLocaleString()}`);
  if (price) {
    const usd = (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
    console.log(`概算コスト: $${usd.toFixed(4)}`);
  }

  const ok = results.filter((r) => !r.error).length;
  fs.writeFileSync(OUT, html(results, {
    model: o.model,
    at: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    source: d.source,
  }));
  console.log(`\n${ok}/${results.length}件 成功  → ${path.relative(process.cwd(), OUT)}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n失敗: ${e.message}`);
    process.exit(1);
  });
}

/* 検算から呼べるように出しておく（tools/verify-ai.js） */
module.exports = { table, rankOf, recent, split, h2h, prevSeason, context, prompt, normalize, SCHEMA };
