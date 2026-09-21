#!/usr/bin/env bash
# ============================================================
# optical-calculator → 腾讯云 Lighthouse 部署脚本（v2，安全加固版）
# 经 TAT RunCommand 在目标机以 root 执行（免 SSH）。
# 适配：Ubuntu 24.04、GitHub 中国区慢链、已有的 power-knowledge.tech nginx 体系。
#
# 安全约定（重要，避免破坏既有加固）：
#  - 站点运行时文件发布到 /var/www/optical-calculator，但【只放运行时】
#    （index.html / js / styles.css / favicon.ico / preview），不放仓库文档
#    （tests/ tools/ CHANGELOG.md AUDIT-*.md .cloudbase-mcp/ 等）。
#  - nginx 配置只写「白名单加固版」（server_name _ + include snippets/security-hardening.conf）。
#    若 /etc/nginx/conf.d/optical-calculator.conf 已含 security-hardening，则【跳过覆盖】，
#    以免破坏既有安全策略（初版脚本曾整文件覆盖，已被现场重新加固过）。
# ============================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DEPLOY_DIR="/var/www/optical-calculator"
SITE_CONF="/etc/nginx/conf.d/optical-calculator.conf"
REPO="WisdomHuang2020/optical-calculator"
BRANCH="main"
URL_TAR="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"
URL_GIT="https://github.com/${REPO}.git"

echo "==> [1/6] 环境核对"
command -v nginx >/dev/null 2>&1 || { apt-get update >/dev/null 2>&1; apt-get install -y nginx; }
command -v git   >/dev/null 2>&1 || apt-get install -y git
# 清掉上一条 TIMEOUT 命令可能遗留的 apt 锁
rm -f /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/cache/apt/archives/lock 2>/dev/null || true

echo "==> [2/6] 取代码（优先 tarball 单连接，慢链回退 git clone）"
rm -rf /tmp/oc_src; mkdir -p /var/www /tmp/oc_src
SRC=""
if curl -fsSL -m 1700 --retry 3 -o /tmp/oc.tar.gz "$URL_TAR"; then
  echo "  tarball 下载成功，解包"
  tar xzf /tmp/oc.tar.gz -C /tmp/oc_src
  SRC=$(ls -d /tmp/oc_src/optical-calculator-* 2>/dev/null | head -1)
fi
if [ -z "$SRC" ] || [ ! -f "$SRC/index.html" ]; then
  echo "  tarball 失败，回退 git clone --depth 1"
  git clone --depth 1 --single-branch -b "$BRANCH" "$URL_GIT" /tmp/oc_src/optical-calculator || { echo "拉取失败"; exit 3; }
  SRC=/tmp/oc_src/optical-calculator
fi
[ -f "$SRC/index.html" ] || { echo "仍无 index.html，部署中止"; exit 4; }

echo "==> [3/6] 仅发布运行时文件到 web 根（不放仓库文档）"
mkdir -p "$DEPLOY_DIR"
# 清空旧运行时条目（保留目录本身），再拷入运行时文件
find "$DEPLOY_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
for item in index.html js styles.css favicon.ico preview; do
  [ -e "$SRC/$item" ] && cp -a "$SRC/$item" "$DEPLOY_DIR/"
done
echo "  运行时条目: $(ls -A "$DEPLOY_DIR" | tr '\n' ' ')"

echo "==> [4/6] 写 Nginx 配置（已加固则跳过，不破坏既有安全策略）"
if grep -q "security-hardening" "$SITE_CONF" 2>/dev/null; then
  echo "  已存在加固版配置，跳过覆盖"
else
  cat > "$SITE_CONF" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name _;

    root ${DEPLOY_DIR};
    index index.html;

    access_log /var/log/nginx/optical-calculator.access.log;
    error_log  /var/log/nginx/optical-calculator.error.log;

    include snippets/security-hardening.conf;

    location = /               { try_files /index.html =404; }
    location = /index.html     { }
    location = /styles.css     { }
    location = /favicon.ico    { }
    location ~* ^/(js|preview)/ { try_files \$uri =404; }

    location / { return 404; }
}
NGINX
  echo "  已写入加固版配置"
fi

echo "==> [5/6] 语法检查 + 重载"
nginx -t
systemctl reload nginx 2>/dev/null || nginx -s reload

echo "==> [6/6] 自检（按既定子域名通道）"
sleep 1
H="calc.power-knowledge.tech"
curl -sk --resolve "$H:443:127.0.0.1" -m 10 -o /dev/null -w "https($H)=%{http_code}\n" "https://$H/" || true
echo "DEPLOY_DONE dir=${DEPLOY_DIR}"
