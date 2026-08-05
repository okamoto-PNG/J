<#
  毎週の自動更新をタスクスケジューラに登録する（PCを変えたらこれを1回だけ）。

      powershell -ExecutionPolicy Bypass -File tools\setup-schedule.ps1
      powershell -ExecutionPolicy Bypass -File tools\setup-schedule.ps1 -Remove
      powershell -ExecutionPolicy Bypass -File tools\setup-schedule.ps1 -DayOfWeek Saturday -At 21:00

  ★パスを直書きしない。
  プロジェクトの場所はこのファイルの位置から、node の場所は PATH から解決する。
  そうしておかないと、PCを変えたときに登録し直せない
  （タスクスケジューラの登録はPCごとのもので、OneDrive では同期されない）。
#>
param(
  [switch]$Remove,
  [string]$TaskName = "J1予想アプリ 自動更新",
  [string]$DayOfWeek = "Monday",
  [string]$At = "12:00"
)

$ErrorActionPreference = "Stop"

# このスクリプトは tools\ にあるので、1つ上がプロジェクト直下
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "tools\auto.js"

if ($Remove) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "削除しました: $TaskName"
  } else {
    Write-Output "登録されていません: $TaskName"
  }
  exit 0
}

if (-not (Test-Path $script)) {
  Write-Error "tools\auto.js が見つかりません: $script"
  exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Error "node が PATH にありません。Node.js を入れてから、もう一度実行してください。"
  exit 1
}

Write-Output "プロジェクト : $root"
Write-Output "node         : $node"

# 動くかどうかを先に確かめる（--dry は何も書き換えない）
Write-Output ""
Write-Output "--- 動作確認（--dry。何も書き換えません）---"
Push-Location $root
try { & $node "tools\auto.js" --dry } finally { Pop-Location }
Write-Output ""

# 同名があれば作り直す（何度実行してもよい）
$old = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($old) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "既存の登録を作り直します"
}

$action = New-ScheduledTaskAction -Execute $node -Argument 'tools\auto.js' -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $At
# StartWhenAvailable    … 見逃した週は次に起動したとき埋め合わせる
# DontStopIfGoingOnBatteries … ノートでも走る
# ExecutionTimeLimit    … 万一ぶら下がっても1時間で打ち切る
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Jリーグ公式データを毎週見て、来季の日程が出たら自動でシーズンを進める。検算が落ちたら元に戻す。記録は data/auto-log.txt" | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output "登録しました: $TaskName（毎週 $DayOfWeek $At）"
Write-Output "次回の実行  : $($info.NextRunTime)"
Write-Output ""
Write-Output "すぐ試す    : Start-ScheduledTask -TaskName `"$TaskName`""
Write-Output "記録を読む  : Get-Content `"$root\data\auto-log.txt`" -Encoding utf8 -Tail 20"
Write-Output "やめる      : powershell -ExecutionPolicy Bypass -File tools\setup-schedule.ps1 -Remove"
