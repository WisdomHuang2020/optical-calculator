#!/usr/bin/env bash
# ============================================================
# optical-calculator → 腾讯云 Lighthouse 部署脚本（v3，路径纠偏版）
# 经 TAT RunCommand 在目标机以 root 执行（免 SSH）。
# 适配：Ubuntu 24.04、GitHub 中国区慢链、已有的 power-knowledge.tech nginx 体系。
#
# 站点实况（2026-09-21 现场核对，v3 据实修正）：
#  - 域名：optical.power-knowledge.tech（别名 www.optical.* / seastar.*，同一份内容）
#  - nginx 站点配置：/etc/nginx/sites-available/optical（sites-enabled/optical 为符号链接）
#  - web 根：/var/www/optical
#  - 证书：letsencrypt pk-wildcard；80 块 include snippets/acme.conf，443 块 SSL
#
# v2 → v3 修正（v2 的三处路径均与现场不符，导致 v3.11.1 曾"部署成功"而站点未更新）：
#  - DEPLOY_DIR ：/var/www/optical-calculator → /var/www/optical
#  - SITE_CONF  ：/etc/nginx/conf.d/optical-calculator.conf
#                 → /etc/nginx/sites-available/optical
#  - 自检域名    ：calc.power-knowledge.tech → optical.power-knowledge.tech
#  另新增三处加固：
#   1) 部署前用 nginx 配置反查真实 root，与 DEPLOY_DIR 断言一致，不一致直接拒绝（防再写错目录）；
#   2) nginx 配置改为「只校验、不生成」——v2 的模板是不带 TLS 的裸 server 块，
#      一旦覆盖会打断 HTTPS 与域名别名，脚本不应拥有该文件；
#   3) 自检改为「源文件 / 落盘 / 经真实 vhost 取回」三方 md5 比对，任一不一致即失败。
# ============================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DEPLOY_DIR="/var/www/optical"
SITE_CONF="/etc/nginx/sites-available/optical"
SITE_DOMAIN="optical.power-knowledge.tech"
REPO="WisdomHuang2020/optical-calculator"
BRANCH="main"
URL_TAR="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"
URL_GIT="https://github.com/${REPO}.git"

echo "==> [0/6] 前置断言：DEPLOY_DIR 必须等于 nginx 实际 root"
if [ ! -f "$SITE_CONF" ]; then
  echo "  致命：读不到 $SITE_CONF，先人工核对 nginx 站点配置"; exit 2
fi
NGX_ROOT=$(awk '/^[[:space:]]*root[[:space:]]/{print $2}' "$SITE_CONF" | tr -d ';' | head -1)
if [ -z "$NGX_ROOT" ]; then
  echo "  致命：$SITE_CONF 中没有 root 指令，拒绝部署"; exit 2
fi
if [ "$NGX_ROOT" != "$DEPLOY_DIR" ]; then
  echo "  致命：路径不一致，拒绝部署以免写错目录（这正是 v2 曾经踩的坑）"
  echo "    nginx 实际 root : $NGX_ROOT"
  echo "    脚本 DEPLOY_DIR : $DEPLOY_DIR"
  exit 2
fi
echo "  一致：$DEPLOY_DIR"

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
chown -R www-data:www-data "$DEPLOY_DIR"
echo "  运行时条目: $(ls -A "$DEPLOY_DIR" | tr '\n' ' ')"

echo "==> [4/6] 校验 nginx 配置（只读，绝不覆盖）"
grep -q "security-hardening" "$SITE_CONF" || echo "  警告：$SITE_CONF 未包含 security-hardening.conf，请人工确认加固状态"
grep -q "$SITE_DOMAIN" "$SITE_CONF" || { echo "  致命：$SITE_CONF 未包含 $SITE_DOMAIN"; exit 5; }
echo "  配置就位且指向 $SITE_DOMAIN"

echo "==> [5/6] 语法检查 + 重载"
nginx -t
systemctl reload nginx 2>/dev/null || nginx -s reload

echo "==> [6/6] 自检：源文件 / 落盘 / 经真实 vhost 取回 三方 md5 比对"
sleep 1
FAIL=0
for f in index.html js/version.js js/prism.js styles.css; do
  [ -f "$SRC/$f" ] || continue
  A=$(md5sum "$SRC/$f" | cut -d' ' -f1)
  B=$(md5sum "$DEPLOY_DIR/$f" 2>/dev/null | cut -d' ' -f1)
  C=$(curl -sk --resolve "$SITE_DOMAIN:443:127.0.0.1" -m 20 "https://$SITE_DOMAIN/$f" | md5sum | cut -d' ' -f1)
  if [ -n "$A" ] && [ "$A" = "$B" ] && [ "$B" = "$C" ]; then
    echo "  PASS  $f  $A"
  else
    echo "  FAIL  $f  源=${A:0:8} 盘=${B:0:8} 服务=${C:0:8}"; FAIL=1
  fi
done
VER=$(curl -sk --resolve "$SITE_DOMAIN:443:127.0.0.1" -m 20 "https://$SITE_DOMAIN/js/version.js" | grep -o "APP_VERSION = '[^']*'" || true)
echo "  线上版本：${VER:-取不到}"
[ "$FAIL" = "0" ] || { echo "DEPLOY_FAILED 有文件未同步到线上"; exit 6; }
echo "DEPLOY_DONE dir=${DEPLOY_DIR} domain=${SITE_DOMAIN}"
