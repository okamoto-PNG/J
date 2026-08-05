/**
 * 公開してはいけない文字列の検出。
 *
 * ★検出語をソースに直接書かないこと。
 * 以前は氏名・メールの一部・勤務先のスラッグ・Windowsのユーザー名を
 * 正規表現リテラルとして並べていた。
 * これは「公開前に個人情報を止める」ための仕掛けなのに、
 * **リポジトリを公開すると、その並び自体が漏洩になる**。見張りが漏らしていたら意味がない。
 *
 * そこで
 *   ・誰にでも当てはまる語（Windowsのパスなど）はここに置く
 *   ・自分に固有の語は data/leak-words.txt に置く（.gitignore 済み。リポジトリに入らない）
 * の2段にした。ファイルが無ければ汎用の語だけで動く。
 *
 * data/leak-words.txt の書き方（1行1語。# で始まる行は無視。大小文字は区別しない）
 *   山田
 *   yamada
 *   example-corp
 */
"use strict";

const fs = require("fs");
const path = require("path");

const WORDS_FILE = path.join(__dirname, "..", "..", "data", "leak-words.txt");

/** 誰の環境でも漏れてはいけないもの。ローカルの絶対パスが混ざっていないかを見る */
const GENERIC = [
  /OneDrive/i,
  /[A-Za-z]:\\/,            // C:\ のような Windows の絶対パス
  /\/Users\/[^/\s"']+/,     // /Users/なまえ
  /\\Users\\[^\\\s"']+/i,   // \Users\なまえ
];

/** 正規表現に使える形へ逃がす */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 検出に使う正規表現の一覧 */
function patterns() {
  let extra = [];
  try {
    extra = fs.readFileSync(WORDS_FILE, "utf8")
      .split("\n").map((s) => s.trim())
      .filter((w) => w && !w.startsWith("#"))
      .map((w) => new RegExp(escape(w), "i"));
  } catch { /* 無ければ汎用の語だけで見る */ }
  return GENERIC.concat(extra);
}

/** text に含まれている「公開してはいけない語」を返す。無ければ空配列 */
const find = (text) => patterns().filter((re) => re.test(text)).map(String);

/** 自分固有の語が設定されているか（検算で「見張りが空でないか」を確かめるのに使う） */
const hasLocalWords = () => {
  try {
    return fs.readFileSync(WORDS_FILE, "utf8")
      .split("\n").some((s) => s.trim() && !s.trim().startsWith("#"));
  } catch { return false; }
};

module.exports = { patterns, find, hasLocalWords, WORDS_FILE, GENERIC };
