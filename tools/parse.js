/**
 * data/raw/*.html を正規化した JSON に変換する。
 *
 *   node tools/parse.js
 *
 * 出力（data/）
 *   j1-matches.json   J1 2015-2025 の全結果（日付・K/O・会場・観客数つき）
 *   j1-<年>.json      予想対象シーズンの全試合（日程。結果は未実施）
 *   ylc-matches.json  ルヴァン杯 2015-2026（週中の日程負荷を実測するため）
 *   j2-matches.json   J2 2015-2025（昇格クラブを J2 成績から評価するため）
 *   j3-matches.json   J3 2015-2026（J2 の新顔を J3 成績から評価するため）
 *   clubs.json        表記ゆれの対応表と J1 2026-27 の所属20クラブ
 *
 * 取得元のHTMLに手を入れないので、この変換は何度でもやり直せる。
 *
 * ai-yosou.js が「今この瞬間のHTML」を読むために parseHtml() を借りるので、
 * 直接実行されたときだけ書き出すようにしてある（下の require.main 判定）。
 * パーサはここ1箇所だけに置く。ふたつに分けると必ず片方が古くなる。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const season = require("./lib/season");

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
  return parseHtml(fs.readFileSync(file, "utf8"));
}

/** 生HTML1ページを試合オブジェクトの配列にする（ファイル経由でも文字列でも同じ結果） */
function parseHtml(html) {
  const rows = tableRows(html);
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

/**
 * raw/ に実際に置いてある年だけを読む。
 * 年を直書きしないので、fetch.js が新しい年を取ってくれば自動的に増える。
 */
function yearsOf(tag) {
  return fs.readdirSync(RAW)
    .map((f) => new RegExp(`^${tag}-(\\d{4})\\.html$`).exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}
const parseTag = (tag) => yearsOf(tag).flatMap((y) => parseFile(tag, y));

/* ------------------------------------------------------------------ 出力 */

function write(name, obj) {
  const file = path.join(DATA, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 0) + "\n");
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  const n = Array.isArray(obj) ? obj.length : (obj.matches?.length ?? "-");
  console.log(`  ${name.padEnd(18)} ${String(n).padStart(5)}件  ${kb}KB`);
}

function main() {
  console.log("パース中…");

  const j1all = parseTag("j1");
  const ylc = parseTag("ylc");
  const j2 = parseTag("j2");
  const j3 = parseTag("j3");

  /* ★シーズンの境界は直書きしない。J1 のデータから導く（tools/lib/season.js）。
     「まだ結果が入っていない試合がある最後のシーズン」が予想対象で、その1つ前までが学習用。
     来季のデータが増えれば境界は自動的に1つ進むので、このファイルを触る必要はない。 */
  const S = season.derive(j1all);
  const UP = S.upcoming;
  const label = `${UP}-${String(UP + 1).slice(2)}`;
  console.log(`  シーズン境界: 学習 ${S.first}-${S.histEnd} / 予想対象 ${label}`);
  if (S.allDone) {
    console.log("  ⚠ 全シーズンが消化済みです。次シーズンの日程が出たら fetch し直してください。");
  }

  const j1hist = j1all.filter((m) => m.s <= S.histEnd);
  const j1next = j1all.filter((m) => m.s === UP);
  /* J2・J3 の -matches は昇格/新顔クラブの評価に使うので予想対象シーズンも含めたまま置く
     （結果が null の試合は使う側で外している）。予想対象だけを別ファイルにも出す。 */
  const j2next = j2.filter((m) => m.s === UP);
  const j3next = j3.filter((m) => m.s === UP);

  write("j1-matches.json", j1hist);
  write(`j1-${UP}.json`, j1next);
  write("ylc-matches.json", ylc);
  write("j2-matches.json", j2);
  write(`j2-${UP}.json`, j2next);
  write("j3-matches.json", j3);
  write(`j3-${UP}.json`, j3next);

  /* 古いシーズンの予想対象ファイルが残っていると、どちらが正か分からなくなるので消す */
  for (const f of fs.readdirSync(DATA)) {
    const m = /^(j1|j2|j3)-(\d{4})\.json$/.exec(f);
    if (m && Number(m[2]) !== UP) {
      fs.unlinkSync(path.join(DATA, f));
      console.log(`  （古い ${f} を削除）`);
    }
  }

  /* クラブ表記の一覧。将来 表記が変わったときに気づけるように残す */
  const seen = new Set([...j1all, ...ylc, ...j2, ...j3].flatMap((m) => [m.h, m.a]));
  const clubsOf = (rows) => [...new Set(rows.flatMap((m) => [m.h, m.a]))].sort();
  write("clubs.json", {
    note: `公式データサイトの略称を半角化したもの。next は予想対象シーズン（${label}）の所属クラブ`,
    season: UP,
    all: [...seen].sort(),
    next: { J1: clubsOf(j1next), J2: clubsOf(j2next), J3: clubsOf(j3next) },
  });

  /* ★ここが「来季コードを触らない」ための要。下流はこのファイルだけを見る。 */
  write("season.json", {
    note: "シーズンの境界と学習/検証区間。tools/parse.js が data から導いて書く。手で書き換えないこと",
    rule: "予想対象=まだ結果が無い試合がある最後のシーズン / 学習=その1つ前まで / " +
      "採点開始=最初+3季 / 検証=消化済みの最後3季 / 学習区間=採点開始〜検証の直前",
    first: S.first,
    histEnd: S.histEnd,
    upcoming: UP,
    label,
    allDone: S.allDone,
    firstEval: S.firstEval,
    train: S.train,
    test: S.test,
    /* 予想の締切を数える基準日。
       ★「予想対象シーズンの1月1日」と決め打っていたが、それは仮定でしかない。
       来季を模擬したとき、日程の並びが想定と違うだけで build.js が
       「日付が想定の範囲外」で止まった。基準日は実データの最も早い試合日から取る。 */
    koEpochUTC: (() => {
      const ds = [...j1next, ...j2next, ...j3next].map((m) => m.date).filter(Boolean).sort();
      return ds.length ? Date.parse(ds[0] + "T00:00:00Z") : Date.UTC(UP, 0, 1);
    })(),
    koEpochDate: (() => {
      const ds = [...j1next, ...j2next, ...j3next].map((m) => m.date).filter(Boolean).sort();
      return ds[0] ?? `${UP}-01-01`;
    })(),
    files: { J1: `j1-${UP}.json`, J2: `j2-${UP}.json`, J3: `j3-${UP}.json` },
    leagues: {
      J1: season.shapeOf(j1next),
      J2: season.shapeOf(j2next),
      J3: season.shapeOf(j3next),
    },
    history: {
      J1: { from: S.first, to: S.histEnd, matches: j1hist.length },
      J2: { from: S.first, to: S.histEnd, matches: j2.filter((m) => m.s <= S.histEnd).length },
      J3: { from: S.first, to: S.histEnd, matches: j3.filter((m) => m.s <= S.histEnd).length },
    },
  });

  console.log(`\nJ1 ${S.first}-${S.histEnd}: ${j1hist.length}試合 / ${label}: ${j1next.length}試合`);
  console.log(`J2 ${S.first}-${UP}: ${j2.length}試合 / うち ${label}: ${j2next.length}試合`);
  console.log(`J3 ${S.first}-${UP}: ${j3.length}試合 / うち ${label}: ${j3next.length}試合`);
  console.log(`ルヴァン: ${ylc.length}試合`);
  console.log(`登場クラブ: ${seen.size}  ${label} J1: ${clubsOf(j1next).length} / ` +
    `J2: ${clubsOf(j2next).length} / J3: ${clubsOf(j3next).length}クラブ`);
  console.log(`学習区間 ${S.train.join("-")} / 検証区間 ${S.test.join("-")}（採点開始 ${S.firstEval}）`);
}

/* `node tools/parse.js` のときだけ書き出す。require されたときは何もしない */
if (require.main === module) main();

module.exports = { parseHtml, parseFile, club, toHalf };
