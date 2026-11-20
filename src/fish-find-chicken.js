// 菲比找鸡：被引图片 → 反查来源 → 抽 coser 社媒账号 → 回一句话（有账号时顺带「已找到鸡」图）。
//
// 设计要点（都是踩过才知道的）：
//   · 引擎能力差别极大：SauceNAO 是唯一「无 key、纯 HTTP、直连可达」的，其余三家
//     （yandex/bing/baidu）的直连接口全是空壳或被拒，必须真浏览器跑 DOM。
//     所以：业务只读 state/fish-find-engines.json 决定用谁，探针没跑过就只开 saucenao。
//   · 浏览器是**单例**：headless Edge 起来一次、复用一个 page、一次只跑一个引擎。
//     每次命令新开浏览器既慢又会漏进程（验收第 7 条就是查这个）。
//   · 出站请求一律走 safeFetch（防 SSRF）或白名单里的固定 POST；候选页面的 og/作者
//     信息同样走 safeFetch。绝不把用户图片发到白名单外的域名。
//   · 这个模块零 token：它不碰 DSH、不建会话、不写 social-v2。桥接那边只做接线。

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { safeFetch, validateFetchUrl } from './safe-fetch.js';
import { loadSearchConfig, deepseekSearch } from './web-search.js';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 给 inferAccounts 用的搜索函数（复用 DSH 那一套 DeepSeek 搜索，不新增 key）。 */
/** 必应的搜索结果链接会包一层 `bing.com/ck/a?…&u=a1<base64url>`，这里还原成真实地址。 */
export function decodeBingHref(href) {
  const raw = String(href ?? '');
  const m = raw.match(/[?&]u=a1([^&]+)/);
  if (!m) return raw;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : raw;
  } catch {
    return raw;
  }
}

/** 把必应页面上抓到的 (href,text) 列表洗成 [{url,title}]：解包、去重、去掉必应自家链接。 */
export function parseBingSearchLinks(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const url = decodeBingHref(item?.href ?? item?.url ?? '');
    if (!/^https?:\/\//i.test(url)) continue;
    const host = hostOf(url);
    if (!host || host.endsWith('bing.com') || host.endsWith('microsoft.com')) continue;
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, title: trimText(String(item?.text ?? ''), 160) });
  }
  return out;
}

/**
 * 兜底搜索：没有可用的 DeepSeek key 时，用已经在用的无头 Edge 直接读必应结果页。
 * 慢（约 4~8 秒一次），但不需要任何 key，而且能真的给出 `x.com/<handle>` 这种链接。
 */
export async function bingWebSearch(query, { timeoutMs = 20000, exe } = {}) {
  const q = encodeURIComponent(trimText(String(query ?? ''), 200));
  if (!q) return [];
  const url = `https://www.bing.com/search?q=${q}&setlang=zh-Hans&mkt=zh-CN`;
  const expression = `(() => {
    const anchors = Array.from(document.querySelectorAll('#b_results a[href]')).slice(0, 80);
    return JSON.stringify(anchors.map((a) => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 120) })));
  })()`;
  const raw = await browserProbe(url, expression, { timeoutMs, settleMs: 1200, exe });
  let list = [];
  try {
    list = JSON.parse(String(raw ?? '[]'));
  } catch {
    list = [];
  }
  return parseBingSearchLinks(list);
}

/** 谷歌结果页的链接是 `/url?q=<真实地址>&sa=…`，这里还原；自家链接（google.*、gstatic）丢掉。 */
export function parseGoogleSearchLinks(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    let url = String(item?.href ?? item?.url ?? '');
    const wrapped = url.match(/^\/url\?q=([^&]+)/) || url.match(/[?&]url=([^&]+)/);
    if (wrapped) {
      try {
        url = decodeURIComponent(wrapped[1]);
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const host = hostOf(url);
    if (!host || /(^|\.)google\./.test(host) || host.endsWith('gstatic.com') || host.endsWith('googleusercontent.com')) continue;
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, title: trimText(String(item?.text ?? ''), 160) });
  }
  return out;
}

/**
 * 谷歌搜索（需要魔法）。国内网络下必应/360 会刻意不返回 `x.com` 链接，
 * 所以「用作者名反查推特」这条路只能走谷歌 —— 由调用方套 withVpn 使用。
 */
export async function googleWebSearch(query, { timeoutMs = 25000, exe } = {}) {
  const q = encodeURIComponent(trimText(String(query ?? ''), 200));
  if (!q) return [];
  const url = `https://www.google.com/search?q=${q}&hl=zh-CN&num=20`;
  const expression = `(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]')).slice(0, 200);
    return JSON.stringify(anchors.map((a) => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 120) })));
  })()`;
  const raw = await browserProbe(url, expression, { timeoutMs, settleMs: 1200, exe });
  let list = [];
  try {
    list = JSON.parse(String(raw ?? '[]'));
  } catch {
    list = [];
  }
  return parseGoogleSearchLinks(list);
}

/** 结果里有没有「像账号」的链接（推特/微博/B站/ins/pixiv）。用来判断要不要再上谷歌。 */
export function hasPlatformResult(rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (matchPlatform(row?.url)) return true;
  }
  return false;
}

export function createSearchFn(root = MODULE_ROOT, { withVpn = null, onLog = null } = {}) {
  let config = null;
  let preferBing = false;
  return async (query) => {
    if (!config) config = loadSearchConfig(root);
    const text = String(query);
    if (!preferBing) {
      try {
        const results = await deepseekSearch(text, config);
        if (Array.isArray(results) && results.length) return results;
      } catch (error) {
        const code = String(error?.code ?? '');
        // 没 key / 认证失败：以后都走必应；其它错误（超时、429）这次先退必应，下次再试 DeepSeek
        if (code === 'NO_KEY' || code === 'HTTP_401' || code === 'HTTP_403') preferBing = true;
        else if (!code && !/没有可用的/.test(String(error?.message ?? ''))) throw error;
      }
    }
    let rows = [];
    try {
      rows = await bingWebSearch(text);
    } catch (error) {
      if (onLog) onLog(`[菲比找鸡] 必应搜索失败：${error?.message ?? error}`);
    }
    // 必应在中国区不返回推特链接 —— 一个平台链接都没有时，套上魔法再问谷歌
    if (!hasPlatformResult(rows) && typeof withVpn === 'function') {
      try {
        const viaGoogle = await withVpn(() => googleWebSearch(text));
        if (Array.isArray(viaGoogle) && viaGoogle.length) {
          if (onLog) onLog(`[菲比找鸡] 谷歌搜索给了 ${viaGoogle.length} 条（走魔法）`);
          return viaGoogle;
        }
      } catch (error) {
        if (onLog) onLog(`[菲比找鸡] 谷歌搜索失败：${error?.message ?? error}`);
      }
    }
    return rows;
  };
}

export const ENGINE_IDS = ['saucenao', 'lens', 'yandex', 'bing', 'baidu', 'google', 'iqdb', 'tracemoe', 'ai'];

// 只允许把图发给这几个域名（写死在代码里，不读配置 —— 这是安全边界，不是可调项）。
// 2026-10-29 加：iqdb.org（动漫图库）、api.trace.moe（动画截图）。
// ascii2d 试过但被 Cloudflare 拦（headless 永远停在「正在进行安全验证」），不列进来。
const UPLOAD_HOSTS = [
  'saucenao.com', 'yandex.com', 'yandex.ru', 'bing.com', 'baidu.com', 'google.com', 'lens.google.com',
  'iqdb.org', 'trace.moe',
  // 搜索类（只在 need-search 的场合用：必应/谷歌/DDG/Brave/Startpage）
  'duckduckgo.com', 'brave.com', 'startpage.com'
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const BROWSER_ENGINES = new Set(['yandex', 'bing', 'baidu', 'google']);

// 3：新增 Google Lens 渠道。缓存 key 里带版本号，升版本等于让旧缓存（只查 SauceNAO 的结果）
// 全部失效 —— 否则同一张图会一直吃老结果，看起来「改了跟没改一样」。
// 5：结果排序改成「按引擎给的位次」+ 补小红书/抖音/Threads/Bluesky 等平台；
//    旧缓存里存的是按老规则筛过的账号（真图源被丢掉的正是它），必须整体失效。
export const ENGINES_VERSION = 12;

// ── 小工具 ────────────────────────────────────────────────────────────────
// 计时器不 unref：unref 后独自跑脚本时会「事件循环空了」直接退出（exit 13）。
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

function hostAllowed(url) {
  const host = hostOf(url);
  if (!host) return false;
  return UPLOAD_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absUrl(href, base) {
  try { return new URL(decodeEntities(href), base).toString(); } catch { return ''; }
}

function trimText(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── 单例 headless 浏览器（零依赖，裸驱 CDP） ────────────────────────────────
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

let browserState = null; // { proc, userDataDir, port, ws, pageId, nextId, pending }
// 用固定 profile：谷歌这类站点会把「已验证」写进 cookie，临时目录一关就全丢。
const BROWSER_PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state', 'fish-find-profile');
// 无头 Edge 的默认 UA 里带 HeadlessChrome，谷歌一眼就判机器人，改成一个正常的 Chrome UA。
const BROWSER_UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
let browserStarting = null;

function resolveBrowserExe(exe) {
  if (exe && fs.existsSync(exe)) return exe;
  for (const candidate of BROWSER_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  return '';
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (text) return text;
      }
    } catch {}
    await sleep(120);
  }
  throw new Error('浏览器没起来（等不到 DevToolsActivePort）');
}

async function startBrowser({ timeoutMs = 25000, exe, headed = false, profileDir = '', proxy = '' } = {}) {
  const exePath = resolveBrowserExe(exe);
  if (!exePath) throw new Error('找不到 Edge/Chrome 可执行文件');
  const userDataDir = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'fish-find-browser-'));
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch {}
  // 上一次留下的 DevToolsActivePort 是过期值，留着会连到死端口
  try { fs.rmSync(path.join(userDataDir, 'DevToolsActivePort'), { force: true }); } catch {}
  const args = [
    ...(headed ? [] : ['--headless=new']),
    '--disable-gpu',
    // 服务器以 root 运行，Chromium 必须显式关闭沙箱；/dev/shm 小的时候也要关
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    // 不下载组件（WasmTtsEngine/WidevineCdm/CRX 缓存），光这些就占 profile 100M+
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--lang=zh-CN',
    `--user-agent=${BROWSER_UA_CHROME}`,
    ...(proxy ? [`--proxy-server=${proxy}`] : []),
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ];
  // Linux 上必须 detached：chromium 会派生 zygote/GPU/renderer 一串子进程，
  // 只 kill 主进程会留下一屋子占着 profile 的孤儿（真实踩过，19 个进程活了三天）。
  const proc = spawn(exePath, args, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const raw = await waitForFile(portFile, timeoutMs);
  const port = Number(String(raw).split(/\r?\n/)[0]);
  if (!Number.isFinite(port) || port <= 0) throw new Error('DevToolsActivePort 内容异常');

  // 拿一个 page target 的 ws 地址
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
      const list = await response.json();
      target = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
    } catch {}
    if (!target) await sleep(150);
  }
  if (!target) throw new Error('浏览器没有可用的 page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', (event) => { clearTimeout(timer); reject(new Error('CDP 连接失败')); });
  });
  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
    if (!msg?.id) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message || 'CDP 错误'));
    else entry.resolve(msg.result);
  });
  await opened;

  browserState = {
    proc, userDataDir, port, ws, pending, proxy,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        // 页面正在跳转 / 目标进程卡死时，CDP 可能永远不回 —— 没有这个超时，
        // 一条 evaluate 就能把整个任务挂住十几分钟（真实踩过）。
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }, 25000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); }
        });
        try { ws.send(JSON.stringify({ id, method, params })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    }
  };
  return browserState;
}

let browserProxyUrl = ''; // 这次任务要不要让浏览器单独走代理（--proxy-server）
export function setBrowserProxy(url) { browserProxyUrl = String(url ?? ''); }
export function currentBrowserProxy() { return browserProxyUrl; }

async function ensureBrowser(options = {}) {
  // 代理通道是启动参数（--proxy-server），起来之后改不了：换了通道只能重开浏览器。
  const wantProxy = String(options.proxy ?? browserProxyUrl ?? '');
  if (browserState) {
    if (String(browserState.proxy ?? '') === wantProxy) return browserState;
    await closeBrowser();
  }
  if (!browserStarting) {
    browserStarting = (async () => {
      try {
        return await startBrowser({ ...options, proxy: wantProxy, profileDir: BROWSER_PROFILE_DIR });
      } catch {
        // 固定 profile 被占用/损坏时就退回临时目录：宁可丢 cookie，也不能让整条命令失败
        return await startBrowser({ ...options, proxy: wantProxy, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fish-find-browser-')) });
      }
    })().finally(() => { browserStarting = null; });
  }
  return browserStarting;
}

export async function closeBrowser() {
  const state = browserState;
  browserState = null;
  if (!state) return;
  try { state.ws.close(); } catch {}
  if (process.platform === 'win32') {
    // Edge/Chrome 在 Windows 会派生一堆子进程，只 kill 主进程会留下占着 profile 的孤儿
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync('taskkill', ['/PID', String(state.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {}
    try { state.proc.kill(); } catch {}
  } else {
    // Linux：spawn 时是 detached， pid 就是进程组 id，整组一起杀
    try { process.kill(-state.proc.pid, 'SIGKILL'); } catch {}
    try { state.proc.kill('SIGKILL'); } catch {}
  }
}

export function browserRunning() {
  return Boolean(browserState);
}

/**
 * 清扫上一轮遗留的浏览器孤儿。
 * 进程被 SIGKILL / 插件超时掐掉时，finally 跑不到，chromium 就留下来了；
 * 它们攥着 profile 目录，下一次启动反而更容易失败。Linux 上按 /proc 扫一遍。
 */
export function killStaleBrowsers({ minAgeMs = 15 * 60 * 1000 } = {}) {
  if (process.platform === 'win32') return 0;
  let killed = 0;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return 0; }
  const self = String(process.pid);
  // 只杀「老」孤儿：并发的另一条命令可能正在用浏览器，别误伤
  let uptime = 0;
  try { uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]); } catch {}
  const ageMs = (pid) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // 第 22 个字段是 starttime（开机后的 clock ticks），进程名可能带空格，从最后一个 ')' 之后切
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const startTicks = Number(rest[19]);
      if (!Number.isFinite(startTicks)) return 0;
      return (uptime - startTicks / 100) * 1000;
    } catch { return 0; }
  };
  for (const pid of pids) {
    if (pid === self) continue;
    let cmdline = '';
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmdline.includes('chromium') || !cmdline.includes(BROWSER_PROFILE_DIR)) continue;
    if (ageMs(pid) < minAgeMs) continue;
    try { process.kill(Number(pid), 'SIGKILL'); killed += 1; } catch {}
  }
  return killed;
}

/** 清掉 profile 里可以再生的组件缓存（CRX/Widevine/TTS 之类，几十上百 M）。 */
export function pruneProfileCache() {
  if (process.platform === 'win32') return;
  const junk = ['component_crx_cache', 'WasmTtsEngine', 'WidevineCdm', 'CertificateRevocation', 'OnDeviceHeadSuggestModel', 'BrowserMetrics-spare.pma'];
  for (const name of junk) {
    const target = path.join(BROWSER_PROFILE_DIR, name);
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
}

// 用浏览器打开一个页面并取回 DOM。串行（一个 page，一次一个引擎）。
async function browserHtml(url, { timeoutMs = 25000, exe } = {}) {
  if (!hostAllowed(url)) throw new Error(`域名不在白名单：${hostOf(url)}`);
  const state = await ensureBrowser({ timeoutMs, exe });
  await state.send('Page.enable');
  const loaded = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.min(timeoutMs, 20000));
    const onMessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg?.method === 'Page.loadEventFired') { clearTimeout(timer); resolve(true); }
    };
    state.ws.addEventListener('message', onMessage);
    setTimeout(() => state.ws.removeEventListener('message', onMessage), Math.min(timeoutMs, 20000) + 500);
  });
  const nav = await state.send('Page.navigate', { url });
  if (nav?.errorText) throw new Error(`打开页面失败：${nav.errorText}`);
  await loaded;
  // 站点多半是 JS 渲染，等一小会儿再取 DOM
  await sleep(1200);
  const result = await state.send('Runtime.evaluate', {
    expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
    returnByValue: true
  });
  return String(result?.result?.value ?? '');
}

// ── 临时公网图床（只在配置里打开时才用）────────────────────────────────────
//
// 为什么需要：必应/谷歌/ Яндекс 的以图搜图只吃「公网能访问的图片地址」，
// QQ 的图片是带 rkey 的内网链接，传不上去。所以要做真人照片这一块，
// 只能先把图放一个几分钟后失效的临时地址上。**默认关闭**，由用户在 config.json 里开。
const PUBLIC_HOST_PROVIDERS = {
  // litterbox = catbox 的临时版，自带过期时间（默认 1 小时），是这台机器上唯一通的图床。
  // 实测：0x0.st / telegra.ph / tmpfiles 连不上（CONNECT_TIMEOUT / ECONNRESET），
  // catbox 长期版 TLS 被掐，只有 litterbox 能传。
  litterbox: {
    url: 'https://litterbox.catbox.moe/resources/internals/api.php',
    build(bytes, mimeType, filename, ttl) {
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      form.append('time', String(ttl || '1h'));
      form.append('fileToUpload', new Blob([bytes], { type: mimeType || 'image/jpeg' }), filename);
      return { form, headers: { Accept: 'text/plain' } };
    }
  },
  // 2026-11 实测：uguu 502、litterbox 超时、tmpfiles 的 /dl/ 直链 403；
  // pomf2 用 files[] 字段能穿，返回的是真·图片直链，适合喂给 SerpAPI。
  pomf2: {
    url: 'https://pomf2.lain.la/upload.php',
    build(bytes, mimeType, filename) {
      const form = new FormData();
      form.append('files[]', new Blob([bytes], { type: mimeType || 'image/jpeg' }), filename);
      return { form, headers: { Accept: 'application/json' } };
    }
  }
};

/** 把图片传到临时图床，返回公网 URL。失败抛错（调用方决定是否降级）。 */
/**
 * 自建图床：直接把图写进本机 nginx 的站点根目录，再用公网地址把它交给 SerpAPI。
 *
 * 为什么需要它：2026-11 实测 pomf2（UND_ERR_SOCKET 断连）、uguu（502）、catbox（连接超时）、
 * tmpfiles（不返地址）、0x0.st（明说因 AI 爬虫关闭上传）——第三方免费图床整体不可靠，
 * 图床一挂，Yandex / Google Lens 这两条最强的通道就整条废掉，而它们只吃公网 URL。
 * 本机 nginx 反正开着 80 口，写进去就能被拉，零成本、零延迟、完全可控：
 * 随机文件名（猜不到）+ 10 分钟后自删（不会长期留在盘上）。
 * 路径与地址可用环境变量覆盖，换机器时不用改代码。
 */
const SELF_HOST_DIR = process.env.FISH_SELF_HOST_DIR || '/var/www/html';
// 发布版默认留空：不配地址就不启用自建图床，自动回落到公共图床。
// 自建时把 FISH_SELF_HOST_BASE 设成站点根地址，例如 https://img.example.com
const SELF_HOST_BASE = String(process.env.FISH_SELF_HOST_BASE || '').replace(/\/+$/, '');
const SELF_HOST_TTL_MS = 10 * 60 * 1000;

async function publishToSelfHost(bytes, mimeType) {
  if (!SELF_HOST_BASE) throw new Error('没有配置自建图床地址（FISH_SELF_HOST_BASE），跳过');
  const ext = /png/i.test(String(mimeType ?? '')) ? 'png' : 'jpg';
  const name = `fish-${crypto.randomBytes(9).toString('hex')}.${ext}`;
  const dest = path.join(SELF_HOST_DIR, name);
  fs.writeFileSync(dest, bytes);
  try { fs.chmodSync(dest, 0o644); } catch {}
  const timer = setTimeout(() => {
    try { fs.rmSync(dest, { force: true }); } catch {}
  }, SELF_HOST_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return `${SELF_HOST_BASE}/${name}`;
}

export async function uploadPublicImage(bytes, mimeType, { provider = 'litterbox', timeoutMs = 30000, filename = 'fish-find.jpg', ttl = '1h' } = {}) {
  // 图床是这条链路上最脆的一环：2026-11 实测 0x0.st（关闭上传）、uguu（502）、
  // catbox 长期版（TLS 被切断）、litterbox（超时）都不行，只剩 pomf2 能用，
  // 而 pomf2 在连传十几张时会回 429。所以这里做两件事：
  //   ① 同一个图床失败等一会儿重试一次（429 基本是瞬时限流）；
  //   ② 换个图床再试 —— 死一个不影响整次查询。
  let lastError = null;
  // 本机图床优先：不欠任何人限流、也不怕人家哪天把上传关了
  if (provider === 'selfhost' || provider === 'auto') {
    try {
      return await publishToSelfHost(bytes, mimeType);
    } catch (error) {
      lastError = error;
    }
  }
  const chain = [provider, 'pomf2', 'litterbox'].filter((name, index, arr) => name && arr.indexOf(name) === index);
  for (const name of chain) {
    const spec = PUBLIC_HOST_PROVIDERS[name];
    if (!spec) continue;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { form, headers } = spec.build(bytes, mimeType, filename, ttl);
        const response = await fetch(spec.url, {
          method: 'POST',
          body: form,
          headers: { 'User-Agent': BROWSER_UA, ...headers },
          signal: AbortSignal.timeout(timeoutMs)
        });
        const text = (await response.text()).trim();
        if (!response.ok) {
          lastError = new Error(`图床 ${name} HTTP ${response.status}`);
          // 429/5xx 值得等一下再试；4xx 的其它情况换图床更有用
          if (response.status === 429 || response.status >= 500) {
            await sleep(1500 * (attempt + 1));
            continue;
          }
          break;
        }
        let url = '';
        try {
          const parsed = JSON.parse(text);
          url = parsed?.files?.[0]?.url || parsed?.data?.url || parsed?.url || '';
        } catch {
          // 不是 JSON 的老图床，退回从文本里抓 URL
        }
        if (!url) url = (text.match(/https?:\/\/\S+/) ?? [])[0] ?? '';
        if (/^https?:\/\//.test(url)) return url;
        lastError = new Error(`图床 ${name} 没返回地址：${trimText(text, 80)}`);
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(1200);
      }
    }
  }
  throw lastError ?? new Error('所有图床都传不上去');
}

// ── 各引擎适配器 ──────────────────────────────────────────────────────────

/** 打开一个页面并执行一段 JS 取回结果（探针用：看站点结构、找选择器）。 */
export async function browserProbe(url, expression, { timeoutMs = 30000, settleMs = 2000, exe } = {}) {
  if (!hostAllowed(url)) throw new Error(`域名不在白名单：${hostOf(url)}`);
  const state = await ensureBrowser({ timeoutMs, exe });
  await state.send('Page.enable');
  const loaded = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.min(timeoutMs, 25000));
    const onMessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg?.method === 'Page.loadEventFired') { clearTimeout(timer); resolve(true); }
    };
    state.ws.addEventListener('message', onMessage);
    setTimeout(() => state.ws.removeEventListener('message', onMessage), Math.min(timeoutMs, 25000) + 500);
  });
  const nav = await state.send('Page.navigate', { url });
  if (nav?.errorText) throw new Error(`打开页面失败：${nav.errorText}`);
  await loaded;
  await sleep(settleMs);
  const result = await state.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result?.result?.value;
}

/**
 * 用真浏览器打开一个页面、把本地图片塞进 <input type=file>，再等结果页落地取 DOM。
 * 有些站（百度识图这类）只认「页面上真选了一个文件」，用 fetch 拼 multipart 会被判据非法
 * （graph.baidu.com 一律回 `{"status":1002,"msg":"Params illegal"}`），所以必须走这条路。
 */
export async function browserFileUploadHtml({ startUrl, filePath, fileSelector = 'input[type=file]', timeoutMs = 30000, settleMs = 4000, prepareExpression = '', submitExpression = '', waitForExpression = '', extractExpression = '', exe } = {}) {
  if (!hostAllowed(startUrl)) throw new Error(`域名不在白名单：${hostOf(startUrl)}`);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('上传用的临时图片不存在');
  const state = await ensureBrowser({ timeoutMs, exe });
  await state.send('Page.enable');
  await state.send('DOM.enable');
  const loaded = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.min(timeoutMs, 25000));
    const onMessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg?.method === 'Page.loadEventFired') { clearTimeout(timer); resolve(true); }
    };
    state.ws.addEventListener('message', onMessage);
    setTimeout(() => state.ws.removeEventListener('message', onMessage), Math.min(timeoutMs, 25000) + 500);
  });
  const nav = await state.send('Page.navigate', { url: startUrl });
  if (nav?.errorText) throw new Error(`打开页面失败：${nav.errorText}`);
  await loaded;
  // 有些站点（谷歌 Lens 的 v3/upload）没有页面上的上传入口，得自己塞一个 form：
  // 用 prepareExpression 在页面里造出 <input type=file>，再走同一条「真选文件」的路。
  if (prepareExpression) {
    try { await state.send('Runtime.evaluate', { expression: prepareExpression, returnByValue: true, awaitPromise: true }); } catch {}
    await sleep(300);
  }
  const nodeIdByObject = async () => {
    try {
      const evaluated = await state.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(fileSelector)})` });
      const objectId = evaluated?.result?.objectId;
      if (!objectId) return 0;
      const node = await state.send('DOM.requestNode', { objectId });
      return Number(node?.nodeId) || 0;
    } catch { return 0; }
  };

  // 等 input 出现（JS 渲染的站点要等）
  const deadline = Date.now() + Math.min(timeoutMs, 20000);
  let nodeId = 0;
  while (Date.now() < deadline) {
    if (prepareExpression) {
      nodeId = await nodeIdByObject();
      if (nodeId) break;
    }
    const doc = await state.send('DOM.getDocument', { depth: 2, pierce: false });
    const found = await state.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: fileSelector });
    if (found?.nodeId) { nodeId = found.nodeId; break; }
    await sleep(400);
  }
  if (!nodeId) throw new Error(`页面上找不到 ${fileSelector}（站点结构变了或需要交互）`);
  // 记下当前 URL：上传成功后通常会发生跳转，用「URL 变了」当第一条信号。
  const beforeUrl = String((await state.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))?.result?.value ?? '');
  await state.send('DOM.setFileInputFiles', { files: [filePath], nodeId });
  if (submitExpression) {
    try { await state.send('Runtime.evaluate', { expression: submitExpression, returnByValue: true }); } catch {}
  }
  // 等结果：优先等 waitForExpression 变真；否则等一次 navigation/load 再 settle。
  if (waitForExpression) {
    const waitDeadline = Date.now() + Math.min(timeoutMs, 30000);
    while (Date.now() < waitDeadline) {
      try {
        const probe = await state.send('Runtime.evaluate', { expression: waitForExpression, returnByValue: true });
        if (probe?.result?.value) break;
      } catch { /* 跳转中的一瞬间页面上下文会消失，忽略继续等 */ }
      await sleep(500);
    }
    // 条件满足只代表「壳子在了」，结果卡片是异步渲染的，再给一段固定渲染时间
    await sleep(settleMs);
  } else {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(timeoutMs, 25000));
      const onMessage = (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        if (msg?.method !== 'Page.loadEventFired') return;
        clearTimeout(timer);
        state.ws.removeEventListener('message', onMessage);
        setTimeout(resolve, settleMs);
      };
      state.ws.addEventListener('message', onMessage);
    });
    // 页面没跳转（纯 JS 上传）也要给渲染时间
    const afterUrl = String((await state.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))?.result?.value ?? '');
    if (afterUrl === beforeUrl) await sleep(settleMs);
  }
  const result = await state.send('Runtime.evaluate', {
    expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
    returnByValue: true
  });
  const html = String(result?.result?.value ?? '');
  const url = String((await state.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))?.result?.value ?? '');
  if (extractExpression) {
    const extracted = await state.send('Runtime.evaluate', { expression: extractExpression, returnByValue: true, awaitPromise: true });
    return { html, url, data: extracted?.result?.value };
  }
  return { html, url };
}

/**
 * 不带文件地打开一个页面、等它渲染完、把结果交回来。
 * Lens 的「完全匹配」标签页就是在同一个结果页上换 udm 参数，所以需要这个轻量版本。
 */
export async function browserVisit({ url, waitForExpression = '', settleMs = 2200, extractExpression = '', timeoutMs = 30000, exe } = {}) {
  if (!hostAllowed(url)) throw new Error(`域名不在白名单：${hostOf(url)}`);
  const state = await ensureBrowser({ timeoutMs, exe });
  await state.send('Page.enable');
  const nav = await state.send('Page.navigate', { url });
  if (nav?.errorText) throw new Error(`打开页面失败：${nav.errorText}`);
  const condition = waitForExpression || 'document.readyState === "complete"';
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  while (Date.now() < deadline) {
    try {
      const probe = await state.send('Runtime.evaluate', { expression: condition, returnByValue: true });
      if (probe?.result?.value) break;
    } catch { /* 跳转中的一瞬间页面上下文会消失，忽略继续等 */ }
    await sleep(400);
  }
  await sleep(settleMs);
  const html = String((await state.send('Runtime.evaluate', {
    expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
    returnByValue: true
  }))?.result?.value ?? '');
  const finalUrl = String((await state.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))?.result?.value ?? '');
  if (!extractExpression) return { html, url: finalUrl };
  const extracted = await state.send('Runtime.evaluate', { expression: extractExpression, returnByValue: true, awaitPromise: true });
  return { html, url: finalUrl, data: extracted?.result?.value };
}

// ── Google Lens ───────────────────────────────────────────────────────────
// 移植自 koishi-plugin-imgsearch-coser（WhiteBr1ck）的核心思路：找 coser 最准的一条路是
// Google Lens 反查图片，结果里往往直接是原帖（x.com/xxx/status/…）。
// 它没有公开 JSON 接口，只有 lens.google.com/v3/upload 这个「POST 图片 → 302 到结果页」的网页接口。
// fetch 会踩 CORS，所以这里用真浏览器在页面里造一个 form 去 POST：浏览器天然走系统代理（魔法在线时
// 才通），也天然带着谷歌自己的 cookie。
export const LENS_EXTRACT = `(() => {
  const isGoogle = (host) => /(^|\\.)google\\.[a-z.]+$/i.test(host);
  const isAsset = (host) => /(^|\\.)(gstatic|googleusercontent)\\.com$/i.test(host);
  const cleanTitle = (node) => {
    const heading = node.querySelector('h1,h2,h3,[role=heading]');
    const text = String(
      (heading && heading.textContent) ||
      node.getAttribute('aria-label') ||
      node.textContent || ''
    ).replace(/\\s+/g, ' ').trim();
    return text.slice(0, 200);
  };
  const rows = [];
  const cards = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.closest('header, footer, nav, [role=navigation]')) continue;
    const raw = a.getAttribute('href') || '';
    let u;
    try { u = new URL(raw, location.href); } catch (e) { continue; }
    if (u.protocol !== 'https:') continue;
    const title = cleanTitle(a);
    if (!title) continue;
    // 谷歌视觉搜索的结果卡片全是 /goto?url=<不透明 token>：真实域名只有浏览器自己知道，
    // 交给外面用 CDP 请求拦截去解（页面里 fetch 会吃 CORS）。
    if (isGoogle(u.hostname) && u.pathname === '/goto' && u.searchParams.get('url')) {
      if (cards.length < 24) cards.push({ wrapper: u.href, title });
      continue;
    }
    if (isGoogle(u.hostname) || isAsset(u.hostname)) {
      const wrapped = u.searchParams.get('url') || u.searchParams.get('q') || '';
      if (!/^https?:\\/\\//.test(wrapped) || seen.has(wrapped)) continue;
      seen.add(wrapped);
      rows.push({ url: wrapped, title });
      continue;
    }
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    rows.push({ url: u.href, title });
  }
  const bodyText = document.body ? document.body.innerText.slice(0, 4000) : '';
  return JSON.stringify({
    url: location.href,
    count: rows.length,
    cards: cards,
    results: rows,
    captcha: /unusual traffic|our systems have detected/i.test(bodyText) || /\\/sorry\\//.test(location.href),
    empty: /No matches|No results|找不到相符|没有找到|未找到/i.test(bodyText)
  });
})()`;

/**
 * 把 google 的 `/goto?url=<token>` 卡片解成真实域名。
 * 页面里 fetch 会被 CORS 挡死（跨域 302 → TypeError），所以让浏览器自己跳：
 * 开 Fetch 域拦请求，谷歌自己的请求放行，一旦出现非谷歌域名就记下来并中止加载 —— 不真的把目标页拉下来。
 */
async function resolveLensGoto(state, wrapperUrl, { timeoutMs = 12000 } = {}) {
  const isGoogleHost = (url) => {
    try { return /(^|\.)google\.[a-z.]+$/i.test(new URL(url).hostname); } catch { return true; }
  };
  try { await state.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); } catch { return ''; }
  const hit = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), timeoutMs);
    const onMessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg?.method !== 'Fetch.requestPaused') return;
      const requestId = msg.params?.requestId;
      const url = String(msg.params?.request?.url ?? '');
      if (!requestId) return;
      if (isGoogleHost(url)) {
        state.send('Fetch.continueRequest', { requestId }).catch(() => {});
        return;
      }
      clearTimeout(timer);
      state.ws.removeEventListener('message', onMessage);
      state.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {});
      resolve(url);
    };
    state.ws.addEventListener('message', onMessage);
    setTimeout(() => state.ws.removeEventListener('message', onMessage), timeoutMs + 500);
  });
  try { await state.send('Page.navigate', { url: wrapperUrl }); } catch {}
  const found = await hit;
  try { await state.send('Page.stopLoading'); } catch {}
  try { await state.send('Fetch.disable'); } catch {}
  return found;
}

// 只有这几类卡片值得多花时间解域名：真人 coser 的号基本只在社交平台上。
const LENS_SOCIAL_RE = /^(x|twitter|推特|instagram|ig|ins|微博|weibo|bilibili|哔哩|tiktok|抖音|facebook|fb|threads|xiaohongshu|小红书)/i;
// 已经解出真实域名时用它判断「这条是不是社交站点」，比看标题更可靠
const LENS_SOCIAL_HOST_RE = /^https?:\/\/(?:www\.|m\.)?(?:x|twitter|instagram|weibo|bilibili|tiktok|facebook|threads|xiaohongshu)\.(?:com|net)\//i;


/**
 * 图床上传（SerpAPI 只吃公网 URL）。用 uguu：tmpfiles 的 /dl/ 现在会 302 到 HTML 页。
 */
async function uploadForLens(bytes, mimeType) {
  const ext = /png/i.test(String(mimeType ?? '')) ? 'png' : 'jpg';
  // uguu 2026-11 起持续 502；改走 pomf2，返回的是真·图片直链。
  return uploadPublicImage(bytes, mimeType, {
    provider: 'selfhost',
    timeoutMs: 30000,
    filename: `fish-lens.${ext}`
  });
}

/**
 * 谷歌 Lens 的 SerpAPI 版（google_lens 引擎）。
 *
 * 为什么需要它：无头浏览器在本机的机房 IP 上被 Google 稳定弹验证码，
 * 而有 key 时 SerpAPI 能直接拿到 visual_matches。返回的候选结构与浏览器版对齐，
 * 交给 extractAccounts 继续做平台/账号识别。
 */
export async function serpApiLensSearch(bytes, mimeType, { apiKey, hl = 'zh-CN', timeoutMs = 45000, onLog } = {}) {
  if (!apiKey) throw new Error('没有配置 SerpAPI key');
  if (!bytes || !bytes.length) throw new Error('没有图片');
  const publicUrl = await uploadForLens(bytes, mimeType);
  onLog?.(`SerpAPI: ${publicUrl}`);
  const qs = new URLSearchParams({
    engine: 'google_lens',
    api_key: apiKey,
    url: publicUrl,
    hl,
    country: 'HK'
  });
  const res = await fetch(`https://serpapi.com/search?${qs.toString()}`, {
    signal: AbortSignal.timeout(Math.max(timeoutMs, 45000))
  });
  if (res.status >= 400 && res.status < 500) {
    const text = await res.text();
    throw new Error(`SerpAPI 被拒 HTTP ${res.status}：${text.slice(0, 160)}`);
  }
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`SerpAPI: ${data.error}`);
  const matches = Array.isArray(data.visual_matches) ? data.visual_matches : [];
  if (!matches.length) throw new Error('SerpAPI 没有返回相似结果');
  onLog?.(`SerpAPI 相似结果 ${matches.length} 条`);
  // 不截断：SerpAPI 一次能回 60 条，切掉一半会直接丢掉命中的社交账号
  return matches.map((m, index) => {
    const link = typeof m?.link === 'string' ? m.link : '';
    return {
      url: link,
      title: typeof m?.title === 'string' ? m.title : '',
      authorName: '',
      authorUrl: '',
      sourceUrl: link,
      // 站点名（X / Instagram / Threads…）留给账号提取当线索
      snippet: typeof m?.source === 'string' ? m.source : '',
      links: link ? [link] : [],
      host: hostOf(link),
      engine: 'lens',
      similarity: null,
      // 谷歌 Lens 的顺序就是相关性顺序：第 1 条通常正是原图/原帖，
      // 后面的才是「长得像」。这个位次必须传下去，否则下游只能当它们一样可信。
      position: index + 1,
      weak: false
    };
  });
}

/**
 * Yandex 以图搜图的 SerpAPI 版。
 *
 * 为什么不用浏览器：Yandex 和 Google 一样，机房 IP 上无头浏览器经常吃验证码；
 * 有 SerpAPI key 时直接走 `engine=yandex_images`，先用 pomf2 把图传到公网。
 * `tab=about` 返回 image_results —— 这是「哪些网页收录了这张图」，才是图源；
 * `tab=similar` 只返回 images_results 相似图，容易把不相干的图当答案。
 * 先查 about；没有确切收录页时再退回 similar。
 */
function isArtworkPageUrl(value) {
  return /pixiv\.net\/(?:en\/)?artworks\/\d+/i.test(value)
    || /danbooru\.donmai\.us\/posts\/\d+/i.test(value)
    || /(?:twitter|x)\.com\/[^/]+\/status\/\d+/i.test(value)
    || /weibo\.com\/\d+\/[A-Za-z0-9]+/i.test(value)
    || /bilibili\.com\/(?:video|opus)\//i.test(value)
    || /artstation\.com\/artwork\/[A-Za-z0-9]+/i.test(value)
    || /civitai\.com\/images\/\d+/i.test(value);
}

export async function serpApiYandexSearch(bytes, mimeType, { apiKey, timeoutMs = 45000, onLog } = {}) {
  if (!apiKey) throw new Error('没有配置 SerpAPI key');
  if (!bytes || !bytes.length) throw new Error('没有图片');
  const ext = /png/i.test(String(mimeType ?? '')) ? 'png' : 'jpg';
  const publicUrl = await uploadPublicImage(bytes, mimeType, {
    provider: 'selfhost',
    timeoutMs: 30000,
    filename: `fish-yandex.${ext}`
  });
  onLog?.(`Yandex 图床: ${publicUrl}`);
  const requestTabOnce = async (tab) => {
    const qs = new URLSearchParams({
      engine: 'yandex_images',
      api_key: apiKey,
      url: publicUrl,
      tab
    });
    const res = await fetch(`https://serpapi.com/search?${qs.toString()}`, {
      signal: AbortSignal.timeout(Math.max(timeoutMs, 45000))
    });
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text();
      throw new Error(`SerpAPI 被拒 HTTP ${res.status}：${text.slice(0, 160)}`);
    }
    if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error) throw new Error(`SerpAPI: ${data.error}`);
    return data;
  };

  // SerpAPI 去抓自建图床时偶尔超时（报 'URL does not refer to an image'），
  // 但文件明明在、nginx 也正常 —— 重试一次基本就过了。
  const requestTab = async (tab) => {
    try {
      return await requestTabOnce(tab);
    } catch (error) {
      if (!/does not refer to an image|not publicly accessible|HTTP 5\d\d/i.test(String(error?.message ?? ''))) throw error;
      onLog?.(`Yandex 取图失败，1.5 秒后重试（${String(error?.message ?? '').slice(0, 60)}）`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return requestTabOnce(tab);
    }
  };

  let data = await requestTab('about');
  let matches = Array.isArray(data.image_results) ? data.image_results : [];
  let mode = 'about';
  if (!matches.length) {
    data = await requestTab('similar');
    matches = Array.isArray(data.images_results) ? data.images_results : [];
    mode = 'similar';
  }
  if (!matches.length) throw new Error('Yandex 没有返回结果');
  onLog?.(`Yandex ${mode} 结果 ${matches.length} 条`);
  const out = [];
  for (const m of matches) {
    const link = typeof m?.link === 'string' ? m.link : '';
    if (!/^https?:\/\//i.test(link)) continue;
    const host = hostOf(link);
    // 结果里偶尔混进 Yandex 自己的搜索页，不是可展示的图源
    if (!host || /(^|\.)yandex\.(com|ru)$/i.test(host)) continue;
    const title = typeof m?.title === 'string' ? m.title : '';
    const snippet = typeof m?.snippet === 'string'
      ? m.snippet
      : typeof m?.source === 'string' ? m.source : '';
    // about 结果的 snippet 里常埋着真正的作品页（例如 Pixiv /artworks/...），
    // 这些比「收录页」更接近用户要的「这张图的链接」。
    const embedded = `${title} ${snippet}`.match(/https?:\/\/[^\s"'<>）)]+/g) || [];
    const artworkUrl = embedded.find(isArtworkPageUrl) || (isArtworkPageUrl(link) ? link : '');
    const sourceUrl = artworkUrl || link;
    const links = [sourceUrl, link, ...embedded].filter((value, index, arr) => value && arr.indexOf(value) === index);
    out.push({
      url: link,
      title,
      authorName: '',
      authorUrl: '',
      sourceUrl,
      pageUrl: link,
      snippet,
      links,
      imageUrl: typeof m?.original === 'string' ? m.original : '',
      host,
      engine: 'yandex',
      similarity: null,
      // Yandex 的相关度顺序就是线索顺序：第 3 条比第 45 条可信得多
      position: out.length + 1,
      weak: false
    });
  }
  if (!out.length) throw new Error('Yandex 结果没有可用外链');
  // 有作品页的候选优先：用户要的是「这张图」，不是「收录它的某个博客」。
  out.sort((a, b) => Number(b.sourceUrl !== b.pageUrl) - Number(a.sourceUrl !== a.pageUrl));
  return out;
}

/**
 * Sightengine 的 genai 检测：判断「是不是 AI 生成」以及可能的生成器。
 * 需要用户在 config.json 里填 sightengineApiUser / sightengineApiSecret。
 * 返回独立对象，不混进 candidates（它不是「账号候选」）。
 */
export async function aiDetect(bytes, mimeType, { apiUser = '', apiSecret = '', timeoutMs = 45000 } = {}) {
  if (!apiUser || !apiSecret) {
    throw new Error('Sightengine 未配置 api_user/api_secret');
  }
  if (!bytes || !bytes.length) throw new Error('没有图片');
  const ext = /png/i.test(String(mimeType ?? '')) ? 'png' : 'jpg';
  const form = new FormData();
  form.append('media', new Blob([bytes], { type: mimeType || 'image/jpeg' }), `fish-ai.${ext}`);
  form.append('models', 'genai');
  form.append('api_user', apiUser);
  form.append('api_secret', apiSecret);
  const res = await fetch('https://api.sightengine.com/1.0/check.json', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Math.max(timeoutMs, 30000))
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sightengine HTTP ${res.status}：${text.slice(0, 160)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Sightengine 返回不是 JSON：${text.slice(0, 120)}`);
  }
  if (data?.status === 'failure' || data?.error) {
    const message = data?.error?.message || data?.error || '检测失败';
    throw new Error(`Sightengine: ${message}`);
  }
  // Sightengine 的 genai 响应实际把全局分数放在顶层 type.ai_generated；
  // 部分账号/模型还会在同级返回各生成器的分数。两种形状都兼容。
  const genai = data?.data?.genai ?? data?.genai ?? null;
  const type = data?.type && typeof data.type === 'object' ? data.type : {};
  const score = Number(type.ai_generated ?? genai?.score ?? 0);
  const generatorScores = {};
  for (const [key, value] of Object.entries(type)) {
    if (key === 'ai_generated') continue;
    if (typeof value === 'number' && value > 0) generatorScores[key] = value;
  }
  const generators = genai?.generators ?? genai?.generator
    ?? (Object.keys(generatorScores).length ? generatorScores : null);
  const hasTypeScore = type.ai_generated !== undefined;
  return {
    provider: 'sightengine',
    isAI: hasTypeScore ? score >= 0.5 : (genai?.is_ai === true || score >= 0.5),
    score: Number.isFinite(score) ? score : 0,
    generators
  };
}

export async function googleLensSearch(bytes, mimeType, { hl = 'zh-CN', timeoutMs = 45000, exe, tempDir, debug = false, exactPass = true } = {}) {
  if (!bytes || !bytes.length) throw new Error('没有图片');
  const dir = tempDir || os.tmpdir();
  const ext = /png/i.test(String(mimeType ?? '')) ? 'png' : 'jpg';
  const file = path.join(dir, `fish-lens-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`);
  fs.writeFileSync(file, bytes);
  const prepare = [
    '(function () {',
    "  if (document.getElementById('fishLensForm')) return 'exists';",
    "  var form = document.createElement('form');",
    "  form.id = 'fishLensForm'; form.method = 'POST'; form.enctype = 'multipart/form-data';",
    "  form.action = 'https://lens.google.com/v3/upload?hl=" + hl + "';",
    "  form.target = '_self'; form.style.display = 'none';",
    "  var picker = document.createElement('input');",
    "  picker.type = 'file'; picker.name = 'encoded_image'; picker.id = 'fishLensFile';",
    '  form.appendChild(picker);',
    "  var marker = document.createElement('input');",
    "  marker.type = 'hidden'; marker.name = 'image_content'; marker.value = '';",
    '  form.appendChild(marker);',
    '  document.body.appendChild(form);',
    "  return 'ok';",
    '})()'
  ].join('\n');
  try {
    const out = await browserFileUploadHtml({
      startUrl: 'https://www.google.com/',
      filePath: file,
      fileSelector: '#fishLensFile',
      prepareExpression: prepare,
      submitExpression: "document.getElementById('fishLensForm').submit()",
      // 跳转到结果页之后还有一段 JS 渲染：只看 URL 会抓到一张空壳，必须等结果卡片真落地
      waitForExpression: 'document.body && document.body.innerText.length > 400 && document.querySelectorAll("a[href]").length > 25',
      extractExpression: LENS_EXTRACT,
      settleMs: 2500,
      timeoutMs: Math.max(timeoutMs, 30000),
      exe
    });
    let page = out?.data;
    if (typeof page === 'string') {
      try { page = JSON.parse(page); } catch { page = {}; }
    }
    page = page && typeof page === 'object' ? page : {};
    if (page.captcha) throw new Error('GOOGLE_CAPTCHA：谷歌要求验证，稍后再试');
    const state = await ensureBrowser({ timeoutMs: Math.max(timeoutMs, 30000), exe });
    // 一页结果分两段解析：先拿结果卡片，再逐条解出 /goto?url= 背后的真实域名。
    const collectFrom = async (parsed) => {
      const out2 = { rows: Array.isArray(parsed?.results) ? parsed.results.slice() : [], cards: Array.isArray(parsed?.cards) ? parsed.cards : [] };
      if (!out2.cards.length) return out2.rows;
      // 社交卡片优先解：它们最可能就是原帖/作者；解够 6 条就停，别把时间花在文章页上
      const social = out2.cards.filter((card) => LENS_SOCIAL_RE.test(String(card.title ?? '')));
      const queue = social.concat(out2.cards.filter((card) => !LENS_SOCIAL_RE.test(String(card.title ?? '')))).slice(0, 6);
      for (const card of queue) {
        const target = await resolveLensGoto(state, String(card.wrapper ?? ''), { timeoutMs: 12000 });
        if (!target) continue;
        if (out2.rows.some((row) => String(row?.url ?? '') === target)) continue;
        const cardTitle = String(card.title ?? '').slice(0, 200);
        out2.rows.push({ url: target, title: cardTitle, authorName: socialNameFromTitle(cardTitle) });
      }
      return out2.rows;
    };
    const visualRows = await collectFrom(page);
    const looksSocial = (list) => list.some((row) => LENS_SOCIAL_RE.test(String(row?.title ?? '')) || LENS_SOCIAL_HOST_RE.test(String(row?.url ?? '')));
    // 「完全匹配」= 同一张图在网上的原出处，通常直接就是原帖；外观相似则只是长得像。
    // 外观那页已经捞到社交账号就不再跑第二趟（省 5 秒），否则补一趟。
    let exactRows = [];
    if (exactPass !== false && !looksSocial(visualRows)) {
      const exactUrl = (() => {
        try {
          const u = new URL(String(out?.url ?? ''));
          if (!/^https:\/\/www\.google\.[a-z.]+\/search/i.test(u.href)) return '';
          u.searchParams.set('udm', '48');
          return u.href;
        } catch { return ''; }
      })();
      if (exactUrl) {
        try {
          const visit = await browserVisit({
            url: exactUrl,
            waitForExpression: 'document.body && document.querySelectorAll("a[href]").length > 20',
            extractExpression: LENS_EXTRACT,
            settleMs: 2200,
            timeoutMs: Math.max(timeoutMs, 30000),
            exe
          });
          let exactPage = visit?.data;
          if (typeof exactPage === 'string') {
            try { exactPage = JSON.parse(exactPage); } catch { exactPage = {}; }
          }
          if (exactPage && !exactPage.captcha) {
            exactRows = (await collectFrom(exactPage)).map((row) => ({ ...row, exact: true }));
          }
        } catch { /* 完全匹配这趟失败不影响主结果，视觉结果已经在手上 */ }
      }
    }
    const rows = exactRows.concat(visualRows);
    const mapped = rows
      .filter((row) => row && typeof row.url === 'string')
      .map((row) => ({ url: row.url, title: String(row.title ?? '').slice(0, 200), similarity: null, sourceUrl: row.url }));
    return debug ? { rows: mapped, page, exactCount: exactRows.length, finalUrl: out?.url ?? '' } : mapped;
  } catch (error) {
    const message = String(error?.message ?? '');
    if (/ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|ERR_PROXY|ERR_TIMED_OUT/i.test(message)) {
      throw new Error('GOOGLE_UNREACHABLE：谷歌连不上（猫猫云没开或系统代理没开）');
    }
    throw error;
  } finally {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

// ── SauceNAO 额度 ─────────────────────────────────────────────────────────
//
// 匿名（不配 key）是按 **IP 每天 20 次** 算的，第 21 次起直接 HTTP 429，正文是
// `<strong>Daily Search Limit Exceeded.</strong> … daily limit of 20 searches`。
// 这就是「今天试了几次全是推特」的根：SauceNAO 被锁死 → 一整个 pixiv 通道都没了，
// 只剩谷歌 Lens 那几条推特搬运贴，自然次次都是推特。
// 注册账号配 api_key（config.json 的 sauceNaoApiKey，还要在 SauceNAO 账号设置里
// 打开 API access）后额度按账号等级给，比 20 次多得多。
const SAUCENAO_BLOCK_FILE = path.join(MODULE_ROOT, 'state', 'saucenao-block.json');

/** 额度按 IP 自然日重置：算到「下一个北京时间零点」，解封前不再白发请求。 */
export function nextBeijingMidnight(nowMs = Date.now()) {
  const offset = 8 * 3600 * 1000;
  const dayMs = 86400 * 1000;
  return Math.floor((nowMs + offset) / dayMs) * dayMs + dayMs - offset;
}

/**
 * 现在还能不能打 SauceNAO；被锁着就返回 {until, reason, keyless}。
 * keyless=true 表示这把锁是「匿名 IP 额度用完」时上的 —— 之后要是配上了 api_key，
 * 这把锁就不该再拦人（key 的额度跟匿名那 20 次不是一回事）。
 */
export function sauceNaoBlocked(nowMs = Date.now()) {
  const state = readJsonFile(SAUCENAO_BLOCK_FILE, null);
  const until = Number(state?.until ?? 0);
  if (!until || until <= nowMs) return null;
  return {
    until,
    reason: String(state?.reason ?? '') || 'SauceNAO 暂时用不了',
    keyless: Boolean(state?.keyless)
  };
}

function blockSauceNao(untilMs, reason, keyless = false) {
  try {
    writeJsonFileAtomic(SAUCENAO_BLOCK_FILE, { until: untilMs, reason, keyless });
  } catch {
    // 状态文件写不进去也不能挡住查询本身
  }
}

/** 手动解封（换了 IP / 配了 key 之后用）。 */
export function clearSauceNaoBlock() {
  try { fs.rmSync(SAUCENAO_BLOCK_FILE, { force: true }); } catch {}
}

/**
 * 限流是这条通道最大的坑：不管匿名还是免费 key，都是「30 秒内最多 4 次」。
 * 群里连着查几张图，第 5 张必吃 429。老代码一遇 429 就把 SauceNAO 整条通道
 * 封 60 秒（还写进 state 文件），后面几分钟的图全走空 —— 二次元图「也查不到了」
 * 就是这么来的。现在改成：请求串行 + 7.5 秒间隔（= 30 秒 4 次的节奏），
 * 短时 429 等一个窗口重试；只有「当天额度用完」才真的封到零点。
 */
const SAUCENAO_MIN_GAP_MS = 7500;
let sauceChain = Promise.resolve();
let sauceLastAt = 0;
let sauceCooldownUntil = 0;

function sauceGate(task) {
  const run = sauceChain.then(async () => {
    const cooldown = sauceCooldownUntil - Date.now();
    if (cooldown > 0) await sleep(cooldown);
    const gap = SAUCENAO_MIN_GAP_MS - (Date.now() - sauceLastAt);
    if (gap > 0) await sleep(gap);
    sauceLastAt = Date.now();
    return task();
  });
  // 链条不能因为某一次失败断掉，否则后面排队的请求全被传染
  sauceChain = run.then(() => {}, () => {});
  return run;
}

async function saucenaoRequest(bytes, mimeType, { timeoutMs, key }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType || 'image/png' }), 'image.' + (mimeType === 'image/jpeg' ? 'jpg' : 'png'));
  form.append('db', '999');
  if (key) {
    form.append('api_key', key);
    form.append('output_type', '2');
    form.append('numres', '16');
  } else {
    form.append('output_type', '0');
  }
  const url = 'https://saucenao.com/search.php';
  await validateFetchUrl(url);
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: key ? 'application/json, text/html;q=0.9' : 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.text();
  // 当天额度用完：429 + 一段 HTML（不是 JSON，也没有 statusText 可看），只能认正文
  if (/Daily Search Limit Exceeded|daily limit of \d+ searches/i.test(body)) {
    const until = nextBeijingMidnight();
    const error = new Error(
      key
        ? 'SauceNAO 今天的额度用完了，明天零点自动恢复'
        : 'SauceNAO 今日 20 次用完了（未注册 IP 限额），明天零点恢复；想更多就在 config.json 配 sauceNaoApiKey'
    );
    error.code = 'RATE_LIMITED';
    error.daily = true;
    blockSauceNao(until, error.message, !key);
    throw error;
  }
  if (response.status === 403 || response.status === 429) {
    const error = new Error('SauceNAO 30 秒内最多 4 次，刚被限流');
    error.code = 'RATE_LIMITED';
    // 只做进程内冷却，不写盘：下一张图隔十几秒再来就能过
    sauceCooldownUntil = Math.max(sauceCooldownUntil, Date.now() + 12000);
    throw error;
  }
  if (!response.ok) throw new Error(`SauceNAO HTTP ${response.status}`);
  // 有 key 才要 JSON；万一是 HTML（比如账号没开 API access），退回老解析，不白跑这一趟
  if (key) {
    const rows = parseSaucenaoJson(body);
    if (rows.length) return rows;
  }
  return parseSaucenao(body);
}

async function saucenaoSearch(bytes, mimeType, { timeoutMs, apiKey = '' } = {}) {
  const key = String(apiKey ?? '').trim();
  const blocked = sauceNaoBlocked();
  if (blocked) {
    // 匿名额度那把锁对「有 key 的请求」不作数：key 配上了就该照常查
    if (key && blocked.keyless) clearSauceNaoBlock();
    else {
      const error = new Error(blocked.reason);
      error.code = 'RATE_LIMITED';
      throw error;
    }
  }
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await sauceGate(() => saucenaoRequest(bytes, mimeType, { timeoutMs, key }));
    } catch (error) {
      lastError = error;
      // 当天额度用完就别白试了；短时限流等一个窗口再来一次
      if (error?.code !== 'RATE_LIMITED' || error?.daily) break;
    }
  }
  throw lastError ?? new Error('SauceNAO 没查成');
}

/**
 * SauceNAO 的 JSON（output_type=2）→ 候选。字段来源：results[].header.similarity /
 * index_id，results[].data.{ext_urls,title,author_name,member_id,pixiv_id,source}。
 */
export function parseSaucenaoJson(body) {
  let payload;
  try {
    payload = JSON.parse(String(body ?? ''));
  } catch {
    return [];
  }
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  for (const row of rows) {
    const header = row?.header ?? {};
    const data = row?.data ?? {};
    const similarity = header.similarity == null ? null : Number(header.similarity) / 100;
    const indexId = Number(header.index_id ?? 0) || null;
    const links = (Array.isArray(data.ext_urls) ? data.ext_urls : [])
      .map((link) => absUrl(String(link), 'https://saucenao.com/'))
      .filter(Boolean);
    // pixiv 命中：会员号直接给出画师主页，作品页补成新站地址（老站 member.php 也能认）
    const memberId = String(data.member_id ?? '').trim();
    const pixivId = String(data.pixiv_id ?? '').trim();
    if (pixivId && !links.some((link) => /pixiv\.net\/artworks\/\d+/.test(link))) {
      links.unshift(`https://www.pixiv.net/artworks/${pixivId}`);
    }
    const authorUrl = memberId ? `https://www.pixiv.net/users/${memberId}` : '';
    const title = trimText(stripTags(String(data.title ?? '')), 120) || trimText(String(data.source ?? ''), 120);
    const authorName = trimText(stripTags(String(data.author_name ?? '')), 40);
    if (!links.length && !title) continue;
    out.push({
      engine: 'saucenao',
      similarity,
      indexId,
      title,
      sourceUrl: links[0] ?? '',
      authorUrl,
      authorName,
      host: hostOf(links[0] ?? authorUrl),
      snippet: trimText(stripTags(`${data.title ?? ''} ${data.author_name ?? ''} ${links[0] ?? ''}`), 200),
      links
    });
  }
  return out;
}

export function parseSaucenao(html) {
  const text = String(html ?? '');
  const blocks = text.split(/<div class="result\b/).slice(1);
  if (!blocks.length) {
    // 有些版本用 <div id="res<index>" class="result">，退一步按 similarity 直接抓
    const fallback = [];
    const re = /resultsimilarityinfo[^>]*>\s*([\d.]+)%/g;
    let m;
    while ((m = re.exec(text))) fallback.push({ similarity: Number(m[1]) / 100 });
    return fallback;
  }
  const candidates = [];
  for (const block of blocks) {
    const simMatch = block.match(/resultsimilarityinfo[^>]*>\s*([\d.]+)%/)
      || block.match(/similarity-info[^>]*>[\s\S]{0,120}?([\d.]+)%/)
      || block.match(/([\d.]+)%/);
    const similarity = simMatch ? Number(simMatch[1]) / 100 : null;

    const titleMatch = block.match(/class="resulttitle"[\s\S]{0,400}?<strong[^>]*>([\s\S]*?)<\/strong>/i)
      || block.match(/class="resulttitle"[\s\S]{0,200}?>\s*([^<]{2,200})</i);
    const title = titleMatch ? stripTags(titleMatch[1]) : '';

    // 结果里所有外链：第一个一般就是图源
    const links = [];
    const hrefRe = /href="([^"]+)"/g;
    let hm;
    while ((hm = hrefRe.exec(block))) {
      const href = absUrl(hm[1], 'https://saucenao.com/');
      if (!href) continue;
      const host = hostOf(href);
      if (!host || host.endsWith('saucenao.com')) continue;
      if (!links.includes(href)) links.push(href);
    }

    // 作者行：SauceNAO 实际写的是 `Member: <a href=...>作者名</a>`（pixiv 老格式 member.php?id=），
    // 也有 `Author:` 的写法 —— 两种都认，抓错了顶多是空，不会误认。
    const authorMatch = block.match(/(?:Member|Author)[\s\S]{0,240}?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/author[^>]*>[\s\S]{0,200}?href="([^"]+)"/i);
    const authorUrl = authorMatch ? absUrl(authorMatch[1], 'https://saucenao.com/') : '';
    // 作者名（如 `豊栄@ﾄﾞﾔｧ…`）：拿它去搜推特比拿作品标题搜准得多。
    const authorName = authorMatch && authorMatch[2] ? trimText(stripTags(authorMatch[2]), 40) : '';

    const snippet = trimText(stripTags(block), 200);
    if (!links.length && !title) continue;
    candidates.push({
      engine: 'saucenao',
      similarity,
      title,
      sourceUrl: links[0] ?? '',
      authorUrl,
      authorName,
      host: hostOf(links[0] ?? authorUrl),
      snippet,
      links
    });
  }
  return candidates;
}

// ── IQDB：multipart POST，动漫图库（danbooru / konachan / yande.re）─────────
export function parseIqdb(html) {
  const text = String(html ?? '');
  if (/Place in queue|under high load/i.test(text)) {
    const error = new Error('IQDB 在排队（站点高负载），过一会儿再试');
    error.code = 'QUEUED';
    throw error;
  }
  if (/No relevant matches/i.test(text)) return [];
  const links = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text))) {
    const url = absUrl(String(m[1]).replace(/^\/\//, 'https://'), 'https://iqdb.org/');
    if (!url) continue;
    const host = hostOf(url);
    if (!host || host.endsWith('iqdb.org')) continue;
    if (/\.(?:css|js|ico|png|jpe?g|gif|svg)(?:\?|$)/i.test(url)) continue;
    if (links.some((item) => item.url === url)) continue;
    links.push({ url, host, title: trimText(stripTags(m[2]), 100) });
  }
  const sim = text.match(/(\d{1,3})%\s*similarity/i);
  const similarity = sim ? Number(sim[1]) / 100 : null;
  return links.slice(0, 12).map((item) => ({
    engine: 'iqdb',
    similarity,
    title: item.title,
    sourceUrl: item.url,
    authorUrl: '',
    host: item.host,
    snippet: '',
    links: [item.url]
  }));
}

async function iqdbSearch(bytes, mimeType, { timeoutMs, onLog } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType || 'image/png' }), 'image.' + (mimeType === 'image/jpeg' ? 'jpg' : 'png'));
  for (const n of [1, 2, 3, 4, 5, 6]) form.append('service[]', String(n));
  const url = 'https://iqdb.org/';
  await validateFetchUrl(url);
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    redirect: 'follow',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    // 这站现在常年排队，等满 40 秒纯属浪费：超时压到 10 秒，够它回「排队」就收
    signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 8000), 12000))
  });
  if (!response.ok) throw new Error(`IQDB HTTP ${response.status}`);
  return parseIqdb(await response.text());
}

// ── trace.moe：动画截图反查（给的是番剧/集数，不是社媒账号）────────────────
export function parseTracemoe(payload) {
  const list = Array.isArray(payload?.result) ? payload.result : [];
  const out = [];
  const seen = new Set();
  for (const item of list.slice(0, 10)) {
    // 0.87 以下基本是「随便一个番的某帧」，真命中一般 0.9 以上 —— 低于门槛的宁可不要，
    // 否则每次都会往结果里塞十条无关番剧。
    const similarity = Number.isFinite(item?.similarity) ? item.similarity : 0;
    if (similarity < 0.87) continue;
    const anilistId = item?.anilist?.id ?? item?.anilist?.anime_id ?? null;
    const title = item?.anilist?.title?.native || item?.anilist?.title?.romaji || item?.anilist?.title?.english || item?.filename || '';
    const sourceUrl = anilistId ? `https://anilist.co/anime/${anilistId}` : '';
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    const episode = Number.isFinite(item?.episode) ? ` 第${item.episode}集` : '';
    out.push({
      engine: 'tracemoe',
      similarity,
      title: trimText(`${title}${episode}`, 120),
      sourceUrl,
      authorUrl: '',
      host: 'anilist.co',
      snippet: trimText(String(item?.filename ?? ''), 120),
      links: [sourceUrl]
    });
    if (out.length >= 3) break;
  }
  return out;
}

async function tracemoeSearch(bytes, mimeType, { timeoutMs } = {}) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: mimeType || 'image/png' }), 'image.' + (mimeType === 'image/jpeg' ? 'jpg' : 'png'));
  const url = 'https://api.trace.moe/search?anilistInfo';
  await validateFetchUrl(url);
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`trace.moe HTTP ${response.status}`);
  return parseTracemoe(await response.json());
}

// ── 百度识图（真浏览器上传）：结果是「相似图」，噪声大，只留账号主页形态的链接 ──
export function parseBaiduGraph(html) {
  const links = collectExternalLinks(html, {
    base: 'https://graph.baidu.com/',
    excludeHosts: ['baidu.com', 'bdstatic.com', 'baidupcs.com', 'bdimg.com', 'bdurl.net'],
    cap: 60
  });
  const seen = new Set();
  const out = [];
  for (const item of links) {
    const hit = matchPlatform(item.url);
    if (!hit) continue; // 文章页 / 图集页一律不要，只认账号主页形态
    const url = hit.url || item.url;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      engine: 'baidu',
      similarity: null,
      weak: true, // 相似图不一定同一个人，标记成弱证据
      title: item.title,
      sourceUrl: url,
      authorUrl: '',
      host: hostOf(url),
      snippet: '',
      links: [url]
    });
  }
  return out;
}

// 三家浏览器引擎的 DOM 都是「一堆外链卡片」，结构天天变，所以统一退到最稳的做法：
// 抓所有外链、去重、排除引擎自家域名，锚文本能取到就取（取不到不影响账号抽取）。
function collectExternalLinks(html, { base, excludeHosts = [], cap = 24 } = {}) {
  const text = String(html ?? '');
  const out = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const push = (href, label) => {
    const url = absUrl(href, base);
    const host = hostOf(url);
    if (!url || !host) return;
    if (excludeHosts.some((bad) => host === bad || host.endsWith('.' + bad))) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({
      url,
      host,
      title: label ? trimText(stripTags(label), 120) : ''
    });
  };
  let m;
  while ((m = anchorRe.exec(text))) {
    push(m[1], m[2]);
    if (out.length >= cap * 3) break;
  }
  // 兜底：还有没被锚点包住的链接（JS 里拼的、property 里的）
  if (out.length < cap) {
    const hrefRe = /href="(https?:\/\/[^"]+)"/gi;
    while ((m = hrefRe.exec(text))) {
      push(m[1], '');
      if (out.length >= cap * 3) break;
    }
  }
  return out.slice(0, cap);
}

function linksToCandidates(engine, html, options) {
  return collectExternalLinks(html, options).map((item) => ({
    engine,
    similarity: null,
    title: item.title,
    sourceUrl: item.url,
    authorUrl: '',
    host: item.host,
    snippet: '',
    links: [item.url]
  }));
}

export function parseBingDom(html) {
  return linksToCandidates('bing', html, {
    base: 'https://www.bing.com/',
    excludeHosts: ['bing.com', 'microsoft.com', 'msn.com', 'microsofttranslator.com', 'live.com'],
    cap: 24
  });
}

export function parseYandexDom(html) {
  return linksToCandidates('yandex', html, {
    base: 'https://yandex.com/',
    excludeHosts: ['yandex.com', 'yandex.ru', 'yastatic.net', 'yandex.net'],
    cap: 24
  });
}

export function parseBaiduDom(html) {
  return linksToCandidates('baidu', html, {
    base: 'https://graph.baidu.com/',
    excludeHosts: ['baidu.com', 'bdstatic.com', 'baidupcs.com'],
    cap: 24
  });
}

// 浏览器引擎：把图片先传到一个「能收图」的临时宿主是不行的（要公网），
// 所以 Yandex/Bing/百度都只能靠「已上传到公网」的图片 URL —— 这里明确拒绝，
// 由调用方决定是否降级（当前实现：跳过并在 failures 里说明）。
async function browserEngineSearch(engine, bytes, mimeType, { timeoutMs, onLog, publicUrl }) {
  if (!publicUrl) {
    throw new Error(`${engine} 需要公网图片 URL（QQ 图片是内网 rkey，传不上去）`);
  }
  if (engine === 'bing') {
    const html = await browserHtml(`https://www.bing.com/images/search?q=${encodeURIComponent(`imgurl:${publicUrl}`)}&view=detailv2&iss=sbi`, { timeoutMs });
    return parseBingDom(html);
  }
  if (engine === 'yandex') {
    const html = await browserHtml(`https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(publicUrl)}`, { timeoutMs });
    return parseYandexDom(html);
  }
  if (engine === 'baidu') {
    const html = await browserHtml(`https://graph.baidu.com/details?isfromtusoupc=1&tn=pc&carousel=0&image=${encodeURIComponent(publicUrl)}`, { timeoutMs });
    return parseBaiduDom(html);
  }
  if (engine === 'google') {
    const html = await browserHtml(`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(publicUrl)}`, { timeoutMs });
    return parseBingDom(html); // Google Lens 的 DOM 结构本版不另写，能出外链就够
  }
  throw new Error(`未知引擎：${engine}`);
}

/**
 * 反查一张图。引擎选择由调用方从 state/fish-find-engines.json 读出后传进来。
 * 单个引擎失败不影响其它引擎；全失败返回 failures 说明原因。
 */
export async function reverseSearch(bytes, mimeType, { engines, timeoutMs = 25000, onLog, publicUrl, browserExe, tempDir, proxy = '', serpApiKey = '', sauceNaoApiKey = '', sightengineApiUser = '', sightengineApiSecret = '' } = {}) {
  // 浏览器是单例、代理是启动参数：本次要走的通道先摆好（空串 = 直连）
  setBrowserProxy(proxy);
  const list = (Array.isArray(engines) && engines.length ? engines : ['saucenao'])
    .filter((id) => ENGINE_IDS.includes(id));
  const candidates = [];
  const failures = [];
  const enginesUsed = [];

  const runEngine = async (engine) => {
    if (engine === 'saucenao') return saucenaoSearch(bytes, mimeType, { timeoutMs, apiKey: sauceNaoApiKey });
    if (engine === 'iqdb') return iqdbSearch(bytes, mimeType, { timeoutMs, onLog });
    if (engine === 'tracemoe') return tracemoeSearch(bytes, mimeType, { timeoutMs, onLog });
    if (engine === 'lens') {
      // 有 key 就直接走 SerpAPI：本机 IP 上无头浏览器必吃验证码，还会白等 30+ 秒
      if (serpApiKey) {
        return serpApiLensSearch(bytes, mimeType, { apiKey: serpApiKey, timeoutMs, onLog });
      }
      return googleLensSearch(bytes, mimeType, { timeoutMs: Math.max(timeoutMs, 30000), exe: browserExe, tempDir });
    }
    if (engine === 'yandex') {
      // 有 SerpAPI key 就走 API；没有则退回浏览器（需要 publicUrl）
      if (serpApiKey) {
        return serpApiYandexSearch(bytes, mimeType, { apiKey: serpApiKey, timeoutMs, onLog });
      }
      return browserEngineSearch('yandex', bytes, mimeType, { timeoutMs, onLog, publicUrl });
    }
    if (engine === 'ai') {
      return aiDetect(bytes, mimeType, {
        apiUser: sightengineApiUser,
        apiSecret: sightengineApiSecret,
        timeoutMs
      });
    }
    if (engine === 'baidu') {
      const dir = tempDir || os.tmpdir();
      const file = path.join(dir, `fish-find-upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${mimeType === 'image/png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(file, bytes);
      try {
        const { html } = await browserFileUploadHtml({
          startUrl: 'https://graph.baidu.com/pcpage/index?tpl_from=pc',
          filePath: file,
          fileSelector: 'input[type=file].general-upload-file',
          settleMs: 2500,
          timeoutMs: Math.max(timeoutMs, 30000),
          exe: browserExe,
          waitForExpression: '(() => (document.querySelectorAll(\'a[href^="http"]\').length > 12 && document.body.innerText.length > 600))()'
        });
        return parseBaiduGraph(html);
      } finally {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
    }
    if (BROWSER_ENGINES.has(engine)) return browserEngineSearch(engine, bytes, mimeType, { timeoutMs, onLog, publicUrl });
    throw new Error('未实现的引擎');
  };

  let aiResult = null;
  const record = async (engine, task) => {
    const started = Date.now();
    try {
      const found = await task();
      enginesUsed.push(engine);
      if (engine === 'ai') {
        aiResult = found && typeof found === 'object' ? found : null;
        if (onLog) onLog(`[菲比找鸡] ${engine} 完成 ${Date.now() - started}ms`);
        return;
      }
      if (Array.isArray(found) && found.length) {
        for (const item of found) candidates.push({ ...item, engine });
      } else {
        failures.push({ engine, reason: '空结果' });
      }
      if (onLog) onLog(`[菲比找鸡] ${engine} 完成 ${Date.now() - started}ms，结果 ${Array.isArray(found) ? found.length : 0} 条`);
    } catch (error) {
      const reason = String(error?.message ?? error);
      failures.push({ engine, reason });
      if (onLog) onLog(`[菲比找鸡] ${engine} 失败 ${Date.now() - started}ms：${reason}`);
    }
  };

  // 纯网络的引擎并发跑（互不影响），浏览器那台独占一个 page，必须串行。
  // AI 检测和 Yandex/SerpAPI 都是纯网络请求，也放进并发组。
  const NETWORK = new Set(['saucenao', 'iqdb', 'tracemoe', 'yandex', 'ai']);
  const parallel = list.filter((engine) => NETWORK.has(engine));
  const serial = list.filter((engine) => !NETWORK.has(engine));
  await Promise.all(parallel.map((engine) => record(engine, () => runEngine(engine))));
  for (const engine of serial) {
    await record(engine, () => runEngine(engine));
    if (failures.some((item) => item.engine === engine && /RATE_LIMITED|403/i.test(item.reason))) await sleep(1200);
  }
  return { candidates, failures, enginesUsed, ai: aiResult };
}

// ── 账号抽取 ──────────────────────────────────────────────────────────────

const PLATFORM_RULES = [
  {
    platform: 'twitter',
    re: /^https?:\/\/(?:www\.|mobile\.|m\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{2,20})(?:\/|$|\?)/i,
    // 命中的常常是某条推文（/status/…），但人问的是「账号」，所以一律收敛到主页地址。
    clean: (m) => ({
      handle: '@' + m[1],
      handleKey: m[1].toLowerCase(),
      url: `https://x.com/${m[1]}`
    })
  },
  {
    platform: 'weibo',
    re: /^https?:\/\/(?:www\.|m\.)?weibo\.(?:com|cn)\/(?:u\/|n\/)?(\d{6,}|[A-Za-z0-9_\-]{3,40})(?:\/|$|\?)/i,
    clean: (m) => ({ handle: m[1], handleKey: m[1].toLowerCase() })
  },
  {
    platform: 'bilibili',
    re: /^https?:\/\/(?:space\.bilibili\.com|www\.bilibili\.com\/space)\/(\d{3,})(?:\/|$|\?)/i,
    clean: (m) => ({ handle: m[1], handleKey: m[1] })
  },
  {
    platform: 'instagram',
    re: /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})\/?(?:\?|$)/i,
    clean: (m) => ({ handle: '@' + m[1], handleKey: m[1].toLowerCase() })
  },
  {
    // 小红书：只有 /user/profile/<id> 是「人」；/explore/<note> 是单条笔记（见 POST_URL_RE）
    platform: 'xiaohongshu',
    re: /^https?:\/\/(?:www\.)?xiaohongshu\.com\/user\/profile\/([A-Za-z0-9]{8,32})/i,
    clean: (m) => ({
      handle: m[1],
      handleKey: m[1].toLowerCase(),
      url: `https://www.xiaohongshu.com/user/profile/${m[1]}`
    })
  },
  {
    platform: 'douyin',
    re: /^https?:\/\/(?:www\.)?(?:douyin|iesdouyin)\.com\/user\/([A-Za-z0-9_\-]{8,80})/i,
    clean: (m) => ({
      handle: m[1],
      handleKey: m[1].toLowerCase(),
      url: `https://www.douyin.com/user/${m[1]}`
    })
  },
  {
    platform: 'tiktok',
    re: /^https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,32})/i,
    clean: (m) => ({
      handle: '@' + m[1],
      handleKey: m[1].toLowerCase(),
      url: `https://www.tiktok.com/@${m[1]}`
    })
  },
  {
    platform: 'threads',
    re: /^https?:\/\/(?:www\.)?threads\.(?:net|com)\/@([A-Za-z0-9_.]{2,32})/i,
    clean: (m) => ({
      handle: '@' + m[1],
      handleKey: m[1].toLowerCase(),
      url: `https://www.threads.net/@${m[1]}`
    })
  },
  {
    // 值得信的是裸主页；群组、帖子、watch 页是别人的场子
    platform: 'facebook',
    re: /^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/(?:profile\.php\?id=(\d{5,})|([A-Za-z0-9_.\-]{3,60}))/i,
    clean: (m) => {
      const id = m[1] ?? m[2];
      return {
        handle: id,
        handleKey: String(id).toLowerCase(),
        url: m[1] ? `https://www.facebook.com/profile.php?id=${m[1]}` : `https://www.facebook.com/${m[2]}`
      };
    }
  },
  {
    // Bluesky：coser 近两年大量迁过去，Lens 经常只给一条 bsky 链接
    platform: 'bluesky',
    re: /^https?:\/\/bsky\.app\/profile\/([A-Za-z0-9_.:\-]{4,120})/i,
    clean: (m) => ({
      handle: m[1],
      handleKey: m[1].toLowerCase(),
      url: `https://bsky.app/profile/${m[1]}`
    })
  },
  {
    // lofter：国产同人画师的老窝，子域名就是作者名
    platform: 'lofter',
    re: /^https?:\/\/([A-Za-z0-9\-]{2,40})\.lofter\.com(?:\/|$|\?)/i,
    clean: (m) => ({
      handle: m[1],
      handleKey: m[1].toLowerCase(),
      url: `https://${m[1]}.lofter.com`
    })
  },
  {
    platform: 'pixiv',
    // 两种真实形态：新站 /users/<id>，老站 /member.php?id=<id>（SauceNAO 的 Member 行就是后者）
    re: /^https?:\/\/(?:www\.)?pixiv\.net\/(?:(?:en\/)?users\/(\d{2,})|member\.php\?(?:[^#]*&)?id=(\d{2,}))/i,
    clean: (m) => {
      const id = m[1] ?? m[2];
      return { handle: id, handleKey: id, url: `https://www.pixiv.net/users/${id}` };
    }
  }
];

// bilibili 的图文/视频页里带作者 mid 时才算 direct
const BILIBILI_AUTHOR_RE = /\/(?:opus|video|read)\/.*?(?:mid=|space\.bilibili\.com\/)(\d{3,})/i;

// 同分时的平台顺序：微博 → B站 → Twitter → Instagram → Pixiv。
// 按「国内 coser 最可能留号的地方」排，回话里第 1 条就是最可能有用的那个。
// 真人 coser 的号绝大部分在推特，微博其次；Pixiv 是画作平台（画师的作品页），
// 不是「这个人自己的社交账号」，所以排在最后，回话里也要标出来。
const PLATFORM_WEIGHT = { twitter: 1, weibo: 2, bilibili: 3, xiaohongshu: 4, douyin: 5, tiktok: 6, instagram: 7, threads: 8, bluesky: 9, facebook: 10, lofter: 11, pixiv: 20, danbooru: 30 };

// 画作平台：pixiv 上的是画师的作品/会员号，不是 coser 的主页。
const ARTWORK_PLATFORMS = new Set(['pixiv']);

// 「看着像账号、其实是页面」的路径前缀 —— 百度识图/搜索结果里这类链接特别多，
// 不挡掉就会把 `weibo.com/ttarticle/p/show?id=…` 当成一个叫 ttarticle 的账号报出去。
const PATH_DENY = {
  weibo: ['ttarticle', 'p', 'show', 'status', 'detail', 'photo', 'video', 'article', 'fav', 'like', 'comment', 'search', 'hot', 'topic', 'tv', 'page', 's', 'weibo', 'login', 'signup', 'reg'],
  twitter: ['i', 'intent', 'share', 'home', 'search', 'hashtag', 'status', 'explore', 'notifications', 'messages', 'settings', 'login', 'signup', 'tos', 'privacy', 'account'],
  instagram: ['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'about', 'legal', 'directory'],
  bilibili: ['video', 'read', 'opus', 'bangumi', 'search', 'account'],
  pixiv: ['artworks', 'i', 'en', 'tags', 'search', 'ranking', 'novel', 'ajax'],
  xiaohongshu: ['user', 'explore', 'discovery', 'search', 'notification', 'login', 'website-login'],
  douyin: ['user', 'video', 'note', 'search', 'login', 'jingxuan', 'follow'],
  tiktok: ['video', 'tag', 'search', 'login', 'signup', 'settings', 'foryou', 'discover'],
  threads: ['post', 'tag', 'search', 'login', 'explore', 'settings'],
  facebook: ['groups', 'watch', 'events', 'marketplace', 'p', 'share', 'photo', 'photos', 'video', 'videos', 'reel', 'reels', 'login', 'signup', 'help', 'privacy', 'policies', 'business', 'ads', 'story', 'stories', 'permalink', 'media', 'settings', 'search', 'home.php', 'sharer', 'dialog'],
  bluesky: ['search', 'settings', 'notifications', 'explore', 'hashtag', 'intent'],
  lofter: ['www', 'm', 'search', 'tag', 'login', 'post', 'view']
};

function matchPlatform(url) {
  for (const rule of PLATFORM_RULES) {
    const m = String(url ?? '').match(rule.re);
    if (!m) continue;
    const handle = String(m[1] ?? '');
    const deny = PATH_DENY[rule.platform] ?? [];
    if (deny.includes(handle.toLowerCase())) continue;
    if (rule.platform === 'weibo') {
      // weibo.com/123456 这种纯数字才是 uid；weibo.com/abc 是昵称路径，也能用
      if (!/^\d+$/.test(handle) && !/^[A-Za-z0-9_\-]{3,}$/.test(handle)) continue;
    }
    if (rule.platform === 'instagram' && /^(p|reel|explore|accounts|stories)$/i.test(handle)) continue;
    if (rule.platform === 'twitter' && /^(i|intent|share|home|search)$/i.test(handle)) continue;
    const cleaned = rule.clean(m);
    // clean() 可以给出归一化后的 url（比如 pixiv 老站 member.php → /users/<id>）
    return { platform: rule.platform, ...cleaned, url: cleaned.url || String(url) };
  }
  return null;
}

/** 整条标题当人名的兜底太脏（会得到「阿抽崽on X: \"hi\" / X」这种），先过滤掉不像名字的。 */
export function looksLikePersonName(value) {
  const text = String(value ?? '').trim();
  if (text.length < 2 || text.length > 24) return false;
  if (/["':：/|]/.test(text)) return false;
  if (/\b(on|via|by)\s+(x|twitter|instagram|ig|weibo|bilibili|tiktok|facebook|threads)\b/i.test(text)) return false;
  return true;
}

/** 人名归一：小写、去空格与常见标点，用来做「这俩是不是同一串字」的粗比较。 */
export function normalizePersonName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\-_·・.,，。:：;；!！?？'"“”‘’()（）\[\]【】{}<>《》|/\\~—–]+/g, '');
}

/**
 * 找出「这一批结果主要在讲谁」：把候选里出现过的名字（作者行、社交卡片、主页标题）逐个拿去
 * 比对所有结果的标题，某个名字或它的前几个字命中最多条结果，就以它为主轴。
 * 只命中自己那一条的名字（hits 减掉自身后为 0）不算证据 —— 那就是搭便车的别人。
 */
export function dominantPersonName(candidates, { minHits = 1, minPrefix = 4 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const titles = list
    .map((candidate) => normalizePersonName(`${candidate?.title ?? ''} ${candidate?.snippet ?? ''}`))
    .filter((text) => text.length >= minPrefix);
  if (!titles.length) return { name: '', prefix: '', hits: 0 };
  const names = new Map();
  const add = (raw) => {
    const key = normalizePersonName(raw);
    if (key.length < minPrefix || names.has(key)) return;
    names.set(key, String(raw ?? '').trim());
  };
  for (const candidate of list) {
    add(candidate?.authorName);
    add(profileTitleName(String(candidate?.title ?? '')).name);
    add(socialNameFromTitle(String(candidate?.title ?? '')));
    // 标题里写的名字（`CN : 阿薰kaOri`）也是证据：同一批结果里它出现在好几条标题上，
    // 就说明这张图讲的是这个人 —— 哪怕账号卡片是别人发的。
    add(nameFromTitleMention(String(candidate?.title ?? '')));
  }
  let best = { name: '', prefix: '', hits: 0 };
  // 短名先占位：同票时留「阿薰kaori」这种干净写法，而不是「阿薰kaOriCOSPlayerVN」。
  const keys = [...names.keys()].sort((a, b) => a.length - b.length);
  for (const key of keys) {
    // 从长到短试前缀：「阿薰kaori防盗版」整串只命中 1 条，砍到「阿薰kaori」就命中好几条
    for (let len = Math.min(key.length, 12); len >= minPrefix; len -= 1) {
      const head = key.slice(0, len);
      const hits = titles.filter((text) => text.includes(head)).length - 1;
      if (hits < minHits) continue;
      if (hits > best.hits) best = { name: names.get(key) ?? key, prefix: head, hits };
      break;
    }
  }
  return best;
}

/**
 * 真人 coser 图没有「账号」可认 —— 但收录站（v2ph / telegra.ph / hentai-cosplay 等）的标题
 * 几乎都是 `<作者> - <角色> - <站名>`。所以把标题里的拉丁词按「位置加权 + 跨站加成」打分：
 * 越靠前的搜索结果、越多个站点重复提到的名字，越可能是这张图真正的作者。
 * 只取拉丁词（中文名留给 CN:/Coser: 那几条既有规则），站点域名里的词直接排掉。
 */
const NAME_HINT_DENY = new Set([
  'www', 'com', 'net', 'org', 'html', 'php', 'htm', 'jp', 'ru', 'cn', 'me', 'cc',
  'cosplay', 'cosplayer', 'coser', 'hentai', 'anime', 'manga', 'photo', 'photos',
  'image', 'images', 'gallery', 'album', 'telegraph', 'danbooru', 'donmai', 'pixiv',
  'twitter', 'weibo', 'bilibili', 'facebook', 'instagram', 'tiktok', 'yandex',
  'blue', 'archive', 'azarashi', 'download', 'page', 'part', 'vol', 'set', 'sex',
  'nude', 'naked', 'sexy', 'girl', 'girls', 'asian', 'fetish', 'leak', 'leaks',
  'onlyfans', 'telegram', 'reddit', 'series', 'collection', 'preview', 'sample',
  'pin', 'pins', 'pinterest', 'love', 'art', 'arts', 'design', 'idea', 'ideas',
  'inspiration', 'board', 'saved', 'share', 'view', 'watch', 'video', 'videos',
  'foto', 'fotos', 'look', 'looks', 'style', 'beauty', 'pretty', 'cute'
]);


/** 搜索结果里的收录页地址常带 utm_ 与 hl 一串追踪参数，贴给用户看太脏。 */
function cleanPageUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(hl|ref|source|_source|srsltid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return String(value ?? '');
  }
}

export function nameHintsFromCandidates(candidates, { max = 3, minScore = 0.2, minHits = 2 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return [];
  // 域名拆词也当站点词排掉：v2ph.ru 的 "v2ph"、telegra.ph 的 "telegra" 都不是人
  const hostWords = new Set();
  for (const candidate of list) {
    for (const part of String(candidate?.host ?? '').toLowerCase().split(/[.\-_]/)) {
      if (part.length >= 3) hostWords.add(part);
    }
  }
  const stats = new Map();
  for (const candidate of list) {
    const position = Number(candidate?.position);
    if (!Number.isFinite(position) || position <= 0) continue;
    const title = stripTags(String(candidate?.title ?? ''));
    if (!title) continue;
    const seen = new Set();
    for (const raw of title.match(/[A-Za-z][A-Za-z0-9_.]{2,23}/g) ?? []) {
      const key = raw.toLowerCase().replace(/[._]+$/, '');
      if (key.length < 3 || seen.has(key)) continue;
      if (NAME_HINT_DENY.has(key) || hostWords.has(key)) continue;
      if (/^\d/.test(key)) continue;
      seen.add(key);
      const row = stats.get(key) ?? { token: raw.replace(/[._]+$/, ''), score: 0, hits: 0, hosts: new Set(), urls: [] };
      row.score += 1 / position;
      row.hits += 1;
      if (candidate?.host) row.hosts.add(String(candidate.host).toLowerCase());
      // 用户要的不只是名字，是「去哪儿看」——把收录页地址按相关度顺序留着
      const page = String(candidate?.url || candidate?.sourceUrl || '').trim();
      if (/^https?:\/\//i.test(page) && row.urls.length < 3 && !row.urls.some((item) => item.url === page)) {
        row.urls.push({ url: cleanPageUrl(page), title: stripTags(String(candidate?.title ?? '')).slice(0, 60) });
      }
      stats.set(key, row);
    }
  }
  return [...stats.values()]
    .map((row) => ({
      name: row.token,
      hits: row.hits,
      // 好几个站都这么写 = 这个名字不是某一家的排版噪声
      score: row.hosts.size >= 2 ? row.score * 2 : row.score,
      hosts: [...row.hosts],
      urls: row.urls
    }))
    .filter((row) => row.hits >= minHits && row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

function formatNameHintsBlock(hints) {
  const list = Array.isArray(hints) ? hints.filter((hint) => hint?.name) : [];
  if (!list.length) return '';
  const lines = ['🔎 收录站的标题里反复出现的名字（越靠前越像作者）：'];
  list.forEach((hint, index) => {
    const hosts = Array.isArray(hint.hosts) ? hint.hosts.slice(0, 2) : [];
    const where = hosts.length ? `（${hosts.join('、')}）` : '';
    lines.push(`${index + 1}. ${hint.name}${where}`);
    // 每条只挂最相关的那一页，再多就把消息撑爆了
    const page = (Array.isArray(hint.urls) ? hint.urls : []).find((item) => item?.url)?.url;
    if (page) lines.push(`   → ${page}`);
  });
  const first = String(list[0]?.name ?? '');
  if (first) {
    lines.push(`· 大概率就是这个人，点点看：https://x.com/${first} ｜ https://weibo.com/n/${first}`);
  }
  return lines.join('\n');
}

/** 从候选结果里抽社媒账号。只认 URL 证据 —— 没有证据的 handle 一律不写。 */
// 单条帖子 / 视频 / 图集链接：帖主往往只是转发，不是图里的人。
// 判定成弱证据，避免拿路人的帖子当"找到了这个人"。
const POST_URL_RE = /\/(status|statuses|posts?|p|video|videos|reel|reels|photo|photos|discover|explore|discovery|note|notes|item|moments|album|permalink)\//i;
export function isPostUrl(url) {
  return POST_URL_RE.test(String(url ?? ''));
}

/**
 * 引擎给的位次 = 最可靠的「这张图到底是谁」信号。
 * Lens 第 1 条基本就是原图/原帖；第 8 条往后多是「长得像的热门搬运」。
 * 老逻辑只看「名字在标题里出现几次」，会把第 1 条（真图源）因为名字对不上丢掉，
 * 转头报出第 5 条以后那些号 —— 真人图「查到一堆别人的号」就是这么来的。
 */
function rankOf(candidate) {
  const pos = Number(candidate?.position);
  if (Number.isFinite(pos) && pos > 0) return pos;
  if (candidate?.engine === 'saucenao') {
    const sim = Number(candidate?.similarity);
    if (Number.isFinite(sim) && sim >= 0.9) return 1;
    if (Number.isFinite(sim) && sim >= 0.75) return 4;
    return 12;
  }
  if (candidate?.engine === 'iqdb') return 3;
  if (candidate?.engine === 'tracemoe') return 2;
  return 40;
}

export function extractAccounts(candidates, { max = 3, onDrop = null, strictNames = true, preferArtwork = 'auto', minSimilarity = 0.65 } = {}) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(candidates) ? candidates : [];
  for (const candidate of list) {
    // SauceNAO 找不到时不是回空，而是回一串 45~55% 的「别的图」。
    // 那种命中不是这张图的出处 —— 直接当成答案就是把不相干的画师报出去（实测报过别人的画师）。
    const sim = Number(candidate?.similarity);
    if (candidate?.engine === 'saucenao' && Number.isFinite(sim) && sim > 0 && sim < minSimilarity) {
      if (typeof onDrop === 'function') {
        try {
          onDrop({ weakArtwork: candidate });
        } catch {
          // 统计用的回调，出错也不能影响结果
        }
      }
      continue;
    }
    const authorHit = candidate?.authorUrl ? matchPlatform(candidate.authorUrl) : null;
    const authorKey = authorHit ? authorHit.platform + '|' + authorHit.handleKey : '';
    // 这条候选自己抽出了几个号：0 个才考虑退回「danbooru 画师名」
    let ownAccounts = 0;
    const urls = [];
    // originalUrl 是 danbooru 记下的「最初发布地址」，优先级排在 danbooru 页面前面：
    // 用户在 danbooru 页里找不到人，在推特原帖/小红书笔记里却能一眼看见作者。
    for (const value of [candidate?.authorUrl, candidate?.originalUrl, candidate?.sourceUrl, candidate?.url, ...(candidate?.links ?? [])]) {
      if (value) urls.push(value);
    }
    // 标题/摘要里偶尔也带完整链接
    for (const text of [candidate?.title, candidate?.snippet]) {
      const found = String(text ?? '').match(/https?:\/\/[^\s"'<>）)]+/g);
      if (found) urls.push(...found);
    }
    for (const url of urls) {
      const hit = matchPlatform(url);
      if (!hit) continue;
      const dedupe = hit.platform + '|' + hit.handleKey;
      const profileName = profileTitleName(candidate?.title);
      const fallbackName = authorNameFromTitle(candidate?.title);
      const ownName =
        profileName.name ||
        socialNameFromTitle(candidate?.title) ||
        String(candidate?.authorName ?? '') ||
        (dedupe === authorKey || !looksLikePersonName(fallbackName) ? '' : fallbackName);
      if (seen.has(dedupe)) {
        // 同一个号被多个引擎撞见时，谁先到并不代表谁的标题更完整（扫描日期在前、作者在后很常见），
        // 所以后面再遇到带名字的就补上。
        const existing = out.find((item) => item.platform + '|' + String(item.handle ?? '').replace(/^@/, '').toLowerCase() === dedupe);
        if (existing && !existing.authorName && ownName) existing.authorName = ownName;
        // 两个独立来源都指向同一个号 → 不再是"孤立帖子"，升级为 direct
        if (existing && existing.confidence === 'weak' && !isPostUrl(url)) existing.confidence = 'direct';
        ownAccounts += 1;
        continue;
      }
      seen.add(dedupe);
      ownAccounts += 1;
      out.push({
        platform: hit.platform,
        handle: hit.handle,
        url: hit.url,
        // 作者行带出来的名字（`Member: ... <a>名字</a>`）比作品标题更像「这个人叫什么」
        authorName: ownName,
        confidence: candidate.weak || isPostUrl(url) ? 'weak' : 'direct',
        leadRank: rankOf(candidate),
        lead: rankOf(candidate) <= 3,
        evidence: {
          engine: candidate.engine ?? '',
          similarity: candidate.similarity ?? null,
          position: candidate.position ?? null,
          sourceUrl: candidate.sourceUrl ?? '',
          artistTag: String(candidate.artistTag ?? ''),
          originalUrl: String(candidate.originalUrl ?? '')
        }
      });
    }
    // danbooru 只记着「这图是谁画的」，本身没有社媒号。一个号都抽不出来时，
    // 画师名就是答案：小红书/微博搬运图往往只有 danbooru 这一条线，报不出号也得给个人名。
    if (!ownAccounts) {
      const artist = String(candidate?.authorName ?? candidate?.artistTag ?? '').trim();
      const pageUrl = String(candidate?.sourceUrl || candidate?.url || '');
      if (artist && /danbooru\.donmai\.us/i.test(pageUrl)) {
        const dedupe = 'danbooru|' + artist.toLowerCase();
        if (!seen.has(dedupe)) {
          seen.add(dedupe);
          out.push({
            platform: 'danbooru',
            handle: artist,
            url: pageUrl,
            authorName: artist,
            confidence: 'weak',
            leadRank: rankOf(candidate),
            lead: rankOf(candidate) <= 3,
            evidence: {
              engine: candidate.engine ?? '',
              similarity: candidate.similarity ?? null,
              position: candidate.position ?? null,
              sourceUrl: candidate.sourceUrl ?? '',
              artistTag: String(candidate.artistTag ?? ''),
          originalUrl: String(candidate.originalUrl ?? '')
            }
          });
        }
      }
    }
    // 标题里 @ 到的账号：cos 图被转发时，转发者常在标题里 @ 原作者
    // （「少年rode on X: "@aqua_cosplay 慕名而来"」这种情况，答案在标题里，不在帖主身上）
    const ownHit = matchPlatform(candidate?.sourceUrl || candidate?.url);
    if (ownHit && ownHit.platform === 'twitter') {
      const text = `${candidate?.title ?? ''} ${candidate?.snippet ?? ''}`;
      for (const mm of text.matchAll(/@([A-Za-z0-9_]{2,20})/g)) {
        const handle = mm[1];
        const dedupe = 'twitter|' + handle.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push({
          platform: 'twitter',
          handle: '@' + handle,
          url: `https://x.com/${handle}`,
          // 用 handle 当名字，好让它参与「主轴名字」比对
          authorName: handle,
          confidence: 'weak',
          mentioned: true,
          evidence: {
            engine: candidate.engine ?? '',
            similarity: candidate.similarity ?? null,
            // 必须用自己的主页地址：沿用原帖 sourceUrl 会在去重时被当成同一个人合并掉
            sourceUrl: `https://x.com/${handle}`
          }
        });
      }
    }
    // bilibili 图文页：从 sourceUrl 里挖 mid
    const bili = String(candidate?.sourceUrl ?? '').match(BILIBILI_AUTHOR_RE);
    if (bili) {
      const dedupe = 'bilibili|' + bili[1];
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        out.push({
          platform: 'bilibili',
          handle: bili[1],
          url: `https://space.bilibili.com/${bili[1]}`,
          confidence: candidate.weak ? 'weak' : 'direct',
          evidence: {
            engine: candidate.engine ?? '',
            similarity: candidate.similarity ?? null,
            sourceUrl: candidate.sourceUrl ?? ''
          }
        });
      }
    }
  }
  // 同一张图/同一条原帖只能对应一个作者：SauceNAO 常同时给出
  // `weibo.com/n/昵称` 与 `weibo.com/u/数字uid` —— 那是一个人，不能当成两个账号报出去。
  // 归一规则：按 platform + 原帖地址分组，组内只留「最正式」的那条 URL。
  const canonicalScore = (account) => {
    const url = String(account.url ?? '');
    if (/\/u\/\d{3,}/.test(url)) return 3;              // weibo.com/u/<uid>
    if (/space\.bilibili\.com\/\d+/.test(url)) return 3;
    if (/members?\.php\?|pixiv\.net\/users\/\d+/.test(url)) return 3;
    if (/\/(?:n|profile)\//.test(url)) return 1;        // weibo.com/n/<昵称>：会 302 到 uid
    return 2;
  };
  const bySource = new Map();
  const rank = (account) => (account.confidence === 'direct' ? 0 : account.confidence === 'weak' ? 1 : 2);
  for (const account of out) {
    // 没有原帖地址时退回自己的 url 分组：否则「同平台但没 sourceUrl」的两个人会被当成同一个人，
    // 只留下一个（真机上 Lens 的候选是带 sourceUrl 的，但其他引擎不一定）。
    const group = `${account.platform}|${account.evidence?.sourceUrl || account.url || ''}`;
    const prev = bySource.get(group);
    if (!prev) { bySource.set(group, account); continue; }
    if (rank(account) < rank(prev)) { bySource.set(group, account); continue; }
    if (rank(account) === rank(prev) && canonicalScore(account) > canonicalScore(prev)) bySource.set(group, account);
  }
  const deduped = [...new Set(bySource.values())];
  // 同一个 cos 角色常有好几个 coser 各拍一版，Lens 会把别人的原帖一起带回来（查「尤诺」时
  // 混进另一个 coser 的推文就是这种情况）。判断「谁是这张图的人」看出现次数：某个名字（或它
  // 的前几个字）在多条结果的标题里都出现，说明整批结果都在讲同一个人；只出现一次的就是搭便车。
  // 名字对不上的号一律不报 —— 宁可少报，也别把小鲸鱼报成别人的号。
  const consensus = dominantPersonName(list);
  const artworkOnly = deduped.length > 0 && deduped.every((account) => ARTWORK_PLATFORMS.has(account.platform));
  const nameOf = (account) => normalizePersonName(account?.authorName);
  const namedMatch = consensus.prefix && !artworkOnly
    ? deduped.filter((account) => {
      const name = nameOf(account);
      if (!name) return false;
      return name.startsWith(consensus.prefix) || consensus.prefix.startsWith(name);
    })
    : [];
  // 只要认出了主轴，就只报「名字对得上」的号：对不上的、没名字的一律不报 ——
  // 报出去就是把别人的账号当成这个人（查尤诺那次报成 @Akane_ACZ 就是这么漏的）。
  // 主轴要求「同一串名字出现在 ≥2 条结果标题里」，所以单个候选的噪声名字不会触发这条。
  // strictNames=false 是给本人留的后门：有的作者压根不在标题里写名字，
  // 严格模式会变成「明明翻到了却报没查到」。关掉它就把所有号都报出来，
  // 由本人自己认。默认仍然是严格的那一套。
  const strictName = strictNames !== false && Boolean(consensus.prefix) && !artworkOnly;
  // 位次靠前的号即使「名字对不上主轴」也保留：那是引擎自己排在最前面的「这就是原图」。
  // 名字主轴仍然负责挡掉靠后的那一堆别人的号（宁缺毋滥的部分留着）。
  const leads = deduped.filter((account) => account.lead);
  const mergeUnique = (basis, extra) => {
    const merged = [];
    const keys = new Set();
    for (const item of [...basis, ...extra]) {
      const key = `${item.platform}|${String(item.handle ?? '').replace(/^@/, '').toLowerCase()}`;
      if (keys.has(key)) continue;
      keys.add(key);
      merged.push(item);
    }
    return merged;
  };
  let keptList = strictName ? mergeUnique(namedMatch, leads) : deduped;

  // 标题里 @ 到的号：cos 图被转发时，帖主只是搬运工，被 @ 的才是原作者。
  // 认出提及号时只报它，把帖主丢掉；但要求提及号与「主轴名字」对得上，
  // 免得把随手提的朋友也当成本人。
  const mentionedList = keptList.filter((acc) => acc.mentioned);
  if (mentionedList.length) {
    const prefix = consensus.prefix;
    // 和「主轴名字」对得上的提及才算数
    const matched = prefix
      ? mentionedList.filter((acc) => {
        const name = normalizePersonName(String(acc.handle ?? '').replace(/^@/, ''));
        return name && (name.startsWith(prefix) || prefix.startsWith(name));
      })
      : [];
    // 有真实主页（direct）的号是硬证据，不能因为别处有 @ 就丢掉；
    // 没主页时，才让「被 @ 的那个」顶上去，把搬运工丢掉。
    const directOnes = keptList.filter((acc) => acc.confidence === 'direct' && !acc.mentioned);
    if (directOnes.length) {
      keptList = keptList.filter((acc) => directOnes.includes(acc) || matched.includes(acc));
    } else if (matched.length) {
      keptList = matched;
    } else {
      keptList = mentionedList;
    }
  }
  // 被「名字对不上主轴」挡掉的号要报给调用方：否则用户只看到「没查到」，
  // 不知道其实翻到了别人的帖子，只是没把它当成这个人。
  if (strictName && typeof onDrop === 'function') {
    for (const account of deduped) {
      if (namedMatch.includes(account)) continue;
      try {
        onDrop({ account, consensus });
      } catch {
        // 统计用的回调，出错也不能影响结果
      }
    }
  }

  // 排序默认是 auto：认得出「这是插画」就把 pixiv 画师顶到最前，认不出（cos 照）才让社交号在前。
  // 之前那种「社交平台恒优先、pixiv 恒垫底」的硬规则正是毛病所在 —— 二次元图本来就该报画师，
  // 硬压 pixiv 等于把画师换成搬运贴的号。preferArtwork 可强制 'pixiv' / 'social'。
  const SOCIAL_PLATFORMS = new Set(['twitter', 'weibo', 'bilibili', 'instagram', 'tiktok', 'threads', 'facebook']);
  const artworkMode = (() => {
    const value = String(preferArtwork ?? 'auto').trim().toLowerCase();
    if (value === 'pixiv' || value === 'artwork') return 'pixiv';
    if (value === 'social') return 'social';
    return 'auto';
  })();
  // SauceNAO 对真插画能给 0.85~0.99，对 cos 照基本出不了画作命中；0.75 是留了重压缩/裁图的余量。
  const ARTWORK_MIN_SIMILARITY = 0.75;
  const strongArtwork = keptList.some(
    (acc) => ARTWORK_PLATFORMS.has(acc.platform) && Number(acc.evidence?.similarity ?? 0) >= ARTWORK_MIN_SIMILARITY
  );
  const artworkFirst = artworkMode === 'pixiv' || (artworkMode === 'auto' && strongArtwork);
  const tier = (acc) => {
    const artwork = ARTWORK_PLATFORMS.has(acc.platform);
    const social = SOCIAL_PLATFORMS.has(acc.platform);
    if (artworkMode === 'social') return artwork ? 1 : social ? -1 : 0;
    if (artworkFirst) return artwork ? -1 : 0; // 认得出是插画：pixiv 画师第一，其余按置信度排
    return artwork ? 1 : social ? -1 : 0;
  };
  // SauceNAO 打到 0.9 以上 = 这张图就是那张插画，画师是硬答案。
  // 这时别让 Lens 的「长得像的第 1 条」压过它 —— 二次元图经常被这么带偏到别人的号上。
  const strongSauce = list.some((c) => c?.engine === 'saucenao' && Number(c?.similarity) >= 0.9);
  const sauceLead = (acc) => acc.evidence?.engine === 'saucenao' && Number(acc.evidence?.similarity ?? 0) >= 0.85;
  keptList.sort((a, b) => {
    if (sauceLead(a) !== sauceLead(b)) return sauceLead(a) ? -1 : 1;
    // 再看引擎位次：第 1 条永远排第 1，不管别人标题里名字写得多全。
    // 已经确认是插画时，Lens 的位次只剩参考价值，让位给画作平台。
    const pa = a.lead && !strongSauce ? Number(a.leadRank ?? 99) : 999;
    const pb = b.lead && !strongSauce ? Number(b.leadRank ?? 99) : 999;
    if (pa !== pb) return pa - pb;
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    // 同为弱证据时，「被 @ 的人」优先于「发帖的人」：
    // 转发者写 "@aqua_cosplay 慕名而来" 时，图里的是被 @ 的那个。
    const ma = a.mentioned ? 0 : 1;
    const mb = b.mentioned ? 0 : 1;
    if (ma !== mb) return ma - mb;
    const sa = a.evidence?.similarity ?? -1;
    const sb = b.evidence?.similarity ?? -1;
    if (sb !== sa) return sb - sa;
    return (PLATFORM_WEIGHT[a.platform] ?? 9) - (PLATFORM_WEIGHT[b.platform] ?? 9);
  });
  return keptList.slice(0, Math.max(1, Number(max) || 3));
}

/**
 * 图源线索：一个人名都没认出来时，也得把「最像的那几条网页」给用户。
 * 老版本这时只回一句「没查到账号」，把引擎已经翻到的链接全扔了 ——
 * 用户要的是「这图哪来的」，经常一条链接就够他自己认。
 */
export function topSources(candidates, { max = 3, minSimilarity = 0.6 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const rows = [];
  const seen = new Set();
  for (const candidate of list) {
    // 原始发布地址排第一：danbooru 页里没有人名，原帖里才有
    const url = String(candidate?.originalUrl || candidate?.sourceUrl || candidate?.url || '');
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    const sim = Number(candidate?.similarity);
    // SauceNAO 的低分命中是「别的图」，不是这张的出处
    if (candidate?.engine === 'saucenao' && Number.isFinite(sim) && sim > 0 && sim < minSimilarity) continue;
    seen.add(url);
    rows.push({
      url,
      title: trimText(stripTags(String(candidate?.title ?? '')), 70),
      engine: candidate?.engine ?? '',
      position: Number.isFinite(Number(candidate?.position)) ? Number(candidate.position) : null,
      similarity: Number.isFinite(sim) ? sim : null,
      // 引擎位次越小越可信；没有位次的（老引擎）排在后面
      score: rankOf(candidate)
    });
  }
  rows.sort((a, b) => a.score - b.score);
  const out = [];
  const seenUrl = new Set();
  for (const row of rows) {
    // 同一条帖子的 /status/123 与主页是两回事，都留着；只去一模一样的地址
    if (seenUrl.has(row.url)) continue;
    seenUrl.add(row.url);
    out.push(row);
    if (out.length >= Math.max(1, Number(max) || 3)) break;
  }
  return out;
}

/** 画作平台的「相似画作」不等于图源：相似度不够的一律丢，别当 coser 的号报出去。 */
export function dropWeakArtwork(accounts, minSimilarity = 0.75) {
  const min = Number(minSimilarity);
  const limit = Number.isFinite(min) && min > 0 ? min : 0.75;
  const kept = [];
  let dropped = 0;
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!ARTWORK_PLATFORMS.has(account?.platform)) { kept.push(account); continue; }
    const similarity = Number(account?.evidence?.similarity ?? 0);
    if (Number.isFinite(similarity) && similarity >= limit) kept.push(account);
    else dropped += 1;
  }
  return { accounts: kept, dropped };
}

function platformLabel(platform) {
  const name = ({ twitter: 'Twitter', weibo: '微博', bilibili: 'B站', instagram: 'Instagram', pixiv: 'Pixiv', danbooru: 'Danbooru' })[platform] ?? platform;
  return ARTWORK_PLATFORMS.has(platform) ? `${name}（画作平台）` : name;
}

// ── inferred 账号（搜索交叉验证，最多 2 个） ──────────────────────────────
//
// 口径：**direct 优先且必须已有 direct**。只有「同一作品/作者名 + 同平台账号页」
// 在同一份搜索结果里同时出现时才采纳，否则丢弃 —— 宁缺毋滥，绝不凭名字猜 handle。

const INFER_PLATFORMS = ['twitter', 'weibo', 'bilibili'];
const INFER_QUERY_HINT = { weibo: '微博', twitter: 'Twitter', bilibili: 'B站' };

/** 从候选标题里剥出「像作者名」的片段（去掉【分组】【漫画】这类方括号内容）。 */
export function authorNameFromTitle(title) {
  const text = trimText(stripTags(String(title ?? '')), 120);
  if (!text) return '';
  const cleaned = text
    .replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const candidate = cleaned || text;
  return candidate.length >= 2 && candidate.length <= 24 ? candidate : '';
}

/**
 * 谷歌 Lens 的社交卡片标题长这样：`X吴二棒on X: "…"`、`Instagram 某coser on Instagram: 1/3`。
 * 作者名就是那个「on <站点>」前面的部分 —— 比从整段文案里猜准得多。
 */
/**
 * 从标题里挖 coser 名字。Lens 的脸书 / Coser吧 / 贴吧卡片常把名字直接写在标题里
 * （`CN : 阿薰kaOri`、`动漫博主阿薰kaOri NO.049`），那不是账号卡片，
 * 所以原来的名字来源取不到 —— 「整批结果都在讲阿薰kaOri」这条最有力的证据就丢了。
 * 只做保守提取：抓到的东西还必须在别的标题里也出现，才会被当成主轴（见 dominantPersonName）。
 */
export function nameFromTitleMention(title) {
  const text = String(title ?? '');
  if (!text) return '';
  const patterns = [
    // 注意不要写 \bCN：`FacebookCN : 阿薰kaOri` 里 k 和 C 之间没有词边界，带上 \b 就匹配不到了
    /CN\s*[:：]\s*([\p{L}\p{N}_@.]{2,24})/iu,
    /(?:coser|cosplayer|cos)\s*[:：\-_]\s*([\p{L}\p{N}_@.]{2,24})/iu,
    /(?:博主|coser|cosplayer)(?![吧网站群])([\u4e00-\u9fff][\p{L}\p{N}_@.]{1,23})/iu
  ];
  for (const pattern of patterns) {
    const hit = text.match(pattern);
    if (!hit) continue;
    // 中文里常见「Coser吧…」「博主网…」，把开头的语气词/站点词削掉再当名字
    const name = String(hit[1] ?? '').replace(/^(?:吧|网|站|群|们|的)+/, '').trim();
    if (name && looksLikePersonName(name)) return name;
  }
  return '';
}

export function socialNameFromTitle(title) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const m = text.match(
    /^(?:X|Twitter|推特|Instagram|IG|Ins|TikTok|抖音|微博|Weibo|Bilibili|哔哩哔哩|Facebook|Threads)\s*(.{1,32}?)\s*on\s*(?:X|Twitter|Instagram|TikTok|Facebook|Threads|微博|Bilibili)\b/i
  );
  if (!m) return '';
  return m[1].trim().replace(/[:："'“”]+$/, '').slice(0, 40);
}

/**
 * 主页卡片标题长这样：`X阿薰kaOri防盗版(@izayoill) / X`、`Instagram 某coser(@abc) • Instagram`。
 * 名字取 `(` 之前、去掉开头的平台徽标；顺带把 handle 也带出来（和 URL 互相印证）。
 */
export function profileTitleName(title) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { name: '', handle: '' };
  const m = text.match(
    /^(?:X|Twitter|推特|Instagram|IG|Ins|TikTok|抖音|微博|Weibo|Bilibili|哔哩哔哩|Facebook|Threads)\s*(.{1,40}?)\s*[（(]\s*@?([A-Za-z0-9_.\-]{2,30})\s*[)）]/i
  );
  if (!m) return { name: '', handle: '' };
  const name = m[1].trim().replace(/[:：]+$/, '');
  return { name, handle: m[2] };
}

function accountKeyOf(account) {
  const handle = String(account?.handle ?? '').replace(/^@/, '').toLowerCase();
  return `${account?.platform}|${handle}`;
}

/**
 * 搜索交叉验证，产出 inferred 账号。
 * @param {object} options
 * @param {Array} options.accounts  已有的 direct 账号（为空则直接返回 []）
 * @param {Array} options.candidates 引擎候选（从中取作者名）
 * @param {(query: string) => Promise<Array<{url?: string, title?: string}>>} options.search
 */
export async function inferAccounts({ accounts = [], candidates = [], search, max = 2, platforms = INFER_PLATFORMS, nameLimit = 3, onLog } = {}) {
  const direct = (Array.isArray(accounts) ? accounts : []).filter((item) => item?.confidence === 'direct');
  if (!direct.length) return [];
  if (typeof search !== 'function' || max <= 0) return [];

  // 搜索用的名字：作者行给的名字最准（`豊栄@ﾄﾞﾔｧ…`），没有才退回作品标题里的片段。
  const namesRaw = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const own = String(candidate?.authorName ?? '').replace(/[…\.]{2,}$/g, '').trim();
    const name = own || authorNameFromTitle(candidate?.title);
    if (name) namesRaw.push(name);
  }
  const names = [...new Set(namesRaw)].slice(0, Math.max(1, Number(nameLimit) || 3));
  if (!names.length) return [];

  const seen = new Set(direct.map(accountKeyOf));
  const wanted = (Array.isArray(platforms) && platforms.length ? platforms : INFER_PLATFORMS)
    .filter((platform) => !direct.some((item) => item.platform === platform));
  const out = [];

  for (const name of names) {
    for (const platform of wanted) {
      if (out.length >= max) return out;
      let results = [];
      try {
        results = await search(`${name} ${INFER_QUERY_HINT[platform] ?? platform} 账号`);
      } catch (error) {
        if (onLog) onLog(`[菲比找鸡] 推断搜索失败（${name} / ${platform}）：${error?.message ?? error}`);
        continue;
      }
      for (const result of Array.isArray(results) ? results : []) {
        const hit = matchPlatform(result?.url);
        if (!hit || hit.platform !== platform) continue;
        // 「同名」必须能在结果标题里看到，否则就是撞了别人的号
        if (!String(result?.title ?? '').includes(name)) continue;
        const key = hit.platform + '|' + String(hit.handle).replace(/^@/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          platform: hit.platform,
          handle: hit.handle,
          url: hit.url,
          confidence: 'inferred',
          evidence: { engine: 'search', similarity: null, sourceUrl: hit.url, name }
        });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/** 名字：优先 weibo 昵称形态的 handle，其次「图源那一条候选的标题里像人名的片段」，最后退回 handle。 */
export function accountNameOf(account, candidates = []) {
  const url = String(account?.url ?? '');
  const nick = url.match(/weibo\.com\/n\/([^/?#]+)/i);
  if (nick) {
    try { return decodeURIComponent(nick[1]); } catch { return nick[1]; }
  }
  const handle = String(account?.handle ?? '').replace(/^@/, '');
  const own = String(account?.authorName ?? '').trim();
  if (own) return own;
  // 纯数字 id（pixiv 会员号 / 微博 uid）不能拿标题当名字 —— 作品标题不是人名，
  // 之前会输出「名字：KING」这种把画作名当画师名的结果。
  const numeric = /^\d+$/.test(handle);
  if (numeric) return '未知';
  const source = account?.evidence?.sourceUrl ?? '';
  const list = Array.isArray(candidates) ? candidates : [];
  const same = list.find((c) => c?.sourceUrl && source && c.sourceUrl === source)
    ?? list.find((c) => c?.sourceUrl && c.title);
  const fromTitle = same
    ? profileTitleName(same.title).name || authorNameFromTitle(same.title)
    : '';
  if (fromTitle) return fromTitle;
  if (handle) return handle;
  return '未知';
}

/** 账号展示：昵称类加 @，纯数字 id（微博 uid / B站 mid / pixiv 会员号）只给数字，链接另附。 */
function displayHandle(account) {
  const handle = String(account?.handle ?? '').replace(/^@/, '').trim();
  if (!handle) return '未知';
  return /^\d+$/.test(handle) ? handle : `@${handle}`;
}

/**
 * 拼回话。账号回复按用户指定的固定版式：
 *   🎯 **菲比找鸡结果**
 *   🌐 平台：…
 *   👤 名字：…
 *   🆔 账号：…（主页链接跟在账号后面，方便点开核对）
 * 多个账号之间空一行；inferred 的账号在账号行尾标「推断」。
 */
function formatAiBlock(ai) {
  if (!ai) return '';
  if (ai.skipped) return `🤖 AI 检测：${ai.skipped}`;
  const score = Number(ai.score);
  const pct = Number.isFinite(score) ? Math.round(score * 100) : 0;
  const gens = ai.generators && typeof ai.generators === 'object'
    ? Object.entries(ai.generators)
      .map(([name, value]) => [name, Number(value)])
      .filter(([, value]) => Number.isFinite(value) && value > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, value]) => `${name} ${Math.round(value * 100)}%`)
      .join(' / ')
    : '';
  const verdict = ai.isAI
    ? `疑似 AI 生成（${pct}%）`
    : `未检出明显 AI 特征（${pct}%）`;
  return `🤖 AI 检测：${verdict}${gens ? `\n生成器：${gens}` : ''}`;
}

const PIXIV_ARTWORK_RE = /pixiv\.net\/(?:(?:en|zh|ko)\/)?artworks\/(\d{4,})/i;
const DANBOORU_POST_RE = /(?:danbooru\.donmai\.us|safebooru\.donmai\.us)\/(?:post\/show\/|posts\/)(\d+)/i;

/**
 * 作品页 → 作者。
 *
 * 两次实测出来的硬需求：
 *   · Lens 对二次元图经常只给一条 `pixiv.net/artworks/123` —— 既不是「账号」也不含作者名，
 *     老逻辑当没看见，于是「明明翻到了却报没查到」；
 *   · SauceNAO 对插画最常给的是 `danbooru.donmai.us/post/show/123`（相似度 95%+），
 *     那同样是作品页，但 danbooru 自己记着 artist 标签和 pixiv_id，可以顺着摸回画师。
 * 只要 pixiv / danbooru 连得上，就用它们的公开接口补作者（失败就算了，不拖慢整体）。
 */
export async function enrichArtworkPages(candidates, { timeoutMs = 8000, max = 4, onLog } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const targets = [];
  const seen = new Set();
  for (const candidate of list) {
    const urls = [candidate?.sourceUrl, candidate?.url, ...(candidate?.links ?? [])].map(String);
    const pixiv = urls.map((url) => url.match(PIXIV_ARTWORK_RE)).find(Boolean);
    if (pixiv && !seen.has('pixiv:' + pixiv[1])) {
      seen.add('pixiv:' + pixiv[1]);
      targets.push({ kind: 'pixiv', id: pixiv[1], candidate });
    } else {
      const danbooru = urls.map((url) => url.match(DANBOORU_POST_RE)).find(Boolean);
      if (danbooru && !seen.has('danbooru:' + danbooru[1])) {
        seen.add('danbooru:' + danbooru[1]);
        targets.push({ kind: 'danbooru', id: danbooru[1], candidate });
      }
    }
    if (targets.length >= max) break;
  }
  if (!targets.length) return 0;

  // danbooru 在 Cloudflare 后面：带浏览器 UA 会被要求「Just a moment」，
  // 带一个诚实的程序 UA 反而直接给 JSON（实测 4 种 UA，浏览器那几个全 403）。
  const API_UA = 'fish-find-chicken/1.1 (+https://github.com/fish-find-chicken)';
  const json = async (url, headers = {}) => {
    const response = await fetch(url, {
      headers: { 'User-Agent': API_UA, Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    return response.json();
  };

  const applyPixiv = (candidate, body) => {
    const userId = String(body?.userId ?? '');
    const userName = String(body?.userName ?? '').trim();
    if (userId) candidate.authorUrl = `https://www.pixiv.net/users/${userId}`;
    if (userName) candidate.authorName = userName;
    if (!candidate.title && body?.illustTitle) candidate.title = String(body.illustTitle);
    return userName || userId;
  };

  let done = 0;
  await Promise.all(targets.map(async ({ kind, id, candidate }) => {
    try {
      if (kind === 'pixiv') {
        const data = await json(`https://www.pixiv.net/ajax/illust/${id}`, { Referer: 'https://www.pixiv.net/' });
        if (data?.error || !data?.body) return;
        const name = applyPixiv(candidate, data.body);
        done += 1;
        onLog?.(`pixiv 作品 ${id} → ${name}`);
        return;
      }
      const post = await json(`https://danbooru.donmai.us/posts/${id}.json`);
      if (!post || post.success === false) return;
      const artist = String(post.tag_string_artist ?? '').split(' ').filter(Boolean)[0] ?? '';
      // danbooru 的 source 就是这张图最初被发在哪：推特原帖 / 小红书笔记 / pixiv 原图。
      // 它比 title 可靠（title 常常只是「Twitter」两个字），是找回原作者最直接的一条线。
      // 小红书笔记页拿不到作者（无 cookie 只回登录页），但至少能把原帖地址交给用户。
      const originUrl = String(post.source ?? '').trim();
      if (/^https?:\/\//i.test(originUrl)) candidate.originalUrl = originUrl;
      // 画师 tag 单独留一份：pixiv 昵称会覆盖 authorName，tag 却是判「是不是这个人」的硬凭据
      if (artist) candidate.artistTag = artist;
      // danbooru 记着这张图最初来自哪个 pixiv 作品：顺着它拿画师昵称和主页
      if (post.pixiv_id) {
        const data = await json(`https://www.pixiv.net/ajax/illust/${post.pixiv_id}`, { Referer: 'https://www.pixiv.net/' });
        if (data?.body) {
          applyPixiv(candidate, data.body);
          done += 1;
          onLog?.(`danbooru ${id} → pixiv ${post.pixiv_id} → ${candidate.authorName}`);
          return;
        }
      }
      if (artist) {
        candidate.authorName = artist.replace(/_/g, ' ');
        if (!candidate.title) candidate.title = `Danbooru 作品 by ${candidate.authorName}`;
        done += 1;
        onLog?.(`danbooru ${id} → 画师 ${candidate.authorName}`);
      }
    } catch {
      // 补不到就保持原样，别让一条辅助请求拖垮整次查询
    }
  }));
  return done;
}

/**
 * AI 图的元数据块：模型、提示词、seed、C2PA。
 * 这些信息来自图片文件本身，不依赖任何反查引擎 —— 网上根本搜不到的 AI 图，
 * 靠它也能告诉用户「这图是怎么来的」。
 */
export function formatMetaBlock(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const lines = [];
  const generator = String(meta.generator ?? '').trim();
  const model = String(meta.model ?? '').trim();
  const tool = [generator, model].filter(Boolean).join(' · ');
  if (meta.isAI) {
    lines.push(`🤖 这张图是 AI 生成的${tool ? `（${trimText(tool, 60)}）` : ''}`);
    if (meta.prompt) lines.push(`📝 提示词：${trimText(String(meta.prompt).replace(/\s+/g, ' '), 200)}`);
    const bits = [];
    if (meta.seed) bits.push(`seed ${meta.seed}`);
    if (meta.steps) bits.push(`${meta.steps} 步`);
    if (meta.cfg) bits.push(`CFG ${meta.cfg}`);
    if (meta.sampler) bits.push(String(meta.sampler));
    if (meta.size) bits.push(String(meta.size));
    if (bits.length) lines.push(`⚙️ ${bits.join(' · ')}`);
    if (meta.c2pa) lines.push('🔏 带 C2PA 内容凭证（DALL·E / GPT 图片这类工具导出时会签名）');
  } else if (meta.c2pa) {
    lines.push('🔏 带 C2PA 内容凭证：这张图从生成工具导出时做过签名');
  }
  return lines.join('\n');
}

export function formatReply({ accounts = [], candidates = [], enginesUsed = [], failures = [], cached = false, withImage = false, artworkDropped = 0, nameDropped = 0, consensusName = '', droppedHandles = [], ai = null, links = [], meta = null, nameHints = [] } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const aiBlock = formatAiBlock(ai);
  // 认出主轴时，优先给「写着这个人名字」的原帖：那才是你要顺着找的那条。
  const pool = (Array.isArray(candidates) ? candidates : []).filter((c) => c?.sourceUrl);
  const consensusKey = normalizePersonName(consensusName);
  const decode = (value) => {
    try {
      return decodeURIComponent(String(value ?? ''));
    } catch {
      return String(value ?? '');
    }
  };
  const top = (consensusKey
    ? pool.find((candidate) => normalizePersonName(
      `${candidate?.title ?? ''} ${decode(candidate?.sourceUrl)}`
    ).includes(consensusKey))
    : null) ?? pool[0] ?? null;
  if (list.length) {
    const blocks = list.map((account) => {
      const url = String(account?.url ?? '').trim();
      // 原版没有这个后缀，去掉以免每条都挂着一串括号（置信度仍参与排序）
      const guess = '';
      const handle = `${displayHandle(account)}${url ? ` · ${url}` : ''}`;
      const artwork = String(account?.evidence?.sourceUrl ?? '').trim();
      const isDanbooru = account?.platform === 'danbooru';
      // danbooru 那条不是「账号」，是「画师名 + 原帖」——按账号排版会把名字印两遍
      const lines = isDanbooru
        ? [
          '🎨 平台：Danbooru（图被人搬过，只留下画师名）',
          `👤 画师：${String(account?.authorName || handle || '')}`
        ]
        : [
          `🌐 平台：${platformLabel(account.platform)}`,
          `👤 名字：${accountNameOf(account, candidates)}`,
          `🆔 账号：${handle}${guess}`
        ];
      // 用户要的是「哪一张图」，不只是「哪个人」：把命中这张图的原帖/作品页也带上。
      if (artwork && artwork !== url && !account.mentioned) lines.push(`🖼 作品：${artwork}`);
      // danbooru 记下的原始发布地址（推特原帖 / 小红书笔记）—— 顺着它才找得到人
      const origin = String(account?.evidence?.originalUrl ?? '').trim();
      if (origin && origin !== artwork && origin !== url) lines.push(`🔗 原帖：${origin}`);
      return lines.join('\n');
    });
    const head = `🎯 **菲比找鸡结果**${cached ? '（缓存）' : ''}`;
    const headLines = [head];
    if (list.some((account) => account.lead)) {
      headLines.push('（按「最像原图」排序，第 1 个最可能是原帖）');
    }
    let text = [headLines.join('\n'), blocks.join('\n\n')].join('\n\n');
    const onlyArtwork = list.every((account) => ARTWORK_PLATFORMS.has(account?.platform));
    // 名字提示只在「没认出真人」时才给：二次元图有账号了还硬塞 pinterest 标题里的
    // Pin / Love / art，纯属把好结果搅浑。
    const hintsBlock = onlyArtwork ? formatNameHintsBlock(nameHints) : '';
    if (onlyArtwork && hintsBlock) {
      // 画师那几块对「找照片里的人」是纯噪声，压成一行交代掉就够了
      const names = list.map((account) => accountNameOf(account, candidates)).filter(Boolean).slice(0, 3);
      const aside = names.length
        ? `· 另外还匹配到 ${list.length} 个画这个角色的画师（${names.join('、')}），不是照片里的人`
        : '';
      text = [headLines.join('\n'), hintsBlock, aside].filter(Boolean).join('\n\n');
    } else if (onlyArtwork) {
      // 只有画作平台的结果时，得说清楚这不是 coser 本人的号
      text += '\n\n· Pixiv 给的是画师主页（不是 coser 的社交号）；要找真人就认准推特/微博那几条';
    }
    // AI 图的参数也要跟着账号一起给：认出画师不代表用户不需要那条提示词
    const metaBlock = formatMetaBlock(meta);
    if (metaBlock) text += '\n\n' + metaBlock;
    if (aiBlock) text += '\n\n' + aiBlock;
    const cap = metaBlock || aiBlock ? 1500 : 1100;
    if (text.length > cap) text = text.slice(0, cap - 3) + '…';
    return text;
  }
  const tried = enginesUsed.length ? engineLabels(enginesUsed).join(' / ') : '';
  const why = failures.length ? `（${failures.map((f) => `${f.engine}:${trimText(f.reason, 30)}`).join('；')}）` : '';
  // 三种「没查到」要分开说，否则用户分不清是引擎没工作、还是翻到了但对不上人：
  //   · 一个引擎都没跑通 —— 是环境/网络问题（该看 why）
  //   · 跑通了、也翻到相似图 —— 是「对不上人」，比「都空」更接近事实
  //   · 跑通了但一片空白 —— 才是「私图/新图/裁过」
  const cacheTag = cached ? '（缓存）' : '';
  const hasLinks = Array.isArray(links) && links.length > 0;
  const head = !enginesUsed.length
    ? `❌ 这次没查成，一个引擎都没跑通${why ? ' ' + why : ''}`
    : String(candidates?.length ?? 0) > 0
      ? (hasLinks
        ? `🤔 没认出确定的账号。${tried}${cacheTag}翻到 ${candidates.length} 条线索，下面几条最像，可能就是原帖：`
        : `❌ 没查到账号。${tried}${cacheTag}翻到 ${candidates.length} 条线索，但没有能确认的账号${why ? ' ' + why : ''}`)
      : `❌ 没查到账号。${tried}${cacheTag}，都空——这种一般是私图、新图，或者裁过${why ? ' ' + why : ''}`;
  const lines = [`🎯 **菲比找鸡结果**`, '', head];
  if (Number(artworkDropped) > 0) {
    lines.push(`只翻到 ${Number(artworkDropped)} 张相似画作（相似度不够，没当成图源）`);
  }
  if (Number(nameDropped) > 0) {
    // 把被挡掉的 handle 也念出来：用户一眼能认出「这是另一个 coser 的号」。
    const handles = (Array.isArray(droppedHandles) ? droppedHandles : [])
      .map((handle) => String(handle ?? '').trim())
      .filter(Boolean)
      .slice(0, 3);
    const shown = handles.length ? `（${handles.join('、')}）` : '';
    lines.push(`翻到 ${Number(nameDropped)} 个别人的号${shown}，名字对不上${consensusName ? `「${trimText(consensusName, 24)}」` : '主轴'}，没当成这个人报`);
  }
  // 图源清单：认出账号时它是补充证据，认不出时它就是答案本身。
  const sourceRows = Array.isArray(links) && links.length
    ? links
    : (top ? [{ url: top.sourceUrl, title: top.title, engine: top.engine, similarity: null }] : []);
  if (sourceRows.length) {
    lines.push('', '🔎 最像的图源：');
    sourceRows.slice(0, 3).forEach((row, index) => {
      const sim = Number(row?.similarity);
      const simTag = Number.isFinite(sim) && sim > 0 ? `（相似度 ${Math.round(sim * 100)}%）` : '';
      const label = trimText(stripTags(String(row?.title ?? '')), 36);
      lines.push(`${index + 1}. ${label ? `《${label}》` : ''}${trimText(String(row?.url ?? ''), 110)}${simTag}`);
    });
  }
  const hintsBlock = formatNameHintsBlock(nameHints);
  if (hintsBlock) lines.push('', hintsBlock);
  const metaBlock = formatMetaBlock(meta);
  if (metaBlock) lines.push('', metaBlock);
  if (aiBlock) lines.push(aiBlock);
  let text = lines.join('\n');
  if (text.length > 1500) text = text.slice(0, 1497) + '…';
  return text;
}

// ── 配额 ──────────────────────────────────────────────────────────────────

function dayKey(nowMs) {
  const d = new Date(nowMs + 8 * 3600 * 1000); // 按北京时间分天
  return d.toISOString().slice(0, 10);
}

/** 能不能查。返回 {ok, reason}，reason 直接能拿来回话。 */
export function quotaOk(state, { key, userId, isOwner = false, now = Date.now() } = {}, cfg = {}) {
  if (isOwner) return { ok: true, reason: '' };
  const cdMs = Number(cfg.cdMs ?? 30000);
  const s = state && typeof state === 'object' ? state : {};
  const last = Number(s.last?.[key] ?? 0);
  if (cdMs > 0 && now - last < cdMs) {
    const wait = Math.ceil((cdMs - (now - last)) / 1000);
    return { ok: false, reason: `慢点，${wait} 秒后再发` };
  }
  const day = dayKey(now);
  const userCount = Number(s.day?.user?.[String(userId)]?.count ?? 0);
  const userDay = String(s.day?.user?.[String(userId)]?.day ?? '');
  const perUser = Number(cfg.perUserDay ?? 20);
  if (userDay === day && perUser > 0 && userCount >= perUser) {
    return { ok: false, reason: `今天的 ${perUser} 次用完了，明天再来` };
  }
  const globalCount = Number(s.day?.global?.count ?? 0);
  const globalDay = String(s.day?.global?.day ?? '');
  const perGlobal = Number(cfg.globalDay ?? 100);
  if (globalDay === day && perGlobal > 0 && globalCount >= perGlobal) {
    return { ok: false, reason: `今天全站 ${perGlobal} 次用完了，明天再来` };
  }
  return { ok: true, reason: '' };
}

/** 扣一次配额，返回新 state（纯函数，调用方负责原子写）。 */
export function chargeQuota(state, { key, userId } = {}, now = Date.now()) {
  const s = state && typeof state === 'object' ? state : {};
  const day = dayKey(now);
  const next = {
    ...s,
    last: { ...(s.last ?? {}), [key]: now },
    day: {
      ...(s.day ?? {}),
      user: { ...(s.day?.user ?? {}) },
      global: { ...(s.day?.global ?? {}) }
    }
  };
  const uid = String(userId);
  const prevUser = next.day.user[uid];
  next.day.user[uid] = {
    day,
    count: (prevUser?.day === day ? Number(prevUser?.count ?? 0) : 0) + 1
  };
  next.day.global = {
    day,
    count: (next.day.global?.day === day ? Number(next.day.global?.count ?? 0) : 0) + 1
  };
  return next;
}

// ── 缓存 ──────────────────────────────────────────────────────────────────

export function cacheKeyFor(bytes, enginesVersion = ENGINES_VERSION) {
  return `${sha256Hex(bytes)}:${enginesVersion}`;
}

export function cacheGet(cache, key, now = Date.now(), { cacheDays = 30 } = {}) {
  const entry = cache && typeof cache === 'object' ? cache[key] : null;
  if (!entry || typeof entry !== 'object') return null;
  const ageDays = (now - Number(entry.at ?? 0)) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays > Number(cacheDays ?? 30)) return null;
  return entry.result ?? null;
}

export function cachePut(cache, key, result, now = Date.now(), { cacheMax = 500 } = {}) {
  const next = { ...(cache && typeof cache === 'object' ? cache : {}) };
  next[key] = { at: now, result };
  const keys = Object.keys(next);
  const max = Math.max(1, Number(cacheMax) || 500);
  if (keys.length > max) {
    keys.sort((a, b) => Number(next[a]?.at ?? 0) - Number(next[b]?.at ?? 0));
    for (const stale of keys.slice(0, keys.length - max)) delete next[stale];
  }
  return next;
}

// ── 引擎可用性 ────────────────────────────────────────────────────────────

// 已验证「开箱即用」的引擎：不给探针结果也跑（探针只用来记录健康度）。
// 回话里给用户看的名字：光甩 id（lens / tracemoe）没人看得懂。
export const ENGINE_LABELS = {
  saucenao: 'SauceNAO',
  lens: '谷歌 Lens',
  tracemoe: '动漫截图溯源',
  iqdb: 'IQDB',
  baidu: '百度识图',
  bing: '必应',
  yandex: 'Yandex',
  google: '谷歌识图',
  ai: 'AI 检测'
};

/** 把引擎 id 列表变成人话，例如 `谷歌 Lens / SauceNAO`。 */
export function engineLabels(engines) {
  const list = Array.isArray(engines) ? engines : [];
  return list.map((id) => ENGINE_LABELS[id] ?? String(id)).filter(Boolean);
}

export const PROXY_ENGINES = new Set(['lens', 'yandex', 'google']);
export const DIRECT_ENGINES = new Set(['saucenao', 'tracemoe', 'iqdb', 'bing', 'baidu']);

/** 按「要不要外网」把引擎分两拨：直连的先跑，不够再开魔法跑另一拨。 */
export function splitEnginesByProxy(engines = []) {
  const list = Array.isArray(engines) ? engines.filter((id) => typeof id === 'string') : [];
  return {
    direct: list.filter((id) => !PROXY_ENGINES.has(id)),
    proxied: list.filter((id) => PROXY_ENGINES.has(id))
  };
}

export const ALWAYS_ON_ENGINES = new Set(['saucenao', 'iqdb', 'tracemoe', 'lens', 'yandex']);

/** 读探针结果，决定这次能用哪些引擎。探针没跑过 → 只开已验证的那几个。 */
export function pickEngines(cfg = {}, probe = null) {
  const wanted = Array.isArray(cfg.engines) && cfg.engines.length ? cfg.engines : ['saucenao', 'iqdb', 'tracemoe'];
  const probed = probe?.engines && typeof probe.engines === 'object' ? probe.engines : null;
  if (!probed) return wanted.filter((id) => ALWAYS_ON_ENGINES.has(id));
  return wanted
    .filter((id) => ENGINE_IDS.includes(id))
    .filter((id) => {
      if (ALWAYS_ON_ENGINES.has(id)) return probed[id]?.ok !== false;
      return probed[id]?.ok === true;
    });
}

/** 回话里说明「为什么只查了这些」。 */
export function describeEngines(engines, probe = null) {
  const list = Array.isArray(engines) && engines.length ? engines : [];
  if (!list.length) return '没有可用引擎';
  const text = engineLabels(list).join(' / ');
  const probed = probe?.engines ?? {};
  const dead = Object.entries(probed)
    .filter(([id, info]) => info && info.ok === false && !list.includes(id))
    .map(([id]) => id);
  return dead.length ? `${text}（${engineLabels(dead).join('、')} 目前不可用）` : text;
}

// ── 状态文件读写（原子） ──────────────────────────────────────────────────

export function readJsonFile(file, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonFileAtomic(file, value) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

/** 「已找到鸡」素材：读得到、没超限才返回 Buffer，否则 null（调用方只发文字）。 */
export function loadFoundImage(cfg = {}, { fsModule = fs } = {}) {
  const file = String(cfg.foundImage ?? '');
  if (!file) return null;
  const cap = Number(cfg.foundImageMaxBytes ?? 4 * 1024 * 1024);
  try {
    const stat = fsModule.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > cap) return null;
    const buffer = fsModule.readFileSync(file);
    return buffer?.length ? buffer : null;
  } catch {
    return null;
  }
}

// ── 猫猫云：按需开 / 关 VPN（只碰 core，不碰 GUI）─────────────────────────────
//
// 猫猫云的「连接」按钮程序点不到（窗口不可显示、无 UIA、无托盘项、无 IPC/CLI），
// 所以这里复现它自己会做的那串动作：按它日志里的写法把 core（libcore / mihomo）用
// `-d <coreDir>` 拉起来，拿到 mixed 代理端口。默认**不动系统代理**：node 侧自己用
// CONNECT 建隧道，浏览器侧单开 --proxy-server —— 用户原本的代理设置一个字都不改，
// 跑完只把自己起的那个 core 收掉。
//
// 三条底线：①不 kill 猫猫云 GUI、不起第二个实例；②只 kill 状态文件里记下的 pid，
// 绝不通配（taskkill /IM mihomo* 会误伤别人的核）；③先还原代理、再杀 core。

const VPN_STATE_FILE = path.join(MODULE_ROOT, 'state', 'fish-find-vpn.json');

export function vpnConfig(cfg = {}) {
  // 两种形状都认：{ vpn: {...} }（外面传进来的 fishFind 配置）
  // 和 {...}（模块内部把已解析好的 core 配置再传回来）。
  const raw = (cfg && cfg.vpn) || ((cfg && (cfg.mixedPort !== undefined || cfg.coreDir || Array.isArray(cfg.coreBins))) ? cfg : {});
  const vpn = raw || {};
  const coreBins = Array.isArray(vpn.coreBins) ? vpn.coreBins.filter((item) => typeof item === 'string' && item.trim()) : [];
  return {
    coreDir: String(vpn.coreDir ?? ''),
    coreBins,
    mixedPort: Number(vpn.mixedPort) || 10090,
    controllerPort: Number(vpn.controllerPort) || 0,
    sysproxy: String(vpn.sysproxy ?? ''),
    manageSystemProxy: vpn.manageSystemProxy === true,
    egressHost: String(vpn.egressHost ?? 'www.google.com'),
    startTimeoutMs: Number(vpn.startTimeoutMs) || 25000,
    egressTimeoutMs: Number(vpn.egressTimeoutMs) || 12000,
    maxHoldMs: Number(vpn.maxHoldMs) || 180000,
    autoSelectNode: vpn.autoSelectNode === true
  };
}

/** 浏览器要用的代理地址（--proxy-server 的值）。 */
export function vpnProxyUrl(cfg = {}) {
  return 'http://127.0.0.1:' + vpnConfig(cfg).mixedPort;
}

function tcpOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { if (socket) socket.destroy(); } catch {}
      resolve(value);
    };
    try { socket = net.connect({ host, port: Number(port) }); } catch { return done(false); }
    socket.setTimeout(Math.max(120, Number(timeoutMs) || 500));
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 哪个 pid 在监听这个端口？（netstat 里 LISTENING 行）
 * 用来核对「端口通了」是不是真的我们刚 spawn 的那个核 —— 猫猫云 GUI 自己也会重拉。
 */
function listeningPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const needle = ':' + Number(port);
    for (const line of String(out).split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if (!cols[1] || !cols[1].endsWith(needle)) continue;
      const pid = Number(cols[4]);
      if (pid) return pid;
    }
  } catch {}
  return 0;
}

/** mixed 端口在监听？（500ms 内建得上 TCP 就算） */
export function vpnCoreUp(cfg = {}, timeoutMs = 500) {
  return tcpOpen(vpnConfig(cfg).mixedPort, '127.0.0.1', timeoutMs);
}

/** 真能出网吗：向 mixed 端口发 CONNECT，首行 200 才算（节点坏了会是 502 / 超时）。 */
export function vpnEgressOk(cfg = {}, { host, timeoutMs } = {}) {
  const c = vpnConfig(cfg);
  const targetHost = String(host || c.egressHost);
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { if (socket) socket.destroy(); } catch {}
      resolve(value);
    };
    try { socket = net.connect({ host: '127.0.0.1', port: c.mixedPort }); } catch { return done(false); }
    let buffer = '';
    socket.setTimeout(Math.max(1000, Number(timeoutMs) || c.egressTimeoutMs));
    socket.once('connect', () => {
      try { socket.write('CONNECT ' + targetHost + ':443 HTTP/1.1\r\nHost: ' + targetHost + ':443\r\n\r\n'); }
      catch { done(false); }
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const line = buffer.split('\r\n')[0] || '';
      if (line) done(/^HTTP\/1\.[01] 200/.test(line));
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 系统代理是不是指着我们的 mixed 端口（只读注册表，绝不改）。 */
export function vpnSystemProxyOn(cfg = {}) {
  const c = vpnConfig(cfg);
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(String(out))) return false;
    try {
      const srv = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      return String(srv).indexOf('127.0.0.1:' + c.mixedPort) >= 0;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export async function vpnState(cfg = {}) {
  const core = await vpnCoreUp(cfg);
  const proxy = vpnSystemProxyOn(cfg);
  const egress = core ? await vpnEgressOk(cfg) : false;
  return { core, proxy, egress };
}

function readVpnStateFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(VPN_STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeVpnStateFile(value) {
  try { fs.mkdirSync(path.dirname(VPN_STATE_FILE), { recursive: true }); } catch {}
  const tmp = VPN_STATE_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, VPN_STATE_FILE);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

function clearVpnStateFile() {
  try { fs.rmSync(VPN_STATE_FILE, { force: true }); } catch {}
}

function killPidTree(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    execFileSync('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function pickCoreBin(c) {
  for (const bin of c.coreBins) {
    try { if (bin && fs.existsSync(bin)) return bin; } catch {}
  }
  return '';
}

function holdFresh(file, c) {
  if (!file || file.state !== 'hold') return false;
  const started = Number(file.startedAt) || 0;
  if (!started) return false;
  return Date.now() - started < c.maxHoldMs;
}

// 互斥：别的任务正 hold 着就排队等它结束（最多 maxHoldMs），绝不重复开关。
async function waitForOtherHold(c, tag, onLog) {
  const deadline = Date.now() + c.maxHoldMs;
  while (Date.now() < deadline) {
    const file = readVpnStateFile();
    if (!file || String(file.holder ?? '') === String(tag)) return null;
    if (!holdFresh(file, c)) return null; // 过期的 hold 交给 vpnRepair / 下面的流程处理
    if (onLog) onLog('[菲比找鸡] 别的任务正在用魔法，排队等它收工');
    await sleep(700);
  }
  return null;
}

// 挑延迟最低的可用节点（默认关）。失败一律忽略 —— 这是锦上添花，不是主流程。
async function autoSelectNode(c, onLog) {
  if (!c.controllerPort) return;
  const base = 'http://127.0.0.1:' + c.controllerPort;
  try {
    const response = await fetch(base + '/proxies', { signal: AbortSignal.timeout(6000) });
    const body = await response.json();
    const groups = body && typeof body.proxies === 'object' ? body.proxies : {};
    let best = null;
    for (const [name, info] of Object.entries(groups)) {
      if (!info || String(info.type ?? '') !== 'Selector') continue;
      const all = Array.isArray(info.all) ? info.all : [];
      if (!all.length) continue;
      for (const member of all) {
        const node = groups[member];
        const history = Array.isArray(node?.history) ? node.history : [];
        const delay = Number(history.length ? history[history.length - 1]?.delay : 0);
        if (!Number.isFinite(delay) || delay <= 0) continue;
        if (!best || delay < best.delay) best = { group: name, member, delay };
      }
      if (best) break;
    }
    if (!best) return;
    await fetch(base + '/proxies/' + encodeURIComponent(best.group), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: best.member }),
      signal: AbortSignal.timeout(6000)
    });
    if (onLog) onLog('[菲比找鸡] 已切到延迟最低的节点：' + best.member + '（' + best.delay + 'ms）');
  } catch (error) {
    if (onLog) onLog('[菲比找鸡] 切节点失败（不影响使用）：' + (error?.message ?? error));
  }
}

/**
 * 保证有一条能出网的通道。
 * 返回 { acquired, changed, pid, before, reason? }：
 *   · 已经通 → acquired:true, changed:false（不写状态文件、不拉 core）
 *   · 自己拉的 → changed:true, pid=core 的 pid（release 时要还）
 */
export async function vpnEnsure(cfg = {}, tag = '', { onLog } = {}) {
  const c = vpnConfig(cfg);
  const before = { core: await vpnCoreUp(c), proxy: vpnSystemProxyOn(cfg) };
  if (before.core && (await vpnEgressOk(cfg))) {
    if (onLog) onLog('[菲比找鸡] 魔法本来就在线，直接用（这条不会被我们关掉）');
    return { acquired: true, changed: false, pid: 0, before };
  }
  await waitForOtherHold(c, tag, onLog);
  // 排到之后可能已经有人把核拉起来了
  const again = await vpnCoreUp(c);
  const handle = {
    holder: String(tag || process.pid),
    pid: 0,
    spawnedCore: false,
    proxyTouched: false,
    before,
    startedAt: Date.now(),
    state: 'hold'
  };
  if (!again) {
    const bin = pickCoreBin(c);
    if (!bin) {
      if (onLog) onLog('[菲比找鸡] 找不到 core（coreBins 都不在），这次只能直连');
      return { ...handle, acquired: false, changed: false, pid: 0, reason: 'no-core' };
    }
    let spawnError = null;
    let proc = null;
    try {
      proc = spawn(bin, ['-d', c.coreDir], {
        cwd: c.coreDir || undefined,
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      // spawn 的失败是**异步** error 事件 —— 不接住会把桥接整个带崩
      proc.on('error', (error) => { spawnError = error; });
      proc.unref();
      handle.pid = Number(proc.pid) || 0;
    } catch (error) {
      spawnError = error;
    }
    await sleep(1200);
    if (spawnError) {
      const code = String(spawnError?.code ?? '');
      if (onLog) onLog('[菲比找鸡] core 起不来（' + (code || spawnError?.message || '未知') + '）');
      if (handle.pid) killPidTree(handle.pid);
      return { ...handle, acquired: false, changed: false, pid: 0, reason: 'spawn' };
    }
    const deadline = Date.now() + c.startTimeoutMs;
    let up = false;
    while (Date.now() < deadline) {
      if (await vpnCoreUp(c, 400)) { up = true; break; }
      await sleep(300);
    }
    if (!up) {
      if (onLog) onLog('[菲比找鸡] core 没能在 ' + Math.round(c.startTimeoutMs / 1000) + ' 秒内监听 ' + c.mixedPort + '，回收');
      if (handle.pid) killPidTree(handle.pid);
      return { ...handle, acquired: false, changed: false, pid: 0, reason: 'no-listen' };
    }
    // 端口通了不一定是我们这个核：猫猫云 GUI 自己发现核没了会重拉一个。
    // 只有「监听端口的 pid 就是刚 spawn 的 pid」才算我们起的，否则一律按复用处理（不收走）。
    const listening = listeningPid(c.mixedPort);
    if (listening && handle.pid && listening !== handle.pid) {
      if (onLog) onLog('[菲比找鸡] 端口 ' + c.mixedPort + ' 被猫猫云自己的 core 占了（pid ' + listening + '），复用、不关');
      if (handle.pid) killPidTree(handle.pid);
      handle.pid = 0;
      handle.spawnedCore = false;
    } else {
      handle.spawnedCore = true;
    }
  }
  try {
    writeVpnStateFile(handle);
  } catch (error) {
    if (onLog) onLog('[菲比找鸡] 写魔法状态文件失败（不影响本次）：' + (error?.message ?? error));
  }
  if (c.manageSystemProxy && !vpnSystemProxyOn(cfg) && c.sysproxy) {
    try {
      execFileSync(c.sysproxy, ['global', '127.0.0.1:' + c.mixedPort, ''], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
      handle.proxyTouched = true;
      try { writeVpnStateFile(handle); } catch {}
    } catch (error) {
      if (onLog) onLog('[菲比找鸡] 设系统代理失败：' + (error?.message ?? error));
    }
  }
  if (!(await vpnEgressOk(cfg))) {
    if (onLog) onLog('[菲比找鸡] core 在跑但出口不通（节点挂了？）');
    await vpnRelease(cfg, handle, { onLog });
    return { ...handle, acquired: false, changed: false, pid: 0, reason: 'no-egress' };
  }
  if (c.autoSelectNode) await autoSelectNode(c, onLog);
  return { ...handle, acquired: true, changed: true };
}

/** 收工：只还原我们改过的部分；顺序固定「先代理、后 core」。 */
export async function vpnRelease(cfg = {}, handle, { onLog } = {}) {
  if (!handle) return;
  const c = vpnConfig(cfg);
  // 状态文件只收自己写的那条：holder 或 pid 对得上才算我们的。
  const file = readVpnStateFile();
  const mine = !!file && (
    String(file.holder ?? '') === String(handle.holder ?? '')
    || ((Number(file.pid) || 0) !== 0 && (Number(file.pid) || 0) === (Number(handle.pid) || 0))
  );
  if (handle.proxyTouched && !handle.before?.proxy && c.sysproxy) {
    try {
      // flags=1 是 PROXY_TYPE_DIRECT：直连模式，等于把系统代理关掉
      execFileSync(c.sysproxy, ['set', '1', '-', '-', '-'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    } catch (error) {
      if (onLog) onLog('[菲比找鸡] 还原系统代理失败，请手动关一下：' + (error?.message ?? error));
    }
  }
  const pid = Number(handle.pid) || 0;
  if (handle.spawnedCore && pid) {
    killPidTree(pid);
    if (onLog) onLog('[菲比找鸡] 已收起自己起的 core（pid ' + pid + '）');
  }
  // 复用的别人的核（changed/spawnedCore/proxyTouched 全为假）时，进程与代理一根手指都不碰，
  // 但自己写下的状态文件必须收掉，否则会被当成「有人在用」卡住后续任务。
  if (mine || handle.changed) clearVpnStateFile();
}

/**
 * 崩溃兜底：桥接启动时调一次。只处理「状态文件说我们自己起过、但已经过期/脏了」的残留，
 * 用户自己开的核一律不碰。
 */
export async function vpnRepair(cfg = {}, { onLog } = {}) {
  const file = readVpnStateFile();
  if (!file) return;
  const c = vpnConfig(cfg);
  const stale = file.state === 'dirty' || !holdFresh(file, c);
  if (!stale) {
    if (onLog) onLog('[菲比找鸡] 上次魔法还留着（' + String(file.holder ?? '?') + '），先不管');
    return;
  }
  const pid = Number(file.pid) || 0;
  if (file.spawnedCore && pid) {
    killPidTree(pid);
    if (onLog) onLog('[菲比找鸡] 清掉上次残留的 core（pid ' + pid + '）');
  }
  if (file.proxyTouched && !file.before?.proxy && c.sysproxy) {
    try {
      execFileSync(c.sysproxy, ['set', '1', '-', '-', '-'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
      if (onLog) onLog('[菲比找鸡] 顺手把上次留下的系统代理关回去');
    } catch {}
  }
  clearVpnStateFile();
}
