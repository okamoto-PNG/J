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

const RAW = path.join(__dirname, "..", "data", "raw");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) jleague-study/1.0";
const WAIT_MS = 1200; // 相手サーバに負荷をかけない間隔

/** 取得対象。fid は data.j-league.or.jp の competition_frame_ids */
const TARGETS = [
  // J1：モデルの学習データ（2015-2025）＋ 予想対象シーズン（2026-27）
  ...range(2015, 2026).map((y) => ({ y, fid: 1, tag: "j1" })),
  // ルヴァン杯：週中の別大会。日程負荷の実測に使う
  ...range(2015, 2026).map((y) => ({ y, fid: 11, tag: "ylc" })),
  // J2：昇格クラブ（水戸・千葉）を J2 の成績から評価するため
  ...range(2015, 2026).map((y) => ({ y, fid: 2, tag: "j2" })),
  // J3：J2 の新顔（J3から上がってきたクラブ）を J3 の成績から評価するため
  ...range(2015, 2026).map((y) => ({ y, fid: 3, tag: "j3" })),
];

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
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

  let got = 0, skipped = 0;
  for (const { y, fid, tag } of TARGETS) {
    const file = path.join(RAW, `${tag}-${y}.html`);
    if (!force && fs.existsSync(file) && fs.statSync(file).size > 5000) {
      skipped++;
      continue;
    }
    const url = `https://data.j-league.or.jp/SFMS01/search?competition_years=${y}&competition_frame_ids=${fid}`;
    process.stdout.write(`  ${tag}-${y} ... `);
    const html = await get(url);
    fs.writeFileSync(file, html);
    console.log(`${(html.length / 1024).toFixed(0)}KB`);
    got++;
    await sleep(WAIT_MS);
  }
  console.log(`\n取得 ${got}件 / キャッシュ利用 ${skipped}件  → ${path.relative(process.cwd(), RAW)}`);
})().catch((e) => {
  console.error("失敗:", e.message);
  process.exit(1);
});
