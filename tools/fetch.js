/**
 * Ｊリーグ公式データサイト（data.j-league.or.jp）から日程・結果を取得する。
 *
 *   node tools/fetch.js            … 未取得のものだけ取る（キャッシュ利用）
 *   node tools/fetch.js --force    … 全部取り直す
 *
 * 生HTMLは data/raw/ に保存する。パースは parse.js が担当。
 * 「取得」と「解釈」を分けてあるので、パースを直したいときに再取得は不要。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const season = require("./lib/season");

const RAW = path.join(__dirname, "..", "data", "raw");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) jleague-study/1.0";
const WAIT_MS = 1200; // 相手サーバに負荷をかけない間隔

/**
 * 取得対象。fid は data.j-league.or.jp の competition_frame_ids。
 *
 * ★年を直書きしない。tools/lib/season.js が「2015 〜 今年＋1」を出す。
 * まだ日程が出ていない年は結果が空で返るので、保存せずに飛ばす（下の isEmpty）。
 * これでシーズンが変わってもこのファイルを触らなくてよい。
 */
const COMPETITIONS = [
  { fid: 1, tag: "j1", note: "J1：学習データと予想対象" },
  { fid: 11, tag: "ylc", note: "ルヴァン杯：週中の別大会。日程負荷の実測に使う" },
  { fid: 2, tag: "j2", note: "J2：学習データと予想対象／J1昇格クラブの評価" },
  { fid: 3, tag: "j3", note: "J3：J2の新顔（J3から上がってきたクラブ）の評価" },
];
/* --years=2026,2027 で年を絞れる。自動更新（tools/auto.js）が
   「今季ぶんだけ取り直す」「来季が出たか1本だけ見る」のに使う。
   毎週48本取るのは相手のサーバに失礼なので、ふだんは数本で済ませる。 */
const only = (process.argv.find((a) => a.startsWith("--years=")) ?? "")
  .replace("--years=", "").split(",").map(Number).filter(Boolean);
const YEARS = only.length ? only : season.fetchYears();
const TARGETS = COMPETITIONS.flatMap((c) => YEARS.map((y) => ({ y, fid: c.fid, tag: c.tag })));

/**
 * 中身が空か（＝その年の日程がまだ発表されていない）。
 * 検索結果テーブルが無い、または明細行が1つも無ければ空とみなす。
 * 空を保存すると parse.js が「テーブルが見つからない」で落ちるので、保存しない。
 */
function isEmpty(html) {
  const t = html.match(/<table class="table-base00 search-table">([\s\S]*?)<\/table>/);
  if (!t) return true;
  const body = t[1].slice(t[1].indexOf("<tbody>"));
  for (const r of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    if ([...r[1].matchAll(/<td[^>]*>/g)].length >= 10) return false;
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (body.length < 5000) throw new Error(`本文が短すぎる (${body.length}B)`);
      return body;
    } catch (e) {
      if (i === tries) throw e;
      const back = WAIT_MS * Math.pow(2, i);
      console.log(`    再試行 ${i}/${tries - 1}（${e.message}）${back}ms 待機`);
      await sleep(back);
    }
  }
}

(async () => {
  const force = process.argv.includes("--force");
  fs.mkdirSync(RAW, { recursive: true });

  let got = 0, skipped = 0, empty = 0;
  const failed = [];
  console.log(`対象 ${YEARS[0]}〜${YEARS[YEARS.length - 1]}年 × ${COMPETITIONS.length}大会`);
  for (const { y, fid, tag } of TARGETS) {
    const file = path.join(RAW, `${tag}-${y}.html`);
    if (!force && fs.existsSync(file) && fs.statSync(file).size > 5000) {
      skipped++;
      continue;
    }
    const url = `https://data.j-league.or.jp/SFMS01/search?competition_years=${y}&competition_frame_ids=${fid}`;
    process.stdout.write(`  ${tag}-${y} ... `);
    /* ★1年ぶん取れなくても全体を止めない。
       公式サイトは取得が集中するとしばらく 503 を返し、まだ日程が出ていない年と区別できない。
       キャッシュがあるのだから、落ちるより「取れなかった」と記録して進む方がよい。
       自動更新（tools/auto.js）が毎週これを呼ぶので、取り逃しは次回に拾える。 */
    let html;
    try {
      html = await get(url);
    } catch (e) {
      console.log(`取れなかった（${e.message}）`);
      failed.push(`${tag}-${y}`);
      await sleep(WAIT_MS);
      continue;
    }
    /* まだ日程が出ていない年。保存しない（保存すると parse.js が落ちる） */
    if (isEmpty(html)) {
      console.log("まだ日程が無い（保存しない）");
      if (fs.existsSync(file)) fs.unlinkSync(file);      // 前に空を保存していたら消す
      empty++;
      await sleep(WAIT_MS);
      continue;
    }
    fs.writeFileSync(file, html);
    console.log(`${(html.length / 1024).toFixed(0)}KB`);
    got++;
    await sleep(WAIT_MS);
  }
  console.log(`\n取得 ${got}件 / キャッシュ利用 ${skipped}件 / 日程未発表 ${empty}件` +
    (failed.length ? ` / 取れなかった ${failed.length}件（${failed.join(", ")}）` : "") +
    `  → ${path.relative(process.cwd(), RAW)}`);

  /* 1件も無いときだけ本当の失敗とみなす。それ以外はキャッシュで進められる */
  const have = fs.existsSync(RAW) ? fs.readdirSync(RAW).filter((f) => f.endsWith(".html")).length : 0;
  if (!have) {
    console.error("生データが1件もありません。ネットワークを確かめてください。");
    process.exit(1);
  }
  if (failed.length) {
    console.log("※ 取れなかったぶんはキャッシュのまま進みます（次回の自動更新で拾えます）。");
  }
  console.log("次は node tools/parse.js。シーズンの境界はそこで自動的に決まります。");
})().catch((e) => {
  console.error("失敗:", e.message);
  process.exit(1);
});
