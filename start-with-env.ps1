# 拾穗集：加载本地私密环境变量后启动
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
. .\local.env.ps1
node server.js
