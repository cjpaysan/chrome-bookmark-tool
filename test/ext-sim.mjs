// 模拟“常驻扩展”的 HTTP 协议，验证服务端与扩展之间的桥接链路：
// session → 长轮询 command → getTree/remove → result → /api/delete-synced 返回成功。
// 说明：常驻扩展完成任务后不会自我卸载，因此不期待 uninstall 命令。
const BASE = 'http://localhost:4789';
const TOKEN = 'bm-tool-local-bridge-7f3a';

const FAKE_TREE = [
  { id: '1', title: 'X', url: 'https://x.com' },
  { id: '2', title: 'X', url: 'http://x.com' }, // http/https 同源变体（查重时同组，标题相同）
  { id: '3', title: 'Keep', url: 'https://keep.com' },
];

const received = [];
let stop = false;

async function extLoop() {
  while (!stop) {
    let cmd;
    try {
      const r = await fetch(`${BASE}/api/ext/command?token=${TOKEN}&wait=1&timeout=25000`, { cache: 'no-store' });
      cmd = await r.json();
    } catch { break; }
    if (!cmd || cmd.type === 'none') continue;
    received.push(cmd.type);
    if (cmd.type === 'getTree') {
      await fetch(`${BASE}/api/ext/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: cmd.id, ok: true, data: FAKE_TREE }) });
    } else if (cmd.type === 'remove') {
      await fetch(`${BASE}/api/ext/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: cmd.id, ok: true, data: { removed: cmd.ids } }) });
    } else {
      await fetch(`${BASE}/api/ext/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: cmd.id, ok: false, error: 'unknown' }) });
    }
  }
}

(async () => {
  // 1) 注册（模拟扩展启动）
  const s = await fetch(`${BASE}/api/ext/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, resident: true }) });
  console.log('[sim] session ->', (await s.json()).matched ? 'matched' : 'NOT matched');

  // 2) 启动扩展长轮询循环
  extLoop();

  // 3) 稍候，发起删除请求（扩展已“连接”，直接走常驻桥接；匹配 https://x.com 与 http://x.com 两条）
  await new Promise((r) => setTimeout(r, 300));
  const del = await fetch(`${BASE}/api/delete-synced`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ browser: 'Chrome', profile: 'Default', items: [{ url: 'https://x.com', title: 'X' }] }) });
  const res = await del.json();
  console.log('[sim] delete-synced ->', JSON.stringify(res));
  console.log('[sim] 扩展收到的命令顺序:', received.join(' -> '));

  stop = true;
  const pass = res.ok && res.removed === 2 && received.includes('getTree') && received.includes('remove');
  console.log(pass ? '\n✅ 桥接链路验证通过：getTree→remove 已送达扩展，删除返回成功（常驻扩展，不卸载）' : '\n❌ 验证未通过');
  process.exit(pass ? 0 : 1);
})();
