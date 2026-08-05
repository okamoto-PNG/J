@echo off
rem 自動更新の入口。タスクスケジューラからも、手で叩いてもよい。
rem   tools\auto.cmd           … 必要なら更新する
rem   tools\auto.cmd --dry     … 判定だけ
rem   tools\auto.cmd --force   … 全年を取り直す
rem
rem %~dp0 は このファイルがある tools\ なので、1つ上（プロジェクト直下）へ移る。
cd /d "%~dp0.."

rem ★このPC固有のパスは書かない（PCを変えたときに嘘になる）。
rem タスクスケジューラへの登録は tools\setup-schedule.ps1 が node の場所を解決して行う。
where node >nul 2>nul
if not %ERRORLEVEL%==0 (
  echo node が PATH にありません。Node.js を入れてから、もう一度実行してください。
  exit /b 1
)
node "tools\auto.js" %*
exit /b %ERRORLEVEL%
