/**
 * data/*.json を読み込んで、集計しやすい形にして渡すだけのモジュール。
 * ここに「モデル」は書かない（model.js の役目）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "..", "data");

const load = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));

/** 日付文字列 "2025-02-14" → 1970-01-01 からの日数（時差の影響を受けない整数） */
function dayNum(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** 日数差 → 「中N日」表記の N（土曜→翌土曜=7日差=中6日） */
const nakaDays = (gap) => gap - 1;

/**
 * 「あるクラブが、あるシーズンに戦った公式戦」を日付順に並べた索引を作る。
 * 中N日を出すには、リーグ戦だけでなくカップ戦も混ぜる必要がある。
 */
function buildAppearances(datasets) {
  const idx = new Map(); // `${club}|${season}` → [{ day, comp, kind }]
  const push = (club, season, day, comp, kind) => {
    if (day == null) return;
    const k = `${club}|${season}`;
    (idx.get(k) ?? idx.set(k, []).get(k)).push({ day, comp, kind });
  };
  for (const { rows, kind } of datasets) {
    for (const m of rows) {
      const day = dayNum(m.date);
      push(m.h, m.s, day, m.comp, kind);
      push(m.a, m.s, day, m.comp, kind);
    }
  }
  for (const arr of idx.values()) arr.sort((x, y) => x.day - y.day);
  return idx;
}

/**
 * 直前の公式戦を探す。
 * 同日開催（ダブルヘッダーは無いが、データ不備で同日が入ることはある）は無視する。
 */
function previousMatch(idx, club, season, day) {
  const arr = idx.get(`${club}|${season}`);
  if (!arr) return null;
  let best = null;
  for (const a of arr) {
    if (a.day >= day) break;
    best = a;
  }
  return best;
}

module.exports = { DATA, load, dayNum, nakaDays, buildAppearances, previousMatch };
