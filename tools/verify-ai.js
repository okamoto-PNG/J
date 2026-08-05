/**
 * ai-yosou.js の集計部分の検算。
 *
 *   node tools/verify-ai.js
 *
 * APIは一切呼ばない。「モデルに渡す数字が正しいか」だけを確かめる。
 * 予想の当たり外れは検算できないが、材料の間違いは検算できる。
 *
 * シーズン序盤は今季の消化試合が0件なので、そこだけ通しても
 * 順位表・直近成績のコードは一度も動かない。
 * そのため 2025 シーズンを「今季」に見立てて途中まで切り、
 * シーズン中の経路も通す。
 */
"use strict";

const { table, rankOf, recent, split, h2h, prevSeason, context, prompt, normalize } =
  require("./ai-yosou.js");
const { load, dayNum } = require("./lib/data.js");

let ok = 0, ng = 0;

function check(label, cond, detail = "") {
  if (cond) { ok++; return; }
  ng++;
  console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`);
}

function section(name) {
  console.log(`\n${name}`);
}

const hist = load("j1-matches.json");
const j2 = load("j2-matches.json");
const fixtures = load(require("./lib/season").require().files.J1);
const ylc = load("ylc-matches.json");

const y2025 = hist.filter((m) => m.s === 2025);

/* ------------------------------------------------------- 1. 順位表 */

section("1. 順位表（2025 J1 の最終順位を再現する）");

const t25 = table(y2025);
check("20クラブある", t25.length === 20, `→ ${t25.length}`);
check("全クラブ38試合", t25.every((r) => r.gp === 38), `→ ${t25.map((r) => r.gp).join(",")}`);
check("勝点 = 勝×3 + 分", t25.every((r) => r.pts === r.w * 3 + r.d));
check("試合数 = 勝+分+敗", t25.every((r) => r.gp === r.w + r.d + r.l));

const gf = t25.reduce((s, r) => s + r.gf, 0);
const ga = t25.reduce((s, r) => s + r.ga, 0);
check("リーグ全体の得点合計 = 失点合計", gf === ga, `→ ${gf} vs ${ga}`);

const draws = t25.reduce((s, r) => s + r.d, 0);
check("引き分け数は偶数（2クラブで1試合）", draws % 2 === 0, `→ ${draws}`);

// 公式記録：2025 J1 は鹿島が1位（勝点76）
const top = t25[0];
check("1位は鹿島", top.club === "鹿島", `→ ${top.club}`);
check("1位の勝点は76", top.pts === 76, `→ ${top.pts}`);
check("rankOf が1位を返す", rankOf(t25, "鹿島") === 1);
check("rankOf は未登場クラブに null", rankOf(t25, "存在しないクラブ") === null);

/* ------------------------------------------- 2. シーズン途中（第10節時点） */

section("2. シーズン途中（2025 を第10節で切って「今季」に見立てる）");

const mid = y2025.filter((m) => m.round <= 10);
const tMid = table(mid);
check("20クラブある", tMid.length === 20, `→ ${tMid.length}`);
check("全クラブ10試合", tMid.every((r) => r.gp === 10), `→ ${[...new Set(tMid.map((r) => r.gp))].join(",")}`);
check("勝点は0〜30", tMid.every((r) => r.pts >= 0 && r.pts <= 30));
check("順位は1〜20", tMid.every((r) => { const k = rankOf(tMid, r.club); return k >= 1 && k <= 20; }));
check("勝点が降順に並ぶ", tMid.every((r, i) => i === 0 || tMid[i - 1].pts >= r.pts));

/* ------------------------------------------------- 3. ホーム/アウェイ別 */

section("3. ホーム/アウェイ別の成績");

for (const r of tMid) {
  const h = split(mid, r.club, true);
  const a = split(mid, r.club, false);
  check(`${r.club}: ホーム+アウェイ = 通算試合数`, h.gp + a.gp === r.gp, `→ ${h.gp}+${a.gp} vs ${r.gp}`);
  check(`${r.club}: ホーム+アウェイ = 通算得点`, h.gf + a.gf === r.gf);
  check(`${r.club}: ホーム+アウェイ = 通算失点`, h.ga + a.ga === r.ga);
}

const allHome = tMid.reduce((s, r) => s + split(mid, r.club, true).gf, 0);
const allAway = tMid.reduce((s, r) => s + split(mid, r.club, false).gf, 0);
check("ホーム得点合計 > アウェイ得点合計（ホーム有利）", allHome > allAway, `→ ${allHome} vs ${allAway}`);

/* ------------------------------------------------------- 4. 直近5試合 */

section("4. 直近5試合");

for (const r of tMid) {
  const rec = recent(mid, r.club, 5);
  check(`${r.club}: 5件以内`, rec.length <= 5, `→ ${rec.length}`);
  check(`${r.club}: 形式が ○/△/● + スコア + H/A`, rec.every((s) => /^[○△●] \d+-\d+ [HA] /.test(s)), `→ ${rec[0]}`);
}

// 新しい順に並んでいるか（日付が単調に古くなる）
const sample = "鹿島";
const rows = mid
  .filter((m) => m.hg != null && (m.h === sample || m.a === sample))
  .sort((x, y) => (dayNum(y.date) ?? 0) - (dayNum(x.date) ?? 0))
  .slice(0, 5);
check("新しい順に並ぶ", rows.every((m, i) => i === 0 || dayNum(rows[i - 1].date) >= dayNum(m.date)));

// ○△● とスコアが矛盾しないか
for (const s of recent(mid, sample, 5)) {
  const [, mark, x, y] = s.match(/^([○△●]) (\d+)-(\d+)/);
  const want = Number(x) > Number(y) ? "○" : Number(x) < Number(y) ? "●" : "△";
  check(`勝敗記号とスコアが一致（${s}）`, mark === want);
}

/* --------------------------------------------------------- 5. 直接対戦 */

section("5. 直接対戦");

const ab = h2h(y2025, "鹿島", "浦和", 8);
const ba = h2h(y2025, "浦和", "鹿島", 8);
check("組み合わせを入れ替えても同じ試合が並ぶ", JSON.stringify(ab) === JSON.stringify(ba), `→ ${ab.length}/${ba.length}`);
check("2025は同一カード2試合", ab.length === 2, `→ ${ab.length}`);
check("形式が 日付 ホーム n-n アウェイ", ab.every((s) => /^\d{4}-\d{2}-\d{2} \S+ \d+-\d+ \S+$/.test(s)), `→ ${ab[0]}`);
check("両クラブ名が入る", ab.every((s) => s.includes("鹿島") && s.includes("浦和")));

const many = h2h(hist, "鹿島", "浦和", 8);
check("上限8件を守る", many.length === 8, `→ ${many.length}`);

/* ------------------------------------------------------- 6. 前季の評価 */

section("6. 前季の立ち位置（昇格クラブは J2 を見る）");

const tPrevJ1 = table(hist.filter((m) => m.s === 2025));
const tPrevJ2 = table(j2.filter((m) => m.s === 2025));

const kashima = prevSeason(tPrevJ1, tPrevJ2, "鹿島");
check("鹿島は J1 として拾える", kashima?.league === "J1", `→ ${kashima?.league}`);
check("鹿島は1位", kashima?.rank === 1, `→ ${kashima?.rank}`);

/* 2026-27 の J1 のうち、前季（2025）は J1 にいなかったクラブ。
   2026-27 は 千葉・水戸・長崎 の3クラブ。うち長崎は2018にJ1在籍歴があるので、
   「J1履歴なし」（水戸・千葉の2クラブ／verify.js 3章）とは別の数になる。
   ここで見たいのは「前季どこにいたか」なので3クラブが正しい。 */
const clubs = load("clubs.json");
const promoted = clubs.J1_2627.filter((c) => !tPrevJ1.some((r) => r.club === c));
const relegated = tPrevJ1.map((r) => r.club).filter((c) => !clubs.J1_2627.includes(c));
check("昇格数と降格数が一致する", promoted.length === relegated.length,
  `→ 昇格 ${promoted.join(",")} / 降格 ${relegated.join(",")}`);
check("昇格クラブが1つ以上いる", promoted.length > 0);
for (const c of promoted) {
  const p = prevSeason(tPrevJ1, tPrevJ2, c);
  check(`${c} は J2 の成績で拾える`, p?.league === "J2", `→ ${p?.league ?? "null"}`);
  check(`${c} の前季順位が入る`, Number.isInteger(p?.rank), `→ ${p?.rank}`);
}

check("どのリーグにもいないクラブは null", prevSeason(tPrevJ1, tPrevJ2, "存在しないクラブ") === null);

/* ------------------------------- 7. context / prompt（シーズン序盤と途中） */

section("7. 材料まとめとプロンプト");

/** 序盤（消化0件）と途中（第10節まで消化）の2通りで通す */
const cases = [
  { name: "序盤（消化0件）", season: fixtures, played: [] },
  {
    name: "途中（第10節まで消化）",
    // 2026-27 の日程に、2025 の第1〜10節の結果を貼り付けた擬似データ
    season: fixtures.map((m, i) => (m.round <= 10 ? { ...m, hg: i % 3, ag: (i + 1) % 3 } : m)),
    played: null, // 下で埋める
  },
];
cases[1].played = cases[1].season.filter((m) => m.hg != null);

for (const c of cases) {
  const d = { hist, j2, season: c.season, ylc, played: c.played };
  const target = c.season.find((m) => m.round === 11) ?? c.season[0];
  let ctx;
  try {
    ctx = context(target, d);
  } catch (e) {
    check(`${c.name}: context が例外を出さない`, false, `→ ${e.message}`);
    continue;
  }
  check(`${c.name}: context が例外を出さない`, true);
  check(`${c.name}: ホーム名が一致`, ctx.home.club === target.h);
  check(`${c.name}: アウェイ名が一致`, ctx.away.club === target.a);
  check(`${c.name}: 順位は null か 1〜20`,
    [ctx.home.rank, ctx.away.rank].every((r) => r === null || (r >= 1 && r <= 20)),
    `→ ${ctx.home.rank}/${ctx.away.rank}`);
  check(`${c.name}: 前季データが両方ある`, ctx.home.prev != null && ctx.away.prev != null);

  const p = prompt(ctx);
  check(`${c.name}: プロンプトに両クラブ名`, p.includes(target.h) && p.includes(target.a));
  check(`${c.name}: プロンプトに基準率`, p.includes("40.7%") && p.includes("25.0%"));
  check(`${c.name}: プロンプトに undefined/NaN が混ざらない`,
    !/undefined|NaN/.test(p), `→ ${(p.match(/.{0,30}(undefined|NaN).{0,30}/) ?? [])[0]}`);
  check(`${c.name}: プロンプトが短すぎない`, p.length > 300, `→ ${p.length}文字`);
}

/* ---------------------------------------------------- 8. 確率の正規化 */

section("8. 確率の正規化");

const n1 = normalize({ home_win: 0.5, draw: 0.25, away_win: 0.25 });
check("合計1ならそのまま", Math.abs(n1.p.home - 0.5) < 1e-9 && Math.abs(n1.sumBefore - 1) < 1e-9);

const n2 = normalize({ home_win: 0.5, draw: 0.3, away_win: 0.4 }); // 合計1.2
check("合計1.2でも正規化後は1", Math.abs(n2.p.home + n2.p.draw + n2.p.away - 1) < 1e-9);
check("ずれの大きさを残す", Math.abs(n2.sumBefore - 1.2) < 1e-9, `→ ${n2.sumBefore}`);
check("比が保たれる", Math.abs(n2.p.home / n2.p.away - 0.5 / 0.4) < 1e-9);

let threw = false;
try { normalize({ home_win: 0, draw: 0, away_win: 0 }); } catch { threw = true; }
check("合計0は例外", threw);

/* -------------------------------------------------------- 9. スキーマ */

section("9. 構造化出力のスキーマ");

check("additionalProperties: false", SCHEMA_CHECK().additionalProperties === false);
check("required が properties と一致",
  JSON.stringify([...SCHEMA_CHECK().required].sort()) ===
  JSON.stringify(Object.keys(SCHEMA_CHECK().properties).sort()));
check("非対応の数値制約を使っていない",
  !/"(minimum|maximum|multipleOf|minLength|maxLength)"/.test(JSON.stringify(SCHEMA_CHECK())));

function SCHEMA_CHECK() {
  return require("./ai-yosou.js").SCHEMA;
}

/* ------------------------------------------------------------- まとめ */

console.log(`\n${"─".repeat(50)}`);
console.log(`${ok + ng}項目中 ${ok}項目 通過 / ${ng}項目 失敗`);
if (ng) {
  console.log("\n失敗があります。上の ✗ を直してください。");
  process.exit(1);
}
console.log("全部通りました。");
