/**
 * 時系列バックテストの本体。リーグに依存しない。
 *
 * 「その試合の前日までに終わっている試合だけで学習して予測する」を
 * 全試合について繰り返し、log loss と的中率を出す。
 *
 * J1 用の入口は tools/backtest.js、J2 用は tools/backtest-j2.js。
 * どちらも同じこの実装を呼ぶので、リーグ間で条件が揃う。
 */
"use strict";

const { dayNum } = require("./data");
const M = require("./model");

/**
 * @param matches   対象リーグの過去試合（結果つき）
 * @param cup       同じクラブが出る別大会（休養日数の計算に混ぜる。無ければ []）
 * @param prior     履歴が無いクラブを寄せる先
 * @param firstEval 採点を始めるシーズン
 */
function make({ matches, cup = [], prior, firstEval }) {
  /* ★ .day を必ず上書きすること。
     parse.js が書き出す JSON の day は「第N節第N日」の N（1〜6）で、日付ではない。
     ここで日付通番（1970-01-01 からの日数）に置き換えて使う。
     「既にあるなら残す」と書くと 1 や 2 のまま残り、日付順の並べ替えと
     「その試合より前」の判定が静かに壊れる（実際に一度そうなった）。 */
  for (const m of [...matches, ...cup]) m.day = dayNum(m.date);
  const ALL = matches.filter((m) => m.day != null && m.hg != null).sort((a, b) => a.day - b.day);
  const SEASONS = [...new Set(ALL.map((m) => m.s))].sort();

  /* --- 休養日数の索引（事前計算） --- */
  const APPEAR = new Map();
  for (const m of [...ALL, ...cup.filter((x) => x.day != null)]) {
    for (const c of [m.h, m.a]) {
      const k = `${c}|${m.s}`;
      (APPEAR.get(k) ?? APPEAR.set(k, []).get(k)).push(m.day);
    }
  }
  for (const a of APPEAR.values()) a.sort((x, y) => x - y);

  /** 直前の公式戦からの日数（無ければ null）。二分探索 */
  function gapBefore(club, season, day) {
    const a = APPEAR.get(`${club}|${season}`);
    if (!a) return null;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < day) lo = mid + 1; else hi = mid; }
    return lo === 0 ? null : day - a[lo - 1];
  }

  /* --- h2h を速くするため、カード（順不同ペア）ごとに索引 --- */
  const PAIR = new Map();
  const pairKey = (x, y) => (x < y ? x + " " + y : y + " " + x);
  for (const m of ALL) {
    const k = pairKey(m.h, m.a);
    (PAIR.get(k) ?? PAIR.set(k, []).get(k)).push(m);
  }

  /* --- 疲労補正のモデル（θ=0 なら何も起きない） --- */
  const FULL_REST = 7, MIN_REST = 3;
  function fatigue(gap, theta) {
    if (theta === 0 || gap == null) return 1;
    const short = Math.min(FULL_REST, Math.max(MIN_REST, gap));
    return 1 - theta * (FULL_REST - short) / (FULL_REST - MIN_REST);
  }

  /** h2h を PAIR 索引で速く計算し、素の λ を返す（当該日より前の試合だけ見る） */
  function h2hFast(fit, home, away, day) {
    const P = fit.P;
    const rh = M.ratingOf(fit, home), ra = M.ratingOf(fit, away);
    const baseH = fit.lgH * rh.atkH * ra.defA;
    const baseA = fit.lgA * ra.atkA * rh.defH;
    const list = PAIR.get(pairKey(home, away)) ?? [];
    let actH = 0, actA = 0, expH = 0, expA = 0, n = 0;
    for (const m of list) {
      if (m.day >= day) continue;                       // 未来を使わない
      const w = m.s < fit.season ? Math.pow(0.5, (fit.season - m.s) / 4) : 1;
      const mh = M.ratingOf(fit, m.h), ma = M.ratingOf(fit, m.a);
      const eh = fit.lgH * mh.atkH * ma.defA, ea = fit.lgA * ma.atkA * mh.defH;
      if (m.h === home) { actH += w*m.hg; actA += w*m.ag; expH += w*eh; expA += w*ea; }
      else              { actH += w*m.ag; actA += w*m.hg; expH += w*ea; expA += w*eh; }
      n += w;
    }
    if (n === 0 || expH <= 0 || expA <= 0) return { lh: baseH, la: baseA };
    const clamp = (r) =>
      Math.min(1 + P.H2H_CAP, Math.max(1 - P.H2H_CAP, 1 + (r - 1) * (n / (n + P.H2H_K))));
    return { lh: baseH * clamp(actH / expH), la: baseA * clamp(actA / expA) };
  }

  /**
   * 日付順に予測し、log loss と的中率を返す。
   * @param P      モデルパラメータ
   * @param theta  疲労の効き幅（0で補正なし）
   * @param sym    true なら「両チームの得点を一律に下げる」対称モデルにする
   * @param pr     履歴が無いクラブを寄せる先。既定はコンストラクタで渡した prior
   * @param range  評価するシーズンの範囲 [開始, 終了]。分割検証に使う
   * @param pick   (match, hasHistory) => boolean。true の試合だけを採点対象にする
   * @param tweak  (match) => {h,a}。λ に掛ける試作補正
   */
  function run(P, theta = 0, sym = false, pr = null, range = null, pick = null, tweak = null) {
    const [Y0, Y1] = range ?? [firstEval, 9999];
    let ll = 0, hit = 0, n = 0;
    let llBase = 0, hitBase = 0;   // 「常にホーム有利」の基準率
    const RATE = { h: 0.412, d: 0.250, a: 0.338 };
    const PR = pr ?? prior;

    for (const Y of SEASONS.filter((y) => y >= Y0 && y <= Y1)) {
      const past = ALL.filter((m) => m.s < Y);
      const hasHistory = new Set(past.flatMap((m) => [m.h, m.a]));
      const season = ALL.filter((m) => m.s === Y);
      const days = [...new Set(season.map((m) => m.day))].sort((a, b) => a - b);

      for (const d of days) {
        // その日より前に終わっている今季の試合だけを使って学習する
        const cur = season.filter((m) => m.day < d);
        const fit = M.fitRatings(past, cur, Y, P, PR, hasHistory);

        for (const m of season.filter((x) => x.day === d)) {
          if (pick && !pick(m, hasHistory)) continue;
          const b = h2hFast(fit, m.h, m.a, d);
          let lh = b.lh, la = b.la;

          if (tweak) { const t = tweak(m); lh *= t.h; la *= t.a; }

          if (theta !== 0) {
            const gh = gapBefore(m.h, Y, d), ga = gapBefore(m.a, Y, d);
            const fh = fatigue(gh, theta), fa = fatigue(ga, theta);
            if (sym) { lh *= fh * fa; la *= fh * fa; }
            else     { lh *= fh * (2 - fa); la *= fa * (2 - fh); }
          }

          const o = M.outcome(lh, la, P.RHO);
          const p = m.hg > m.ag ? o.hw : m.hg === m.ag ? o.dr : o.aw;
          ll += -Math.log(Math.max(p, 1e-12));
          const top = o.hw >= o.dr && o.hw >= o.aw ? "h" : o.dr >= o.aw ? "d" : "a";
          const act = m.hg > m.ag ? "h" : m.hg === m.ag ? "d" : "a";
          if (top === act) hit++;
          llBase += -Math.log(RATE[act]);
          if (act === "h") hitBase++;
          n++;
        }
      }
    }
    return { n, ll: ll / n, hit: hit / n, llBase: llBase / n, hitBase: hitBase / n };
  }

  return { run, matches: ALL, SEASONS, gapBefore, firstEval };
}

module.exports = { make };
