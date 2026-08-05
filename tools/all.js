/**
 * データ層を最初から作り直す。
 *
 *   node tools/all.js            … キャッシュを使って再構築（数十秒）
 *   node tools/all.js --refetch  … 公式サイトから取り直す（数分・36リクエスト）
 *
 * 迷ったらこれを実行してください。最後に検算まで通ります。
 * 途中で失敗したらそこで止まります（終了コード 1）。
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ROOT = path.join(HERE, "..");
const PUB = path.join(ROOT, "publish");
const refetch = process.argv.includes("--refetch");

const steps = [
  { name: "取得", script: "fetch.js", args: refetch ? ["--force"] : [] },
  { name: "パース", script: "parse.js" },
  /* ★ここの順序には理由がある。
     パラメータ（params.json）と事前分布（promoted.json / calib-j3.json）は互いを必要とする。
       tune.js          … 事前分布を使ってパラメータを決める
       calibrate-*.js   … パラメータを使って事前分布を決める
     そこで「暫定のパラメータで事前分布を決め → そのパラメータをもう一度測り直す」の2周にする。
     1周だけだと params.json に記録した精度が、あとで書き換わった事前分布では再現しなくなる。
     実際、来季を模擬したときに verify の「精度が再現する」が落ちてそれが分かった。 */
  { name: "パラメータ決定（J1・1周目）", script: "tune.js" },
  { name: "昇格クラブの実測", script: "calibrate-promoted.js" },
  { name: "J3→J2 新顔の実測", script: "calibrate-j3.js" },
  { name: "パラメータ決定（J1・確定）", script: "tune.js", label: "tools/tune.js（2周目）" },
  { name: "パラメータ決定（J2）", script: "tune-j2.js" },
  { name: "日程補正の実測", script: "calibrate-schedule.js" },
  { name: "会場・曜日の実測", script: "calibrate-venue.js" },
  { name: "HTMLへ反映", script: "build.js" },
  /* 公開版は「本体＋アドオン」なので、本体を作り直したらここも通す。
     ★以前は publish/build.js を引数つきで呼んでいた。引数を忘れると自分自身を元に
     組み直してしまい、公開版だけ古いモデルで残る事故が実際に起きた。
     いまは tools/publish.js が既定で本体（節別予想.html）を読むので、引数を忘れても壊れない。
     verify.js の7章が本体との食い違いを検出する。 */
  { name: "公開版へ反映", script: "publish.js" },
  { name: "検算", script: "verify.js", show: true },
];

const started = process.hrtime.bigint();
for (const [i, s] of steps.entries()) {
  const dir = s.dir ?? HERE;
  const head = `[${i + 1}/${steps.length}] ${s.name}（${s.label ?? `tools/${s.script}`}）`;
  console.log(`\n${"=".repeat(70)}\n${head}\n${"=".repeat(70)}`);
  try {
    const out = execFileSync(process.execPath, [path.join(dir, s.script), ...(s.args ?? [])], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: dir,
    });
    // 長い出力は末尾だけ見せる（検算だけは全部見せる）
    const lines = out.trimEnd().split("\n");
    console.log(s.show || lines.length <= 20 ? out.trimEnd() : lines.slice(-14).join("\n"));
  } catch (e) {
    console.log(e.stdout ?? "");
    console.error(e.stderr ?? "");
    console.error(`\n✗ ${s.name} で失敗しました。ここで止めます。`);
    process.exit(1);
  }
}
const sec = Number(process.hrtime.bigint() - started) / 1e9;
console.log(`\n${"=".repeat(70)}\n完了（${sec.toFixed(1)}秒）。data/README.md も合わせて確認してください。`);
