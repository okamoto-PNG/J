/**
 * Artifact（claude.ai の公開ページ）用のHTMLを作る。
 *
 *   node tools/artifact.js           … artifact.html を作る
 *   node tools/artifact.js <出力先>   … 置き場所を指定する
 *
 * Artifact は公開時に <!doctype html><head>…</head><body> を自動で付ける仕組みなので、
 * 本体（節別予想.html）から外枠を外し、<title> と <body> の中身だけを渡す。
 *
 * publish/index.html（Netlify・GitHub Pages 用）とは別物です。
 * あちらは Wikipedia から結果を自動取得するアドオンが入っていますが、
 * Artifact は外部通信が全面禁止（CSP）なので、入れても動きません。だから付けません。
 *
 * リーグが増えたときに、このスクリプトを直す必要はありません。
 * 本体の LEAGUES を読んで表題を組み直すので、J3 を足せばタイトルも追いつきます。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "節別予想.html");
const OUT = path.resolve(process.cwd(), process.argv[2] ?? path.join(ROOT, "artifact.html"));

const die = (msg) => { console.error("✗ " + msg); process.exit(1); };

const src = fs.readFileSync(SRC, "utf8");

/* ------------------------------------------------------------ 外枠を外す */

const titleM = src.match(/<title>([^<]*)<\/title>/);
const bodyM = src.match(/<body[^>]*>([\s\S]*)<\/body>/i);
if (!titleM) die("<title> が見つかりません: " + SRC);
if (!bodyM) die("<body>…</body> が見つかりません: " + SRC);

/** 収録リーグから表題を組み直す（"J1 節別予想 2026-27" → "J1・J2 節別予想 2026-27"） */
function retitle(original) {
  const block = src.match(/const LEAGUES = \{[\s\S]*?\n\};/);
  if (!block) return original;
  const labels = [...block[0].matchAll(/^\s+label: "([^"]+)"/gm)].map((m) => m[1]);
  if (!labels.length) return original;
  const rest = original.replace(/^\S*\s*/, "");   // 先頭のリーグ名だけ差し替える
  return `${labels.join("・")} ${rest}`.trim();
}

const title = retitle(titleM[1]);
const out = `<title>${title}</title>\n` + bodyM[1].trim() + "\n";

/* ------------------------------------------------------------ 公開して問題ない中身か */

/* 1) 外枠が残っていないか（残ると公開時に二重になる） */
for (const tag of ["<!DOCTYPE", "<html", "<head", "<body", "</html>"]) {
  if (out.includes(tag)) die(`外枠が残っています: ${tag}`);
}

/* 2) 個人情報の混入（publish/build.js と同じ検査） */
/* 検出語は tools/lib/leaks.js（自分固有の語は data/leak-words.txt。.gitignore 済み）。
   ここに並べるとリポジトリを公開したときにその並び自体が漏洩になる。 */
const leaks = require("./lib/leaks").patterns();
const found = leaks.filter((r) => r.test(out));
if (found.length) die("個人情報らしき文字列が含まれています: " + found.join(", "));

/* 3) 外部リソース。Artifact は CSP で外部ホストへの通信を全部止めるので、
      1件でもあると公開先で読み込みが失敗する（data: と #アンカーは自前なので可）。 */
const ext = [...out.matchAll(/<(?:script|link|img|iframe|source)[^>]*\b(?:src|href)="(?!data:|#)([^"]+)"/gi)];
if (ext.length) die("外部から読み込むリソースがあります: " + ext.map((m) => m[1]).join(", "));

/* 4) 中身のJSが壊れていないか。別のセッションが本体を書きかけている最中に
      読んでしまった場合は、ここで構文エラーとして止まる。 */
const scripts = [...out.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) die("<script> が見つかりません（本体の構造が変わった？）");
for (const [i, s] of scripts.entries()) {
  try { new vm.Script(s[1]); }
  catch (e) { die(`${i + 1}個目の <script> が構文エラーです（本体が書きかけかも）: ${e.message}`); }
}

/* ------------------------------------------------------------ 書き出す */

fs.writeFileSync(OUT, out);
const rel = (p) => path.relative(process.cwd(), p) || p;
console.log(`できました: ${rel(OUT)}`);
console.log(`  元にしたファイル : ${rel(SRC)}`);
console.log(`  表題             : ${title}${title === titleM[1] ? "" : `（元は「${titleM[1]}」）`}`);
console.log(`  大きさ           : ${(out.length / 1024).toFixed(0)}KB（本体から ${((src.length - out.length) / 1024).toFixed(0)}KB ぶんの外枠を外した）`);
console.log(`  外部リソース 0件 ／ 個人情報 なし ／ JS 構文OK`);
console.log(`\nこのファイルを Artifact に上げ直せば、同じURLのまま中身が新しくなります。`);
