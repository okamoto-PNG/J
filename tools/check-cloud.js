/**
 * クラウド側（GitHub Actions）が動いているかを確かめる。
 *
 *   node tools/check-cloud.js
 *
 * 見るのは3つ。
 *   1) ワークフローが走ったか、緑か  … Actions の実行履歴
 *   2) 自動でコミットされたか        … auto-update[bot] のコミット
 *   3) 公開ページが出ているか        … GitHub Pages のURLを実際に開く
 *
 * Public リポジトリなら認証は不要（GitHub API は未認証で 60回/時 まで）。
 * リモートが未設定なら「まだ push していない」と言って終わる。
 *
 * ★「コミットが無い」＝失敗ではない。
 * データが変わらなかった週は、何もしないのが正しい動作。
 * 判定を間違えないよう、下では実行履歴の結果（conclusion）を主に見ている。
 */
"use strict";

const { execFileSync } = require("child_process");

const UA = "jleague-study/1.0";

/** origin のURLから owner/repo を取り出す */
function repoSlug() {
  let url;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: require("path").join(__dirname, ".."), encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],   // 未設定のときの git のエラー文を出さない
    }).trim();
  } catch { return null; }
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2], url } : null;
}

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return { notFound: true };
  if (res.status === 403) return { rateLimited: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const jst = (iso) => {
  const d = new Date(iso);
  return new Date(d.getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16) + " JST";
};

(async () => {
  const slug = repoSlug();
  if (!slug) {
    console.log("まだ GitHub に push していません（origin が未設定）。");
    console.log("クラウド化手順.md の 1〜4 を先に進めてください。");
    process.exit(0);
  }
  console.log(`リポジトリ: ${slug.owner}/${slug.repo}`);
  console.log(`           ${slug.url}\n`);

  /* --- 1) ワークフローの実行履歴 --- */
  const runs = await api(`/repos/${slug.owner}/${slug.repo}/actions/runs?per_page=10`);
  if (runs.rateLimited) {
    console.log("GitHub API の回数制限に当たりました。しばらく待ってから試してください。");
    process.exit(0);
  }
  if (runs.notFound) {
    console.log("リポジトリが見つかりません（Private か、URLが違うか）。");
    process.exit(1);
  }

  const list = (runs.workflow_runs ?? []);
  console.log("── 1. ワークフローの実行 ──────────────────");
  if (!list.length) {
    console.log("  まだ1回も走っていません。");
    console.log("  → Actions タブ →「自動更新」→ Run workflow で dry を試してください。");
  } else {
    for (const r of list.slice(0, 5)) {
      const mark = r.status !== "completed" ? "⏳ 実行中"
        : r.conclusion === "success" ? "✅ 成功"
        : r.conclusion === "cancelled" ? "⏹ 中止" : "❌ 失敗";
      const how = r.event === "schedule" ? "毎日の自動" : r.event === "workflow_dispatch" ? "手動" : r.event;
      console.log(`  ${mark}  ${jst(r.created_at)}  ${how}`);
    }
    const done = list.filter((r) => r.status === "completed");
    const ok = done.filter((r) => r.conclusion === "success");
    const sched = done.filter((r) => r.event === "schedule");
    console.log(`\n  成功 ${ok.length}/${done.length}件  うち毎日の自動実行 ${sched.length}件`);
    if (done.length && !ok.length) {
      console.log(`  → 失敗の中身: ${list[0].html_url}`);
    }
    if (!sched.length) {
      console.log("  ℹ まだ手動だけです。自動実行は次の 12:00(JST) に初めて走ります。");
    }
  }

  /* --- 2) 自動コミット --- */
  const commits = await api(`/repos/${slug.owner}/${slug.repo}/commits?per_page=10`);
  console.log("\n── 2. 自動コミット ────────────────────────");
  const bots = (commits ?? []).filter((c) =>
    (c.commit?.message ?? "").startsWith("自動更新:") ||
    (c.commit?.author?.name ?? "").includes("auto-update"));
  if (bots.length) {
    for (const c of bots.slice(0, 3)) {
      console.log(`  ✅ ${jst(c.commit.author.date)}  ${c.commit.message.split("\n")[0]}`);
    }
    console.log("\n  手元を最新にするには: git pull");
  } else {
    console.log("  まだありません。");
    console.log("  ℹ これは失敗ではありません。データが変わらなかった週は");
    console.log("    何もしないのが正しい動作です（1 が緑なら健全）。");
  }

  /* --- 3) 公開ページ --- */
  const pagesUrl = `https://${slug.owner.toLowerCase()}.github.io/${slug.repo}/`;
  console.log("\n── 3. 公開ページ ──────────────────────────");
  try {
    const res = await fetch(pagesUrl, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const html = await res.text();
      const season = html.match(/const SEASON = (\d+);/)?.[1];
      console.log(`  ✅ 見られます: ${pagesUrl}`);
      console.log(`     ${(html.length / 1024).toFixed(0)}KB / 予想対象シーズン ${season ?? "不明"}`);
    } else {
      console.log(`  ❌ まだ出ていません（HTTP ${res.status}）: ${pagesUrl}`);
      console.log("  → Settings → Pages の Source が「GitHub Actions」か確かめてください。");
    }
  } catch (e) {
    console.log(`  ❌ つながりません: ${e.message}`);
  }

  /* --- まとめ --- */
  const done = list.filter((r) => r.status === "completed");
  const ok = done.filter((r) => r.conclusion === "success");
  console.log("\n══════════════════════════════════════════");
  if (ok.length) {
    console.log("クラウド側は動いています。");
    console.log("ローカルの毎週実行を止めてよい段階です:");
    console.log("  powershell -ExecutionPolicy Bypass -File tools\\setup-schedule.ps1 -Remove");
  } else if (done.length) {
    console.log("走ったが成功していません。上のリンクで中身を見てください。");
    console.log("ローカルの毎週実行は、まだ止めないでください。");
  } else {
    console.log("まだ走っていません。Actions タブから手動で1回試してください。");
  }
})().catch((e) => {
  console.error("確認に失敗:", e.message);
  process.exit(1);
});
