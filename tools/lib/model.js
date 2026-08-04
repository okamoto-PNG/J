/**
 * 予測モデル本体（アプリの HTML に埋め込んである式と同一）。
 *
 * ここを唯一の実装とし、キャリブレーションもバックテストもこれを呼ぶ。
 * アプリ側の定数がこのモジュールの前提とズレていないかは verify.js が突き合わせる。
 */
"use strict";

/** 既定パラメータ。data/params.json があればそれで上書きして使う */
const DEFAULT_P = {
  HALF_LIFE: 6,
  SHRINK: 28,
  RHO: 0,
  H2H_K: 24,
  H2H_CAP: 0.25,
  CUR_W: 1.5,
};

/** promoted.json が無いとき（初回）のフォールバック。正は data/promoted.json */
const DEFAULT_PROMOTED = { atkH: 0.8820, defH: 1.1013, atkA: 0.8495, defA: 1.0389 };

const fact = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact(k);

/**
 * 履歴の無いクラブを寄せる先を決める。
 * prior が { byClub: {...}, default: {...} } なら、クラブ個別の値を優先する。
 * ふつうの4値オブジェクトを渡せば全クラブ共通（従来どおり）。
 */
function priorFor(prior, club) {
  if (prior && prior.byClub) return prior.byClub[club] ?? prior.default;
  return prior;
}

/**
 * 攻撃力・守備力を推定する。
 *
 * @param past    学習に使う過去試合（{s,h,a,hg,ag}）
 * @param cur     今季の消化済み試合。重み CUR_W で足す
 * @param season  「今季」の年。時間減衰の基準
 * @param P       パラメータ
 * @param prior   履歴が無いクラブを寄せる先（昇格クラブの平均像など）
 * @param hasHistory  履歴ありと見なすクラブの集合
 */
function fitRatings(past, cur, season, P, prior, hasHistory) {
  const T = {};
  const t = (k) => (T[k] ??= { hGF: 0, hGA: 0, hN: 0, aGF: 0, aGA: 0, aN: 0 });
  let tHG = 0, tAG = 0, tN = 0;
  const add = (m, w) => {
    const H = t(m.h), A = t(m.a);
    H.hGF += w * m.hg; H.hGA += w * m.ag; H.hN += w;
    A.aGF += w * m.ag; A.aGA += w * m.hg; A.aN += w;
    tHG += w * m.hg; tAG += w * m.ag; tN += w;
  };
  for (const m of past) add(m, Math.pow(0.5, (season - m.s) / P.HALF_LIFE));
  for (const m of cur) add(m, P.CUR_W);

  const lgH = tHG / tN, lgA = tAG / tN;
  const R = {}, K = P.SHRINK;
  for (const [k, v] of Object.entries(T)) {
    const pr = hasHistory.has(k) ? { atkH: 1, defH: 1, atkA: 1, defA: 1 } : priorFor(prior, k);
    R[k] = {
      atkH: ((v.hGF + K * lgH * pr.atkH) / (v.hN + K)) / lgH,
      defH: ((v.hGA + K * lgA * pr.defH) / (v.hN + K)) / lgA,
      atkA: ((v.aGF + K * lgA * pr.atkA) / (v.aN + K)) / lgA,
      defA: ((v.aGA + K * lgH * pr.defA) / (v.aN + K)) / lgH,
      promoted: !hasHistory.has(k),
    };
  }
  return { R, lgH, lgA, past, cur, season, P, prior };
}

const ratingOf = (fit, t) => fit.R[t] ?? { ...priorFor(fit.prior, t), promoted: true };

/** 過去の直接対決から「相性」を出す */
function h2hFactor(fit, home, away) {
  const P = fit.P;
  let actH = 0, actA = 0, expH = 0, expA = 0, n = 0;
  const scan = (m, w) => {
    const same = m.h === home && m.a === away;
    const rev = m.h === away && m.a === home;
    if (!same && !rev) return;
    const rh = ratingOf(fit, m.h), ra = ratingOf(fit, m.a);
    const eh = fit.lgH * rh.atkH * ra.defA, ea = fit.lgA * ra.atkA * rh.defH;
    if (same) { actH += w * m.hg; actA += w * m.ag; expH += w * eh; expA += w * ea; }
    else      { actH += w * m.ag; actA += w * m.hg; expH += w * ea; expA += w * eh; }
    n += w;
  };
  for (const m of fit.past) scan(m, Math.pow(0.5, (fit.season - m.s) / 4));
  for (const m of fit.cur) scan(m, 1);
  if (n === 0 || expH <= 0 || expA <= 0) return { fh: 1, fa: 1, n: 0 };
  const clamp = (r) =>
    Math.min(1 + P.H2H_CAP, Math.max(1 - P.H2H_CAP, 1 + (r - 1) * (n / (n + P.H2H_K))));
  return { fh: clamp(actH / expH), fa: clamp(actA / expA), n };
}

/** 期待得点 λ から スコア確率行列と勝分敗 */
function outcome(lh, la, rho = 0, max = 9) {
  const tau = (x, y) => {
    if (x === 0 && y === 0) return 1 - lh * la * rho;
    if (x === 0 && y === 1) return 1 + lh * rho;
    if (x === 1 && y === 0) return 1 + la * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1;
  };
  const grid = []; let sum = 0;
  for (let i = 0; i <= max; i++) {
    grid[i] = [];
    for (let j = 0; j <= max; j++) {
      const p = Math.max(0, pois(i, lh) * pois(j, la) * tau(i, j));
      grid[i][j] = p; sum += p;
    }
  }
  let hw = 0, dr = 0, aw = 0;
  for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) {
    grid[i][j] /= sum;
    if (i > j) hw += grid[i][j]; else if (i === j) dr += grid[i][j]; else aw += grid[i][j];
  }
  return { grid, hw, dr, aw };
}

/** 素の期待得点（相性まで。疲労補正は呼び出し側で掛ける） */
function baseLambda(fit, home, away) {
  const rh = ratingOf(fit, home), ra = ratingOf(fit, away);
  const h2h = h2hFactor(fit, home, away);
  return {
    lh: fit.lgH * rh.atkH * ra.defA * h2h.fh,
    la: fit.lgA * ra.atkA * rh.defH * h2h.fa,
    rh, ra, h2h,
  };
}

module.exports = { DEFAULT_P, DEFAULT_PROMOTED, pois, priorFor, fitRatings, ratingOf, h2hFactor, outcome, baseLambda };
