/**
 * data/raw/*.html を正規化した JSON に変換する。
 *
 *   node tools/parse.js
 *
 * 出力（data/）
 *   j1-matches.json   J1 2015-2025 の全結果（日付・K/O・会場・観客数つき）
 *   j1-2026.json      2026-27 シーズンの全380試合（日程。結果は未実施）
 *   ylc-matches.json  ルヴァン杯 2015-2026（週中の日程負荷を実測するため）
 *   j2-matches.json   J2 2015-2025（昇格クラブを J2 成績から評価するため）
 *   clubs.json        表記ゆれの対応表と J1 2026-27 の所属20クラブ
 *
 * 取得元のHTMLに手を入れないので、この変換は何度でもやり直せる。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "data");
const RAW = path.join(DATA, "raw");

/* ------------------------------------------------------------------ 正規化 */

/** 全角英数字・記号を半角へ。Ｃ大阪→C大阪 / 川崎Ｆ→川崎F など */
const toHalf = (s) =>
  s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
   .replace(/　/g, " ")
   .trim();

/**
 * クラブ名をアプリ内の表記に合わせる。
 * 公式データサイトの略称はほぼそのまま使えるので、半角化で足りないものだけ列挙する。
 */
const ALIAS = {
  "栃木SC": "栃木",
  "栃木C": "栃木C",   // 栃木シティ（別クラブ。栃木SCと混ぜない）
  "YS横浜": "YS横浜",
};
const club = (s) => {
  const h = toHalf(s);
  return ALIAS[h] ?? h;
};

/** "25/02/14(金)" → "2025-02-14" ／ "未定" → null */
function parseDate(s) {
  const m = toHalf(s).match(/^(\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  return `20${m[1]}-${m[2]}-${m[3]}`;
}

/** " 19:03" → "19:03" ／ 空 → null */
function parseKo(s) {
  const m = toHalf(s).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/**
 * シーズン欄を開始年の数値にする。
 * 2026年から秋春制になり "2026/27" 表記に変わった。またぐ場合は開始年を採る。
 */
function parseSeason(s) {
  const m = toHalf(s).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** "第１節第１日" → { round: 1, day: 1 }。節を持たない大会は round=null */
function parseRound(s) {
  const h = toHalf(s);
  const r = h.match(/第(\d+)節/);
  const d = h.match(/第(\d+)日/);
  return { round: r ? Number(r[1]) : null, day: d ? Number(d[1]) : null, label: h };
}

/**
 * スコア欄を読む。
 *   "2-5"            → { hg:2, ag:5 }
 *   "1-1(PK4-5)"     → { hg:1, ag:1, pk:[4,5] }   90分のスコアを使う
 *   "vs" / "-"       → null（未実施）
 */
function parseScore(s) {
  const h = toHalf(s).replace(/\s+/g, "");
  const m = h.match(/^(\d+)-(\d+)/);
  if (!m) return null;
  const pk = h.match(/PK(\d+)-(\d+)/);
  const out = { hg: Number(m[1]), ag: Number(m[2]) };
  if (pk) out.pk = [Number(pk[1]), Number(pk[2])];
  return out;
}

/* ------------------------------------------------------------------ 抽出 */

/** 検索結果テーブルの tbody だけを対象にする（ページ内JSの混入を防ぐ） */
function tableRows(html) {
  const t = html.match(/<table class="table-base00 search-table">([\s\S]*?)<\/table>/);
  if (!t) throw new Error("検索結果テーブルが見つからない");
  const body = t[1].slice(t[1].indexOf("<tbody>"));
  const rows = [];
  for (const r of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
    if (tds.length >= 10) rows.push(tds);
  }
  return rows;
}

/** 1ファイルを試合オブジェクトの配列にする */
function parseFile(tag, year) {
  const file = path.join(RAW, `${tag}-${year}.html`);
  const rows = tableRows(fs.readFileSync(file, "utf8"));
  const out = [];
  for (const td of rows) {
    // [0]season [1]大会 [2]節 [3]試合日 [4]K/O [5]ホーム [6]スコア [7]アウェイ [8]会場 [9]観客
    const { round, day, label } = parseRound(td[2]);
    const sc = parseScore(td[6]);
    const m = {
      s: parseSeason(td[0]),
      seasonLabel: toHalf(td[0]),
      comp: toHalf(td[1]),
      round, day, roundLabel: label,
      date: parseDate(td[3]),
      ko: parseKo(td[4]),
      h: club(td[5]),
      a: club(td[7]),
      hg: sc ? sc.hg : null,
      ag: sc ? sc.ag : null,
      venue: toHalf(td[8]) || null,
      att: Number(toHalf(td[9]).replace(/,/g, "")) || null,
    };
    if (sc && sc.pk) m.pk = sc.pk;
    if (!m.h || !m.a) continue;
    out.push(m);
  }
  return out;
}

const years = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/* ------------------------------------------------------------------ 出力 */

function write(name, obj) {
  const file = path.join(DATA, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 0) + "\n");
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  const n = Array.isArray(obj) ? obj.length : (obj.matches?.length ?? "-");
  console.log(`  ${name.padEnd(18)} ${String(n).padStart(5)}件  ${kb}KB`);
}

console.log("パース中…");

/* J1：学習用（2015-2025）と予想対象（2026-27）を分ける */
const j1all = years(2015, 2026).flatMap((y) => parseFile("j1", y));
const j1hist = j1all.filter((m) => m.s <= 2025);
const j1next = j1all.filter((m) => m.s === 2026);

/* ルヴァン杯・J2 */
const ylc = years(2015, 2026).flatMap((y) => parseFile("ylc", y));
const j2 = years(2015, 2026).flatMap((y) => parseFile("j2", y));
/* J2 も J1 と同じく「学習用」と「予想対象」に分ける。
   j2-matches.json は昇格クラブの評価に使われているので中身を変えない（2026も含んだまま）。
   予想対象だけを別ファイルに出す。 */
const j2next = j2.filter((m) => m.s === 2026);

write("j1-matches.json", j1hist);
write("j1-2026.json", j1next);
write("ylc-matches.json", ylc);
write("j2-matches.json", j2);
write("j2-2026.json", j2next);

/* クラブ表記の一覧。将来 表記が変わったときに気づけるように残す */
const seen = new Set([...j1all, ...ylc, ...j2].flatMap((m) => [m.h, m.a]));
const j1_2627 = [...new Set(j1next.flatMap((m) => [m.h, m.a]))].sort();
const j2_2627 = [...new Set(j2next.flatMap((m) => [m.h, m.a]))].sort();
write("clubs.json", {
  note: "公式データサイトの略称を半角化したもの。J1_2627 / J2_2627 は 2026-27 シーズンの所属クラブ",
  all: [...seen].sort(),
  J1_2627: j1_2627,
  J2_2627: j2_2627,
});

console.log(`\nJ1 2015-2025: ${j1hist.length}試合 / 2026-27: ${j1next.length}試合`);
console.log(`J2 2015-2026: ${j2.length}試合 / うち 2026-27: ${j2next.length}試合`);
console.log(`ルヴァン: ${ylc.length}試合`);
console.log(`登場クラブ: ${seen.size}  2026-27 J1: ${j1_2627.length}クラブ / J2: ${j2_2627.length}クラブ`);
