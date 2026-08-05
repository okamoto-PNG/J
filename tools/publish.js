/**
 * 公開用ページを組み立てる。
 *
 *   node tools/publish.js          … 本体（節別予想.html）から作り直す
 *   node tools/publish.js <file>   … 別のファイルを本体として使う
 *
 * やることは「アプリ本体のHTML」＋「結果の自動取得アドオン」を繋ぐだけ。
 * 何度実行しても同じ結果になる（古いアドオンは剥がしてから付け直す）。
 *
 * ★以前は publish/build.js に置いていた。tools/ へ移した理由は2つ。
 *   1) publish/ は生成物だけの置き場にしたい。ソースが生成物の中にあると、
 *      publish/ を消したり別リポジトリにしたりした瞬間にビルドできなくなる。
 *   2) publish/ は親リポジトリでは追跡しない（独立したリポジトリ）ので、
 *      その中にソースがあると GitHub Actions が公開版を作れない。
 *
 * 出力
 *   publish/index.html       … 中身の確認用
 *   publish/site/index.html  … 配る用（このフォルダだけ置けばよい）
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "publish");
const SITE = path.join(PUB, "site");
const OUT = path.join(PUB, "index.html");
const ADDON = path.join(__dirname, "sync-addon.html");
const SRC = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(ROOT, "節別予想.html");

const START = "<!-- sync-addon:start -->", END = "<!-- sync-addon:end -->";

/** 既に入っているアドオンを剥がす（何度でも実行できるようにするため） */
function strip(html) {
  const i = html.indexOf(START), j = html.indexOf(END);
  if (i < 0 || j < 0) return html;
  return html.slice(0, i).replace(/\s*$/, "\n") + html.slice(j + END.length).replace(/^\s*/, "\n");
}

const addon = fs.readFileSync(ADDON, "utf8").trim();
let src = fs.readFileSync(SRC, "utf8");
const had = src.includes(START);
src = strip(src);

/* --- 本体が想定どおりか確かめてから繋ぐ --- */
const needs = ["const LEAGUES", "const STATE", "function useLeague(",
               "function save(", "function refit(", "function renderAll("];
const missing = needs.filter((n) => !src.includes(n));
if (missing.length) {
  console.error("本体の作りが変わっています。アドオンが噛み合いません:\n  " + missing.join("\n  "));
  console.error("tools/sync-addon.html が借りている名前を、本体に合わせて直してください。");
  process.exit(1);
}
if (!src.includes("</body>")) { console.error("</body> が見つかりません: " + SRC); process.exit(1); }
if (!/<meta name="viewport"/i.test(src)) console.warn("警告: viewport メタがありません（スマホ表示が崩れます）");

const out = src.replace("</body>", addon + "\n</body>");

/* --- 公開して問題ない中身か。ここで止めれば、事故は公開前に防げる ---
   検出語は tools/lib/leaks.js が持つ。ここに直接書くと、リポジトリを公開したときに
   その並び自体が氏名・勤務先の漏洩になる（見張りが漏らしては意味がない）。 */
const found = require("./lib/leaks").find(out);
if (found.length) {
  console.error("個人情報らしき文字列が含まれています: " + found.join(", "));
  process.exit(1);
}
const ext = [...out.matchAll(/<(?:script|link|img|iframe|source)[^>]*\b(?:src|href)="(?!data:|#)([^"]+)"/gi)];
if (ext.length) {
  console.error("外部から読み込むリソースがあります: " + ext.map((m) => m[1]).join(", "));
  process.exit(1);
}

fs.mkdirSync(SITE, { recursive: true });
fs.writeFileSync(OUT, out);
/* 配る用は index.html 1つだけにする。publish/ をそのままドラッグすると
   .git やビルド用スクリプトまでアップロードされてしまう。 */
fs.writeFileSync(path.join(SITE, "index.html"), out);

console.log(`できました: ${path.relative(ROOT, OUT)}`);
console.log(`  配る用          : publish/site/（index.html だけ）`);
console.log(`  元にしたファイル : ${path.relative(ROOT, SRC)}${had ? "（前のアドオンは剥がした）" : ""}`);
console.log(`  本体 ${src.length.toLocaleString()}文字 ＋ アドオン ${addon.length.toLocaleString()}文字` +
  ` = ${out.length.toLocaleString()}文字`);
console.log("  外部リソース 0件 ／ 個人情報 なし");
