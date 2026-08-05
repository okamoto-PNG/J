/**
 * 自動更新。スケジューラから定期的に呼ばれることを前提にしている。
 *
 *   node tools/auto.js            … 必要なら更新する（ふだんはこれ）
 *   node tools/auto.js --dry      … 判定だけして何も書き換えない
 *   node tools/auto.js --force    … 判定を飛ばして必ずフル更新する（全年を取り直す）
 *   node tools/auto.js --rebuild  … 取得せずキャッシュから作り直すだけ
 *
 * やること
 *   1) 来季の日程が出たか、1リクエストだけ見る
 *   2) 今季ぶんを取り直す（K/O時刻が発表されると予想の締切が正確になる）
 *   3) 生HTMLが変わっていたらパイプラインを回す
 *   4) 検算が落ちたら**すべて元に戻す**
 *
 * ★4 が重要。無人で動くので、失敗した中途半端な状態を残すと
 * 次に開いたとき何が正しいのか分からなくなる。落ちたら触る前の状態に戻し、
 * 記録だけ残して終わる。
 *
 * 毎週48本取るのは相手のサーバに失礼なので、ふだんは数本で済ませる。
 * 来季が現れたときだけ全年を取り直す（学習と予想の境界が動くため）。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const ROOT = path.join(HERE, "..");
const DATA = path.join(ROOT, "data");
const RAW = path.join(DATA, "raw");
const PUB = path.join(ROOT, "publish");
/* ★退避先はプロジェクトの外（OSの一時領域）に置く。理由が2つある。
   ・この環境では OneDrive 配下で fs.rmSync(recursive) が異常終了する（cpSync も同じ）
   ・退避コピーを OneDrive に置くと、毎回クラウドへ同期されて無駄が大きい

   ★名前にプロジェクトの場所を混ぜる。同じPCに複数のチェックアウト（本物とクローン）が
   あると、固定名では互いの退避を消し合い、いざ復元するときに何も戻せない。
   実際 CI を模擬したときに「0ファイルを元に戻した」となって気づいた。 */
const projectId = crypto.createHash("sha1").update(path.resolve(ROOT)).digest("hex").slice(0, 8);
const BACKUP = path.join(os.tmpdir(), `jleague-autobackup-${projectId}`);
const LOG = path.join(DATA, "auto-log.txt");

const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
const REBUILD = process.argv.includes("--rebuild");

/* 時刻はログに残すだけ。判定には使わない（判定はデータの中身で決める） */
const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
const lines = [];
function say(s) {
  console.log(s);
  lines.push(s);
}
function finish(code) {
  /* ログは追記。増えすぎたら古い方から捨てる（無人運転なので放置される前提） */
  let old = "";
  try { old = fs.readFileSync(LOG, "utf8"); } catch { /* 初回 */ }
  const entry = `───── ${stamp} ─────\n${lines.join("\n")}\n`;
  let all = old + entry;
  if (all.length > 200 * 1024) all = all.slice(all.length - 150 * 1024);
  try { fs.writeFileSync(LOG, all); } catch { /* 書けなくても本体は続ける */ }
  process.exit(code);
}

/**
 * 中身が変わったかを見るための指紋。
 *
 * ★生HTMLのハッシュではなく「パースした結果」のハッシュを取る。
 * 公式サイトのHTMLには毎回変わる部分（セッションらしき値など）が含まれていて、
 * 生のまま比べると中身が同じでも「変わった」と判定してしまう。
 * 実際それで毎週19ファイルを書き換えて OneDrive を同期させていた。
 * 見たいのは「日程・K/O時刻・結果が変わったか」だけなので、そこだけを比べる。
 *
 * @param years 見る年（省略すると raw/ 全部）
 */
function dataFingerprint(years) {
  const { parseHtml } = require("./parse");
  const out = {};
  if (!fs.existsSync(RAW)) return out;
  for (const f of fs.readdirSync(RAW).sort()) {
    if (!f.endsWith(".html")) continue;
    if (years && !years.some((y) => f.endsWith(`-${y}.html`))) continue;
    try {
      const rows = parseHtml(fs.readFileSync(path.join(RAW, f), "utf8"));
      /* 比べるのは試合の中身だけ。並び順の揺れを拾わないよう並べ替えてから畳む */
      const key = rows
        .map((m) => [m.s, m.round, m.date, m.ko, m.h, m.a, m.hg, m.ag, m.venue].join("|"))
        .sort().join("\n");
      out[f] = crypto.createHash("sha1").update(key).digest("hex");
    } catch {
      out[f] = "parse-error";
    }
  }
  return out;
}

function run(script, args = [], cwd = ROOT, dir = HERE) {
  return execFileSync(process.execPath, [path.join(dir, script), ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd });
}

/* ------------------------------------------------------------ 生成物の退避と復元 */

/**
 * パイプラインが書き換えるファイルを控えておく。
 * data/raw は控えない（取り直せるし、大きい）。
 */
function generatedFiles() {
  const list = [];
  for (const f of fs.readdirSync(DATA)) if (f.endsWith(".json")) list.push(path.join(DATA, f));
  for (const f of ["index.html", "節別予想.html"]) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) list.push(p);
  }
  for (const rel of ["index.html", path.join("site", "index.html")]) {
    const p = path.join(PUB, rel);
    if (fs.existsSync(p)) list.push(p);
  }
  return list;
}
const backupName = (p) => path.relative(ROOT, p).replace(/[\\/]/g, "__");

/** 再帰削除は使わず、中のファイルを1つずつ消す（recursive は異常終了する） */
function clearBackup() {
  if (!fs.existsSync(BACKUP)) return;
  for (const f of fs.readdirSync(BACKUP)) {
    try { fs.unlinkSync(path.join(BACKUP, f)); } catch { /* 読めないものは放置 */ }
  }
}

function backup() {
  clearBackup();
  fs.mkdirSync(BACKUP, { recursive: true });
  const kept = [];
  for (const p of generatedFiles()) {
    fs.copyFileSync(p, path.join(BACKUP, backupName(p)));
    kept.push(path.relative(ROOT, p));
  }
  fs.writeFileSync(path.join(BACKUP, "_list.json"), JSON.stringify(kept, null, 1));
  return kept.length;
}
function restore() {
  const listFile = path.join(BACKUP, "_list.json");
  if (!fs.existsSync(listFile)) return 0;
  const kept = JSON.parse(fs.readFileSync(listFile, "utf8"));
  let n = 0;
  /* 退避後に新しく生まれたファイル（例：新しい年の j1-2027.json）は消す。
     残すと「古い年と新しい年が両方ある」状態になり、どちらが正か分からなくなる。 */
  const wanted = new Set(kept);
  for (const f of fs.readdirSync(DATA)) {
    if (/^(j1|j2|j3)-\d{4}\.json$/.test(f) && !wanted.has(path.join("data", f))) {
      fs.unlinkSync(path.join(DATA, f)); n++;
    }
  }
  for (const rel of kept) {
    const src = path.join(BACKUP, rel.replace(/[\\/]/g, "__"));
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(ROOT, rel)); n++; }
  }
  return n;
}

/* verify.js が「安全網が本当に働くか」を確かめられるように外へ出す。
   スケジューラから呼ばれたときだけ下の本体が動く（require されたときは何もしない）。 */
module.exports = { backup, restore, generatedFiles, clearBackup, BACKUP };
if (require.main !== module) return;

/* ------------------------------------------------------------ 判定 */

let S = null;
try { S = JSON.parse(fs.readFileSync(path.join(DATA, "season.json"), "utf8")); }
catch { /* 初回。フル更新に落とす */ }

/* 指紋は今季ぶんだけ見る（来季の有無はファイルの存在で分かる） */
let before = null;
let mode = null, reason = "";

if (REBUILD) {
  mode = "refresh";
  reason = "--rebuild が指定された（取得はしない）";
  say(`判定: ${reason}`);
} else if (FORCE) {
  mode = "full";
  reason = "--force が指定された";
  say(`判定: ${reason} → 全年を取り直す`);
} else if (!S) {
  mode = "full";
  reason = "data/season.json が無い（初回）";
  say(`判定: ${reason} → フル更新`);
} else {
  const next = S.upcoming + 1;
  say(`いまの境界: 学習 ${S.first}-${S.histEnd} / 予想対象 ${S.label}`);

  if (DRY) {
    say(`（--dry）来季 ${next} の有無と今季の更新を見るところまで`);
  }

  /* 1) 来季の日程が出ているか。J1 を1本だけ見る */
  const nextFile = path.join(RAW, `j1-${next}.html`);
  const hadNext = fs.existsSync(nextFile);
  try {
    run("fetch.js", ["--years=" + next]);
  } catch (e) {
    /* 公式サイトは取得が集中するとしばらく 503 を返す。障害と区別できないので、
       どちらでも「今回は何もせず次回に持ち越す」。無人運転では触らない方が安全。 */
    say("⚠ 取得できなかった（レート制限か一時的な障害）。今回は何もせず次回に持ち越す");
    finish(0);
  }
  const hasNext = fs.existsSync(nextFile);

  if (hasNext && !hadNext) {
    mode = "full";
    reason = `${next} シーズンの日程が公開された`;
    say(`✔ ${reason} → 全年を取り直してシーズンを進める`);
  } else {
    /* 2) 今季ぶんを取り直す。K/O時刻が発表されると予想の締切が正確になる */
    if (DRY) {
      say("（--dry）今季の取り直しはしない");
      say(hasNext ? "来季はすでに取得済み" : `来季 ${next} はまだ日程が出ていない`);
      finish(0);
    }
    before = dataFingerprint([S.upcoming]);   // 取り直す前の中身を覚えておく
    try {
      run("fetch.js", ["--force", "--years=" + S.upcoming]);
    } catch (e) {
      say("⚠ 今季の取得ができなかった。今回は何もせず次回に持ち越す");
      finish(0);
    }
    const after = dataFingerprint([S.upcoming]);
    const changed = Object.keys({ ...before, ...after })
      .filter((f) => before[f] !== after[f]);
    if (!changed.length) {
      say("変化なし（日程・K/O時刻・結果とも同じ）。何もしない");
      finish(0);
    }
    mode = "refresh";
    reason = `今季の生データが更新された（${changed.join(", ")}）`;
    say(`✔ ${reason} → 取り直しはせず作り直す`);
  }
}

if (DRY) { say("（--dry）ここで終了"); finish(0); }

/* ------------------------------------------------------------ 実行 */

const kept = backup();
say(`退避 ${kept}ファイル → data/.autobackup/`);

const steps = mode === "refresh"
  ? [["all.js", []]]                       // 取得は済んでいるので all.js の fetch はキャッシュを使う
  : [["all.js", ["--refetch"]]];

let ok = true, out = "";
for (const [script, args] of steps) {
  try {
    out = run(script, args);
  } catch (e) {
    ok = false;
    out = (e.stdout ?? "") + "\n" + (e.stderr ?? "");
    break;
  }
}

const summary = out.split("\n").filter((l) =>
  /シーズン境界|項目 合格|件 合格|❌|✗|完了（/.test(l)).map((l) => "  " + l.trim());
say(summary.join("\n") || "  （出力なし）");

if (!ok) {
  const n = restore();
  say(`❌ 失敗したので ${n}ファイルを元に戻した。データは触る前の状態です`);
  say("   原因を確かめてから node tools/all.js --refetch を手で実行してください");
  finish(1);
}

/* 検算まで通ったので退避は捨てる（残すと次回の判定を惑わせる） */
clearBackup();

let after = null;
try { after = JSON.parse(fs.readFileSync(path.join(DATA, "season.json"), "utf8")); } catch { /* まず無い */ }
if (after && S && after.upcoming !== S.upcoming) {
  say(`🎉 シーズンが進みました: ${S.label} → ${after.label}`);
  say(`   学習 ${after.first}-${after.histEnd} / 学習区間 ${after.train.join("-")} / 検証区間 ${after.test.join("-")}`);
  say("   publish/site/ を Netlify に置き直すと公開版も新シーズンになります");
} else {
  say(`✅ 更新しました（${reason}）`);
}
finish(0);
