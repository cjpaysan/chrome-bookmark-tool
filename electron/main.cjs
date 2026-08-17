// main.cjs — Electron 主进程（CommonJS）
// 在独立原生窗口内启动内嵌的 server.js（esbuild bundle），加载本地 UI，完全脱离浏览器。
// 用 CJS 是 Electron 生态最成熟路径：ESM main 在 Electron 内置 Node 20 下加载
// electron 包（CJS）会触发 cjsPreparseModuleExports 崩溃。

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');

// 防御：某些环境（如 CI/容器）可能残留 ELECTRON_RUN_AS_NODE=1，
// 它会让 Electron 以纯 Node 模式运行（require('electron') 返回二进制路径）。
// 打包后的 .app 不会设置它，但显式删除更稳妥。
delete process.env.ELECTRON_RUN_AS_NODE;

// ---- 环境配置：内嵌服务使用独立数据目录（写入 App Support 而非项目目录） ----
process.env.BM_OUTPUT_DIR = process.env.BM_OUTPUT_DIR || path.join(app.getPath('userData'), 'output');
process.env.PORT = process.env.PORT || '4789';
const PORT = parseInt(process.env.PORT, 10);

// 单实例锁：避免重复启动多个服务实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main();
}

// 等待本地服务端口就绪（最多 timeout ms）
function waitForPort(port, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(tryConnect, 120);
      });
    };
    tryConnect();
  });
}

async function main() {
  // 检查 server.bundle.cjs 是否存在（DMG 替换时可能损坏）
  const bundlePath = path.join(ROOT, 'electron', 'server.bundle.cjs');
  if (!require('node:fs').existsSync(bundlePath)) {
    dialog.showErrorBox('BookmarkTool 启动失败',
      '核心文件丢失：electron/server.bundle.cjs\n\n' +
      '应用可能没正确安装，请重新从 dmg 安装（不要在 Finder 里直接"打开"解压的 app）。');
    app.quit();
    return;
  }

  // 内嵌启动后端服务（esbuild bundle 的 CJS 单文件，依赖已内联，规避 Electron ESM loader 崩溃）
  require(bundlePath);

  // 等待端口就绪（server.listen 异步，窗口不能比服务先加载）
  const portReady = await waitForPort(PORT, 15000);
  if (!portReady) {
    dialog.showErrorBox('BookmarkTool 启动失败',
      '内嵌服务在 15 秒内未启动（端口 ' + PORT + '）。\n\n' +
      '可能原因：\n• 端口 ' + PORT + ' 被其他应用占用\n' +
      '• 防火墙/安全软件拦截\n• 后端初始化失败\n\n' +
      '请检查后重试。');
    app.quit();
    return;
  }
  console.log('[BM] server ready on port ' + PORT);

  let win = null;

  function createWindow() {
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      title: '书签整理工具',
      backgroundColor: '#f6f8fa',
      icon: path.join(ROOT, 'build', 'icon.png'),
      autoHideMenuBar: false,
      show: false,  // 防白屏：等 ready-to-show 再显示
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    // 加载本地 UI（服务已内嵌启动，直接访问 localhost）
    win.loadURL(`http://localhost:${PORT}/`);

    // 加载失败诊断：弹窗告诉用户具体原因（不静默黑屏）
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      dialog.showErrorBox('BookmarkTool 加载失败',
        `无法加载本地 UI：\n${url}\n\n错误码 ${code}：${desc}\n\n可能原因：\n` +
        '• 内嵌服务启动失败（端口 ' + PORT + ' 被占用）\n' +
        '• app.asar 里的 server.bundle.cjs 损坏\n\n' +
        '请尝试：退出应用后重新打开，或重启电脑后再试。');
    });

    // ready-to-show 后才显示（防黑屏/白屏）
    win.once('ready-to-show', () => {
      console.log('[BM] window ready-to-show, showing');
      win.show();
    });

    // 外部链接用系统浏览器打开（不劫持应用窗口）
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) shell.openExternal(url);
      return { action: 'deny' };
    });

    win.on('closed', () => { win = null; });
  }

  // ---- 应用菜单（原生菜单栏） ----
  function buildMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
      ...(isMac ? [{
        label: app.name,
        submenu: [
          { role: 'about', label: '关于 书签整理工具' },
          { type: 'separator' },
          { role: 'hide', label: '隐藏' },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '全部显示' },
          { type: 'separator' },
          { role: 'quit', label: '退出 书签整理工具' },
        ],
      }] : []),
      {
        label: '文件',
        submenu: [
          { label: '重新扫描', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
          { label: '打开开发者工具', accelerator: 'Alt+CmdOrCtrl+I', click: () => win?.webContents.openDevTools({ mode: 'detach' }) },
          { type: 'separator' },
          { role: 'close', label: '关闭窗口' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '进入全屏' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          ...(isMac ? [
            { type: 'separator' },
            { role: 'front', label: '前置全部窗口' },
          ] : [
            { role: 'close', label: '关闭窗口' },
          ]),
        ],
      },
      {
        label: '帮助',
        submenu: [
          {
            label: '关于本项目',
            click: async () => {
              await dialog.showMessageBox(win, {
                type: 'info',
                title: '关于',
                message: '书签整理工具',
                detail:
                  '本地 Chrome 书签检测 / 整理 / Safari 同步工具。\n\n' +
                  `版本 ${app.getVersion()}\n` +
                  '数据仅保存在本机，无需联网。',
              });
            },
          },
          {
            label: '查看日志目录',
            click: () => shell.openPath(path.join(app.getPath('userData'), 'output')),
          },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
