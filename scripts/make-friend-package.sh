#!/bin/bash
# make-friend-package.sh — 生成「给朋友的一键安装包」
# 用法：cd 到项目根目录（bookmark-tool），执行 ./scripts/make-friend-package.sh
# 产物：dist/书签整理工具-朋友安装包-v{版本}.zip
#       （内含 dmg + install.command 一键安装脚本 + 使用说明.txt）
#
# 发布流程：
#   1. npm run dist           # 先生成最新 DMG
#   2. ./scripts/make-friend-package.sh   # 再打朋友安装包

set -e
# 项目根 = scripts/..
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# 读取当前版本
VERSION="$(node -e "console.log(require('./package.json').version)")"
# dist 目录在项目根的上层（WorkBuddy 工作区），与 release/ 分离
DIST_DIR="$(cd "$PROJECT_ROOT/.." && pwd)/dist"
STAGE_DIR="$DIST_DIR/friend-package"
PKG_NAME="书签整理工具-朋友安装包-v$VERSION.zip"
README="$STAGE_DIR/使用说明.txt"

# 找最新 DMG：优先选英文 dmg (BookmarkTool-xxx-macos.dmg)；兜底选任意 dmg 并排除明显别名
DMG="$(ls "$DIST_DIR"/BookmarkTool-*-macos.dmg 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$DMG" ]; then
  DMG="$(ls "$DIST_DIR"/*.dmg 2>/dev/null | grep -vE '桌面版|旧版' | sort -V | tail -1 || true)"
fi
if [ -z "$DMG" ]; then
  echo "❌ dist/ 里没有 dmg 文件。请先 npm run dist"
  exit 1
fi
echo "📦 使用安装包：$(basename "$DMG")"

# 清空并重建 stage 目录
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp "$DMG" "$STAGE_DIR/"
cp "$DIST_DIR/install.command" "$STAGE_DIR/"

# 生成使用说明
cat > "$README" << 'EOF'
══════════════════════════════════════════════════
  书签整理工具 · 安装说明（macOS）
══════════════════════════════════════════════════

【最简单的方法】
  1. 双击「书签整理工具-xxx.dmg」
  2. 把弹出的窗口里的「书签整理工具.app」拖到「应用程序」文件夹
  3. 去「应用程序」文件夹，右键点「书签整理工具」→ 选「打开」
     （第一次会有系统提示，点「打开」即可，之后就能正常双击）
  4. 如果提示「已损坏，无法打开」：
     双击文件夹里的「install.command」，它会自动完成安装

【install.command 自动安装法】（推荐小白）
  1. 双击「install.command」
  2. 按提示一路确认（可能需要输入电脑密码）
  3. 它会自动复制 + 解除拦截 + 打开应用

【为什么要这样】
  macOS 默认只允许运行「苹果审核过」的应用。
  这个工具是个人开发、未付费给苹果（¥718/年），
  所以系统会拦截，需要手动「打开」一次或运行脚本解锁。
  放心，这是安全操作——只解除这一个应用的限制，不影响电脑。

【常见问题】
  Q: 双击 install.command 提示无法打开？
  A: 右键 → 打开 → 再点「打开」一次即可

  Q: 装好后 Chrome 里的配套扩展怎么装？
  A: 打开应用后看右上角「随附扩展」状态，按提示操作
EOF

# 打 zip（用 macOS 原生 ditto，不用 zip 命令 —— zip -X 对大 dmg 文件会截断成空！）
cd "$DIST_DIR"
rm -f "$PKG_NAME"
ditto -c -k -X "$STAGE_DIR" "$PKG_NAME"
cd "$PROJECT_ROOT"

# 验证：zip 里 dmg MD5 必须 = dist 里 dmg MD5（防 dmg 在 zip 时被截断）
SOURCE_DMG_MD5="$(md5 -q "$DMG" | awk '{print $NF}')"
ZIP_DMG_MD5="$(unzip -p "$DIST_DIR/$PKG_NAME" "$(basename "$DMG")" | md5 -q)"
if [ "$SOURCE_DMG_MD5" != "$ZIP_DMG_MD5" ]; then
  echo "❌ 严重：zip 里的 dmg 与源 dmg MD5 不一致（zip 损坏）"
  echo "   源 dmg: $SOURCE_DMG_MD5"
  echo "   zip里:  $ZIP_DMG_MD5"
  exit 1
fi
echo "✅ dmg 完整性验证：$ZIP_DMG_MD5"

echo ""
echo "✅ 打包完成：dist/$PKG_NAME"
echo "   （把 zip 直接发给朋友，解压后双击 install.command 即可）"
echo ""
echo "  内容："
ls -la "$STAGE_DIR"
