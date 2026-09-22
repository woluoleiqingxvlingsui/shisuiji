# 拾穗集 HTTPS 启动（手机 PWA / 电脑关机后离线冷启动需要）
# 证书已可放在项目根目录：danji-cert.pem + danji-key.pem（*.pem 已 gitignore）
# 控制台「启动服务」会自动识别这两个文件并走 HTTPS，无需再跑本脚本。
# 若需手动生成/更新证书（IP 变了要重签）：
#   & "C:\Program Files\Git\usr\bin\openssl.exe" req -x509 -newkey rsa:2048 -nodes -keyout danji-key.pem -out danji-cert.pem -days 825 -subj "/CN=danji" -addext "subjectAltName=IP:192.168.1.100,IP:127.0.0.1,DNS:localhost"
# 手机：https://<电脑IP>:8642 → 证书告警继续 → 添加到主屏幕
# 口令仍放 local.env.ps1 的 DANJI_TOKEN

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
if (Test-Path .\local.env.ps1) { . .\local.env.ps1 }

$env:DANJI_TLS_CERT = Join-Path $here "danji-cert.pem"
$env:DANJI_TLS_KEY  = Join-Path $here "danji-key.pem"

node server.js
