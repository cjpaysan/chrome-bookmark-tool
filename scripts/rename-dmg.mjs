#!/usr/bin/env node
// rename-dmg.mjs — 把 electron-builder 产出的安装包重命名为带 displayVersion 的名字
// 原因：electron-builder 的 artifactName 只用三段 version（1.2.0），无法体现第四位；
//       这里统一把 release/BookmarkTool-1.2.0-macos.* 重命名为 BookmarkTool-1.2.0.1-macos.*
// 用法：node scripts/rename-dmg.mjs（需先运行 electron-builder）

import fs from 'node:fs';
import path from 'node:path';

const PKG = path.join(process.cwd(), 'package.json');
const RELEASE = path.join(process.cwd(), 'release');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const dv = pkg.displayVersion || pkg.version; // 四段展示版
const ver = pkg.version;                        // 三段 semver

if (!fs.existsSync(RELEASE)) {
  console.error('❌ release/ 目录不存在，请先运行 electron-builder');
  process.exit(1);
}

const files = fs.readdirSync(RELEASE);
const prefix = `BookmarkTool-${ver}-macos.`;
const matches = files.filter((f) => f.startsWith(prefix));

if (!matches.length) {
  console.error(`❌ 未找到 ${prefix}* 产物，请确认 electron-builder 已成功打包`);
  process.exit(1);
}

for (const f of matches) {
  const ext = f.slice(prefix.length);
  const oldPath = path.join(RELEASE, f);
  const newPath = path.join(RELEASE, `BookmarkTool-${dv}-macos.${ext}`);
  if (oldPath !== newPath) {
    fs.renameSync(oldPath, newPath);
    console.log(`✅ 重命名: ${f} → BookmarkTool-${dv}-macos.${ext}`);
  }
}

// electron-builder 生成的 latest-mac.yml 仍指向三段版本文件名，同步修正
const yml = path.join(RELEASE, 'latest-mac.yml');
if (fs.existsSync(yml)) {
  let y = fs.readFileSync(yml, 'utf8');
  const oldToken = `BookmarkTool-${ver}-macos.`;
  if (y.includes(oldToken)) {
    y = y.replaceAll(oldToken, `BookmarkTool-${dv}-macos.`);
    fs.writeFileSync(yml, y);
    console.log(`✅ latest-mac.yml 文件名引用已同步为 ${dv}`);
  }
}
