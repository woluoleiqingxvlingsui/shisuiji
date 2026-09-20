# 拾穗集：HTTPS 启动模板（手机 PWA / 离线冷启动需要）
# 1) 用 Git 自带 openssl 生成自签证书（把 IP 换成你的局域网 IP）：
#    openssl req -x509 -newkey rsa:2048 -nodes -keyout danji-key.pem -out danji-cert.pem -days 825 -subj "/CN=danji" -addext "subjectAltName=IP:192.168.1.100"
# 2) 复制本文件为 start-with-https.local.ps1（勿提交），改成你的证书路径
# 3) powershell -File start-with-https.local.ps1
# 4) 手机浏览器打开 https://<IP>:8642 → 信任证书 → 添加到主屏幕
# 注意：*.pem 已在 .gitignore；口令请放在 local.env.ps1 的 DANJI_TOKEN

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
if (Test-Path .\local.env.ps1) { . .\local.env.ps1 }

$env:DANJI_TLS_CERT = Join-Path $here "danji-cert.pem"
$env:DANJI_TLS_KEY  = Join-Path $here "danji-key.pem"
# 局域网访问（若本地 config.json 已写 host=0.0.0.0 可省略）
# $env:DANJI_HOST = "0.0.0.0"

node server.js
