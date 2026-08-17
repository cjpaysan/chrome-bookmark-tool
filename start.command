#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "正在启动书签工具…"
nohup node src/server.js > bookmarks-tool.log 2>&1 &
sleep 2
open http://localhost:4789
