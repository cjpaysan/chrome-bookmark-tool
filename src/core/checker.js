// checker.js — 链接检测引擎（GET 优先 + HEAD 回退，并发 + 每主机限流 + 断点续跑 + 连接复用）
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { URL } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

// 书签存活检查是无安全敏感性的本地工具：关闭 TLS 证书校验，避免自签/代理拦截证书
// （如 UNABLE_TO_VERIFY_LEAF_SIGNATURE）被误判为“失效”。否则经代理隧道的 HTTPS 请求
// 会因证书校验失败而误报 network。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// 关键：很多“浏览器能开、Node 检测失败”的本质是 Node 默认先解析 IPv6（AAAA）且直连，
// 而浏览器会回落 IPv4 / 走系统代理。强制 IPv4 优先，让检测行为与浏览器一致。
dns.setDefaultResultOrder('ipv4first');

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return 'invalid'; }
}

function resolveRedirect(base, loc) {
  try { return new URL(loc, base).href; } catch { return loc; }
}

// 尊重系统代理（HTTP_PROXY / HTTPS_PROXY）。浏览器/系统默认走代理，但 Node 的 http/https
// 模块默认忽略代理环境变量 —— 这正是“浏览器能开、Node 检测失败被标红”的头号根因。
// 用户开了代理/VPN（国内极常见）时，不挂代理的直连会被墙/拒，导致误报。
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
let httpProxyAgent = null;
let httpsProxyAgent = null;
if (PROXY_URL) {
  try {
    httpProxyAgent = new HttpProxyAgent(PROXY_URL);
    // 书签存活检查不需要严格校验证书；关闭后避免自签/代理拦截证书（如 UNABLE_TO_VERIFY_LEAF_SIGNATURE）被误判为失效
    httpsProxyAgent = new HttpsProxyAgent(PROXY_URL, { rejectUnauthorized: false });
    console.log('[checker] 检测到代理，检测请求将走代理:', PROXY_URL);
  } catch (e) {
    console.error('[checker] 代理 agent 初始化失败，回退直连:', e.message);
  }
}

// 持久化 keep-alive 连接池：同一主机复用 TCP/TLS 连接，避免每条请求重复握手。
// HTTPS 关闭证书校验（书签存活检查不需要严格校验证书，避免自签/过期证书被误判为失效）。
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32, rejectUnauthorized: false });

// 真实浏览器指纹：大量站点（社区/固件下载站、Cloudflare 等）会拦截“非浏览器”的 UA 或
// 缺失常见 Header 的自动化请求，直接断开连接 → 被误判为「网络连接失败(network)」。
// 用接近真实 Chrome 的请求头，可显著降低此类误报。
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

// 单次请求，仅取响应头（不下载 body）。
// 优先 GET（带 Range 只取首字节）——GET 比 HEAD 兼容性更好、更不易被站点防护拦截；
// HEAD 仅作为 GET 网络层失败后的回退（个别老服务器/API 只支持 HEAD）。
// signal: AbortSignal —— 来自共享的 AbortController，用于「停止扫描」时中断在途请求。
function singleRequest(url, opts, method, signal) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(Object.assign(e, { code: 'INVALID_URL' })); }
    const lib = parsed.protocol === 'https:' ? https : http;
    // 优先用代理 agent（若配置了系统代理），否则用本地 keep-alive 连接池
    const agent = PROXY_URL
      ? (parsed.protocol === 'https:' ? httpsProxyAgent : httpProxyAgent)
      : (parsed.protocol === 'https:' ? httpsAgent : httpAgent);
    const timeout = opts.timeout || 8000;
    // 关键修复：以前只有 timer→destroy→req 'error' 触发的 reject，但 res 已经在等 body
    // 时 timer 触发只会 destroy req，不会让 res 关闭，promise 永远不 resolve —— 这是扫描卡死
    // 和"停止按钮无效"的根因！现在 timer 也直接 reject Promise（双重兜底）。
    let settled = false;
    const settle = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); fn(val); };
    const timer = setTimeout(() => {
      try { req.destroy(new Error('timeout')); } catch {}
      settle(reject, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, timeout);
    const headers = { ...BROWSER_HEADERS, 'Connection': 'keep-alive' };
    if (method === 'GET') {
      // 只取首字节，既触发真实响应又不下载正文；个别不支持 Range 的服务器会回 200 全量，
      // 此时拿到头部即 res.destroy() 切断，不下载正文。
      headers['Range'] = 'bytes=0-0';
      headers['Upgrade-Insecure-Requests'] = '1';
    }
    const req = lib.request(
      {
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        agent,
        signal,
      },
      (res) => {
        clearTimeout(timer);
        // res 阶段也要监听 error/close —— 服务器发完 header 后卡住不传 body 时，destroy req
        // 不会触发这里 resolve，必须显式 reject。
        res.on('error', (err) => settle(reject, err));
        res.on('close', () => { if (!settled) settle(reject, Object.assign(new Error('aborted'), { code: 'ABORTED' })); });
        // HEAD 无 body：resume 让 socket 回到连接池复用
        if (method === 'HEAD') { res.resume(); settle(resolve, { status: res.statusCode, headers: res.headers, location: res.headers.location }); return; }
        // GET：正常状态(2xx/3xx)只取首字节就销毁；错误状态(4xx/5xx)读前 2KB 做"伪404"内容分析
        if (res.statusCode >= 200 && res.statusCode < 400) { res.destroy(); settle(resolve, { status: res.statusCode, headers: res.headers, location: res.headers.location }); return; }
        // 4xx / 5xx：读取部分 body 判断是否为"假错误"（如 WordPress 自定义 404 模板实际有内容）
        const chunks = [];
        let totalLen = 0;
        const MAX_BODY = 2048;
        res.on('data', (c) => {
          totalLen += c.length;
          if (totalLen <= MAX_BODY) chunks.push(c);
          else res.destroy(); // 够了就停，不浪费带宽
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          settle(resolve, { status: res.statusCode, headers: res.headers, location: res.headers.location, bodySnippet: body });
        });
      }
    );
    req.on('error', (err) => settle(reject, err));
    // signal abort 也立即 reject —— 防止 destroy 后 res 'close' 没正确触发
    if (signal) {
      if (signal.aborted) settle(reject, Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      else signal.addEventListener('abort', () => {
        try { req.destroy(); } catch {}
        settle(reject, Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      }, { once: true });
    }
    req.end();
  });
}

// 默认 GET（带 Range）探测；GET 网络层失败 → 回退 HEAD；自动跟随重定向。
async function probe(url, opts, signal) {
  const maxRedirects = 5;
  let current = url;
  const chain = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res;
    try {
      // 优先 GET（更接近浏览器行为，且多数防护不拦 GET）
      res = await singleRequest(current, opts, 'GET', signal);
    } catch (err) {
      // GET 网络层失败 → 试 HEAD（个别老服务器/API 只支持 HEAD）
      try {
        res = await singleRequest(current, opts, 'HEAD', signal);
      } catch (err2) {
        throw err2;
      }
    }
    // 服务器对 GET 返回方法不支持 → 试 HEAD
    if ((res.status === 405 || res.status === 501) && hop === 0) {
      res = await singleRequest(current, opts, 'HEAD', signal);
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      chain.push({ from: current, to: res.location, status: res.status });
      current = resolveRedirect(current, res.location);
      continue;
    }
    return { status: res.status, finalUrl: current, redirectChain: chain, bodySnippet: res.bodySnippet };
  }
  return { status: 0, finalUrl: current, redirectChain: chain, reason: 'too_many_redirects' };
}

// 判断响应体是否像真实页面（而非真正的错误页）
// 很多 WordPress / SPA 站点返回 404 状态码但用自定义模板展示正常内容
function looksLikeRealPage(bodySnippet) {
  if (!bodySnippet || bodySnippet.length < 20) return false;
  const html = bodySnippet;
  // 有 <title> 标签且有实际文字内容（不是纯 "404 Not Found" 类错误标题）
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) return false;
  const title = titleMatch[1].trim();
  // 纯错误标题 → 真的 404（支持前缀/后缀变化，如 "404 Not Found"、"Page Not Found | SiteName"）
  if (/^(404\s*[-:—]?\s*)?(not found|page not found|无法找到|页面不存在|访问被拒绝|forbidden|error|错误)(\s*[-|—].*)?$/i.test(title)) return false;
  // body 里有实质内容（足够多的文字或链接）
  const textContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // 去掉标签后的纯文字超过 30 字符 → 很可能是真页面
  if (textContent.length > 30) return true;
  // 有多个链接 → 可能是导航正常的页面
  const linkCount = (html.match(/<a\s/i) || []).length;
  if (linkCount >= 3) return true;
  return false;
}

export function classify(status, error, bodySnippet) {
  if (error) {
    switch (error.code) {
      case 'ECONNREFUSED': return { ok: false, reason: 'connection_refused' };
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
      case 'ENODATA': return { ok: false, reason: 'dns_failure' };
      case 'ETIMEDOUT':
      case 'ESOCKETTIMEDOUT': return { ok: false, reason: 'timeout', suspicious: true };
      case 'ECONNRESET':
      case 'EPIPE':
      case 'UND_ERR_SOCKET': return { ok: false, reason: 'connection_reset', suspicious: true };
      case 'INVALID_URL': return { ok: false, reason: 'invalid_url' };
      case 'TimeoutError': return { ok: false, reason: 'timeout', suspicious: true };
      case 'ABORT_ERROR':
      case 'AbortError': return { ok: false, reason: 'aborted' };
      // 其余网络层错误（如 TLS 握手失败、协议错误等）兜底为 network
      default: return { ok: false, reason: 'network', suspicious: true };
    }
  }
  if (status >= 200 && status < 300) return { ok: true, reason: 'ok' };
  if (status >= 300 && status < 400) return { ok: true, reason: 'redirect' };
  // 401 / 403：很多站点（尤其是国内软件下载站、CDN防护站点）会对非浏览器请求返回
  // 401/403（反爬、UA检测、Cookie校验等），但浏览器正常访问。默认标记为可疑，不直接判死。
  if (status === 401 || status === 403) {
    const isRealPage = looksLikeRealPage(bodySnippet);
    return {
      ok: false,
      reason: 'login_required',
      suspicious: true,
      note: isRealPage
        ? '访问被拒绝(401/403)但页面有正常内容，可能是反爬或UA拦截'
        : '访问被拒绝(401/403)，可能是反爬/登录要求/地域限制，建议手动确认',
    };
  }
  // 404 / 410：检查响应体是否为"假 404"（WordPress 自定义模板等实际有内容的页面）
  if (status === 404 || status === 410) {
    if (looksLikeRealPage(bodySnippet)) {
      return { ok: false, reason: 'not_found', suspicious: true, note: '页面返回404但内容像正常页面，可能是假404' };
    }
    return { ok: false, reason: 'not_found' };
  }
  // 5xx 服务器错误：服务器明确返回 5xx 通常意味着真死（站挂了 / CDN 长期故障）
  // —— 但若响应体看起来像正常页面（罕见，假错误页），仍标可疑保守保留。
  if (status >= 500) {
    const isFake = looksLikeRealPage(bodySnippet);
    if (isFake) {
      return { ok: false, reason: 'http_server_error', suspicious: true, note: '服务器错误但响应体含正常内容，可能是假错误' };
    }
    // 真 5xx 错误页 → 直接判死（用户反馈：5xx 几乎都是真死，不再保守标可疑）
    return { ok: false, reason: 'http_server_error', note: `服务器返回 ${status}，站点真死或长期故障` };
  }
  if (status >= 400 && status < 500) return { ok: false, reason: 'http_client_error' };
  return { ok: false, reason: 'unknown' };
}

// 两层并发限制：全局上限 + 每主机上限
class Limiter {
  constructor(global, perHost) {
    this.global = global; this.perHost = perHost;
    this.active = 0; this.hostActive = new Map(); this.queue = [];
  }
  acquire(host) {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        const ha = this.hostActive.get(host) || 0;
        if (this.active < this.global && ha < this.perHost) {
          this.active++; this.hostActive.set(host, ha + 1);
          resolve(() => this.release(host));
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
  release(host) {
    this.active--;
    const ha = (this.hostActive.get(host) || 0) - 1;
    if (ha <= 0) this.hostActive.delete(host); else this.hostActive.set(host, ha);
    if (this.queue.length) this.queue.shift()();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 批量检测书签链接（worker 池 + 队列模型，支持中止）。
 * @param {Array} bookmarks 解析出的书签列表
 * @param {object} opts {concurrency, perHost, timeout, retries, cache, abort, paused, signal}
 *        abort:  () => boolean  返回 true 时尽快停止（已取出的任务仍会完成，不再取新任务）
 *        paused: () => boolean  返回 true 时挂起（worker 空闲等待，恢复后继续，不丢进度）
 * @param {object} handlers {onResult, onProgress}
 * @returns {Map} url -> 检测结果（中止时返回已完成的部分结果）
 */
export async function checkAll(bookmarks, opts = {}, handlers = {}) {
  const { concurrency = 25, perHost = 6, timeout = 8000, retries = 1, cache = null, abort = () => false, paused = () => false, skip = null } = opts;
  const limiter = new Limiter(concurrency, perHost);
  const total = bookmarks.length;
  // 断点续扫：skip 为已完成结果 Map(url->result)，预填入并计入已完成数，worker 不再重复探测
  const results = new Map();
  if (skip && skip.size) {
    for (const [u, r] of skip) results.set(u, r);
  }
  let done = results.size;
  // 队列只保留未完成的书签（已完成的直接跳过，不重复探测也不重复计数）
  const queue = skip && skip.size
    ? bookmarks.filter((b) => !results.has(b.url))
    : bookmarks.slice();

  // 共享中止控制器：100ms 间隔轮询 abort()，触发后立即销毁所有 in-flight socket
  // —— 仅靠 AbortSignal 在某些场景下反应慢（如目标服务器半开 TCP 连接），强制 destroy
  // agent 上所有 socket 可立即断开。
  const runAbort = new AbortController();
  const abortWatcher = setInterval(() => {
    if (!abort()) return;
    runAbort.abort();
    // 强制销毁所有 keep-alive 池中的 socket，使 lib.request 立即触发 error 事件
    try { httpAgent.destroy(); } catch {}
    try { httpsAgent.destroy(); } catch {}
    try { httpProxyAgent?.destroy?.(); } catch {}
    try { httpsProxyAgent?.destroy?.(); } catch {}
    console.log('[check] abort 触发：signal abort + 4 agents destroyed');
  }, 100);
  const finish = () => { clearInterval(abortWatcher); };

  // 暂停挂起：paused() 为真时 worker 以 200ms 间隔空转等待，恢复后继续；
  // abort 优先——即使处于暂停态，一旦 abort() 为真也立即放行以便收尾。
  const waitIfPaused = () => new Promise((resolve) => {
    if (!paused() || abort()) return resolve();
    const iv = setInterval(() => {
      if (!paused() || abort()) { clearInterval(iv); resolve(); }
    }, 200);
  });

  const worker = async () => {
    while (true) {
      if (abort()) break;
      await waitIfPaused();
      if (abort()) break;
      const bm = queue.shift();
      if (!bm) break;
      const url = bm.url;
      if (cache) {
        const cached = await cache.get(url);
        if (cached && Date.now() - (cached.checkedAt || 0) < (cache.ttl || 7 * 864e5)) {
          results.set(url, cached);
          done++;
          handlers.onProgress?.(done, total, bm, cached);
          continue;
        }
      }
      const release = await limiter.acquire(hostOf(url));
      if (abort()) { release?.(); break; }
      let result = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (abort()) break; // 重试前检查：避免在 sleep/probe 中无意义重试
        try {
          const raw = await probe(url, { timeout }, runAbort.signal);
          result = { status: raw.status, finalUrl: raw.finalUrl, redirectChain: raw.redirectChain, error: raw.reason ? { code: raw.reason } : null };
          break;
        } catch (e) {
          const code = e?.code || (e?.name === 'AbortError' ? 'AbortError' : '');
          if (code === 'AbortError' || abort()) { release(); finish(); return; } // 被中断，直接收尾
          result = { status: 0, finalUrl: url, redirectChain: [], error: e };
          if (attempt < retries) {
            // 重试前先响应暂停：暂停态下不空耗 sleep
            await waitIfPaused();
            if (abort()) { release(); finish(); return; }
            // sleep 期间也响应 abort —— 避免 sleep 期间被 cancel 时仍要等 250ms+
            await Promise.race([
              sleep(250 * (attempt + 1)),
              new Promise((resolve) => {
                const checkAbort = setInterval(() => {
                  if (abort()) { clearInterval(checkAbort); resolve(); }
                }, 50);
              }),
            ]);
          }
        }
      }
      release();
      const cls = classify(result.status, result.error, result.bodySnippet);
      const finalResult = {
        url,
        status: result.status,
        finalUrl: result.finalUrl,
        ok: cls.ok,
        reason: cls.reason,
        suspicious: !!cls.suspicious,
        note: cls.note || null,
        redirectChain: result.redirectChain || [],
        checkedAt: Date.now(),
      };
      // 诊断日志：真机排查“浏览器能开却标红”时用
      const errCode = result.error ? (result.error.code || result.error.message || String(result.error)) : null;
      console.log(`[check] ${url} => status:${result.status} ok:${cls.ok} reason:${cls.reason} suspicious:${!!cls.suspicious} err:${errCode}`);
      results.set(url, finalResult);
      if (cache) await cache.set(url, finalResult);
      done++;
      handlers.onResult?.(bm, finalResult);
      handlers.onProgress?.(done, total, bm, finalResult);
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, total || 1));
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    finish();
  }
  return results;
}

export default { checkAll, classify, probe };
