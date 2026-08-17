#!/usr/bin/env bash
# BookmarkTool 一键安装助手（绕过 macOS Gatekeeper）
# 用法：在挂载的 DMG 窗口里，右键（或按住 Control 点击）本文件 → 打开，即可自动安装并启动。
# 说明：未签名的 .command 首次打开也会被 macOS 拦一次，点「打开」即可，只需这一次。

clear
echo "===================================================="
echo "        BookmarkTool 一键安装助手"
echo "===================================================="
echo ""

APP_NAME="BookmarkTool.app"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_APP="$SRC_DIR/$APP_NAME"
DST_APP="/Applications/$APP_NAME"

# 1. 校验源 app 是否存在（脚本必须与 app 在同一文件夹，即 DMG 内）
if [ ! -d "$SRC_APP" ]; then
  echo "❌ 未找到 $APP_NAME。"
  echo "   请确认本脚本与 $APP_NAME 在同一个文件夹（即 DMG 挂载窗口里），不要单独拷出来跑。"
  read -p "按回车退出"
  exit 1
fi

# 2. 拷贝到「应用程序」
echo "📦 正在安装到「应用程序」…"
if [ -d "$DST_APP" ]; then
  rm -rf "$DST_APP"
fi
cp -R "$SRC_APP" "$DST_APP"

# 3. 移除 Gatekeeper 拦截标记（解除“无法验证开发者”）
echo "🔓 正在解除 macOS 拦截…"
xattr -dr com.apple.quarantine "$DST_APP" 2>/dev/null || true
xattr -cr "$DST_APP" 2>/dev/null || true

# 4. 启动
echo "✅ 安装完成，正在启动 BookmarkTool…"
sleep 1
open "$DST_APP"

echo ""
echo "🎉 以后直接从「启动台」或「应用程序」打开即可，无需再运行本脚本。"
read -p "按回车退出"
