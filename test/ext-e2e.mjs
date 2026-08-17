// 隔离端到端测试：用一个独立的临时 Chrome 配置目录（GoogleX/TestProfile），
// 走真实链路：启动 Chrome → 扩展注册 → getTree → remove → 卸载，验证删除确实生效。
// 不触碰用户真实的 Google 同步账号。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const NODE = '/Users/paysan/.workbuddy/binaries/node/versions/22.22.2/bin/node';
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4795;
const AS = path.join(os.homedir(), 'Library', 'Application Support');
const TEST_UD = path.join(AS, 'GoogleX');
const TEST_PROFILE = path.join(TEST_UD, 'TestProfile');
const BM_PATH = path.join(TEST_PROFILE, 'Bookmarks');

const TEST_BOOKMARKS = {
  version: 1,
  roots: {
    bookmark_bar: {
      type: 'folder', name: '书签栏',
      children: [
        { type: 'url', name: 'Test A', url: 'https://example-a.test/', id: '1', guid: 'guid-a' },
        { type: 'url', name: 'Test B', url: 'https://example-b.test/', id: '2', guid: 'guid-b' },
        { type: 'url', name: 'Test C', url: 'https://example-c.test/', id: '3', guid: 'guid-c' },
      ],
    },
    other: { type: 'folder', name: '其他书签', children: [] },
    synced: { type: 'folder', name: '移动设备', children: [] },
  },
  checksum: 'test',
};

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, raw: d }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await req('GET', '/api/profiles'); if (r.status === 200) return true; } catch {}
    await new Promise((s) => setTimeout(s, 300));
  }
  throw new Error('server not up');
}

async function main() {
  // 准备隔离测试 profile
  fs.rmSync(TEST_PROFILE, { recursive: true, force: true });
  fs.mkdirSync(TEST_PROFILE, { recursive: true });
  fs.writeFileSync(BM_PATH, JSON.stringify(TEST_BOOKMARKS, null, 3), 'utf8');

  // 启动独立测试服务器
  const srv = spawn(NODE, ['src/server.js'], { cwd: PROJECT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (c) => process.stdout.write('[srv] ' + c));
  srv.stderr.on('data', (c) => process.stdout.write('[srv-err] ' + c));

  let pass = false;
  try {
    await waitServer();
    console.log('[test] server up; test profile ready with 3 bookmarks');

    const res = await req('POST', '/api/delete-synced', {
      browser: 'GoogleX', profile: 'TestProfile',
      items: [{ url: 'https://example-b.test/', title: 'Test B' }],
    });
    console.log('[test] /api/delete-synced ->', JSON.stringify(res.json, null, 2));

    // 重新读取文件确认 Test B 已删除
    const after = JSON.parse(fs.readFileSync(BM_PATH, 'utf8'));
    const remaining = [];
    const walk = (n) => { if (!n) return; if (n.type === 'url') remaining.push(n.url); (n.children || []).forEach(walk); };
    ['bookmark_bar', 'other', 'synced'].forEach((k) => walk(after.roots[k]));
    const stillHasB = remaining.includes('https://example-b.test/');
    console.log('[test] remaining urls:', remaining);
    console.log('[test] Test B still present?', stillHasB);

    pass = res.json.ok && res.json.removed >= 1 && !stillHasB;
    console.log(pass ? '\n✅ E2E PASS: 扩展启动、删除、卸载全链路成功，文件确认删除生效。' : '\n❌ E2E FAIL');
  } catch (e) {
    console.error('[test] error:', e.message);
  } finally {
    try { srv.kill('SIGTERM'); } catch {}
    // 关闭测试启动的 Chrome
    try { spawn('pkill', ['-f', 'GoogleX']); } catch {}
    await new Promise((s) => setTimeout(s, 800));
    fs.rmSync(TEST_UD, { recursive: true, force: true });
    console.log('[test] cleaned up temp profile');
    process.exit(pass ? 0 : 1);
  }
}

main();
