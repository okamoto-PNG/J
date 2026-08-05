/**
 * シーズンの境界と、学習区間・検証区間を1箇所で決める。
 *
 * ここが在る理由。以前は「2015-2025 が学習」「2026-27 が予想対象」「学習区間 2018-2022」
 * といった年が、fetch / parse / tune / calibrate / build / verify / アプリのHTML に
 * 直書きされていた。シーズンが変わるたびに10箇所以上を手で直すことになり、
 * **必ずどこかを直し忘れる**（実際に公開版だけ古いまま残ったことがある）。
 *
 * そこで境界は「データを見て導く」ことにし、その結果を data/season.json に1回だけ書く。
 * 下流のスクリプトはそれを読むだけにする。来季やることは
 *
 *     node tools/all.js --refetch
 *
 * だけになり、コードは触らない。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "..", "data");

/** 公式データサイトで遡れる最初の年。ここだけは動かない事実なので定数でよい */
const FIRST_YEAR = 2015;

/**
 * 取得を試す年の一覧。
 * 「今年＋1」まで見る。秋春制では 2026-27 が 2026年に始まるので、
 * 年内に翌シーズンの日程が出ることがある。まだ無い年は fetch.js が空と判断して捨てる。
 */
function fetchYears(now = new Date()) {
  const last = now.getFullYear() + 1;
  const out = [];
  for (let y = FIRST_YEAR; y <= last; y++) out.push(y);
  return out;
}

/**
 * 試合の配列からシーズンの境界を導く。
 *
 *   upcoming … 予想対象。「まだ結果が入っていない試合がある最後のシーズン」。
 *              全部消化済みなら最後のシーズン（＝予想する先が無い状態。警告を出す）
 *   histEnd  … 学習に使う最後のシーズン。upcoming の1つ前
 *   firstEval… バックテストで採点を始めるシーズン。最初の3季は学習用の履歴に回す
 *   test     … 検証区間。消化済みの最後の3シーズン
 *   train    … 学習区間。firstEval から test の直前まで
 *
 * 2015 始まり・2026-27 が予想対象のときは
 *   first 2015 / histEnd 2025 / firstEval 2018 / train [2018,2022] / test [2023,2025]
 * となり、これまで直書きしていた値と一致する。
 */
function derive(rows) {
  const seasons = [...new Set(rows.map((m) => m.s))].filter((s) => Number.isInteger(s)).sort((a, b) => a - b);
  if (!seasons.length) throw new Error("シーズンが1つも見つからない");

  const first = seasons[0];
  const open = seasons.filter((s) => rows.some((m) => m.s === s && m.hg == null));
  const upcoming = open.length ? Math.max(...open) : seasons[seasons.length - 1];
  const allDone = open.length === 0;
  const histEnd = upcoming - 1;

  const firstEval = Math.min(first + 3, histEnd);
  /* 検証区間は消化済みの最後の3季。ただし学習区間が空にならない範囲に収める */
  const testLen = Math.max(1, Math.min(3, histEnd - firstEval));
  const test = [histEnd - testLen + 1, histEnd];
  const train = [firstEval, test[0] - 1];

  return { first, histEnd, upcoming, firstEval, train, test, allDone, seasons };
}

/**
 * 1シーズンぶんの構造を導く（クラブ数・節数・1節の試合数）。
 * 「20クラブ・38節・1節10試合」を直書きしないため。
 * J3 は年によって13〜20クラブと動くので、こう書いておかないと将来必ず壊れる。
 */
function shapeOf(rows) {
  const clubs = [...new Set(rows.flatMap((m) => [m.h, m.a]))].sort();
  const rounds = [...new Set(rows.map((m) => m.round).filter((r) => Number.isInteger(r)))].sort((a, b) => a - b);
  const perWeek = clubs.length ? clubs.length / 2 : 0;
  const weeks = rounds.length;
  return {
    clubs: clubs.length,
    weeks,
    perWeek,
    matches: rows.length,
    /* 各節がきれいに perWeek 試合ずつか（J1・J2 は成り立つ。J3 の変則年は成り立たない） */
    even: perWeek > 0 && weeks > 0 && rows.length === weeks * perWeek &&
      rounds.every((r) => rows.filter((m) => m.round === r).length === perWeek),
  };
}

/** data/season.json を読む。無ければ null */
function read() {
  const f = path.join(DATA, "season.json");
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

/** 読めなければ「先に parse.js を通せ」と言って止まる。下流はこれを使う */
function require_() {
  const s = read();
  if (!s) {
    console.error("data/season.json がありません。先に node tools/parse.js を実行してください。");
    process.exit(1);
  }
  return s;
}

module.exports = { FIRST_YEAR, fetchYears, derive, shapeOf, read, require: require_, DATA };
