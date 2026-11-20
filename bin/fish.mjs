#!/usr/bin/env node
// 鱼鱼找鸡 —— 命令行入口：给一张图（本机文件或网址），反查 coser 的社媒账号。
//
// 「为什么」是命令行而不只是模块：这个功能对普通人最有用的一步就是
// 「我有张图，告诉我这人是谁」——不该要求他会写 JS 或先架个机器人。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reverseSearch,
  extractAccounts,
  formatReply,
  topSources,
  enrichArtworkPages,
  nameHintsFromCandidates,
  engineLabels,
  ENGINE_IDS,
  ENGINES_VERSION,
  cacheGet,
  cachePut,
  readJsonFile,
  writeJsonFileAtomic,
  sha256Hex,
  sauceNaoBlocked,
  clearSauceNaoBlock,
  closeBrowser,
  killStaleBrowsers,
  pruneProfileCache
} from '../src/fish-find-chicken.js';
import { readImageMeta } from '../src/image-meta.js';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
// 同一张图 + 同一组引擎的结论直接复用：SauceNAO 匿名一天只有 20 次，
// 群里同一张图被反复引用时不该每次都烧一次额度。
const CACHE_FILE = path.join(PLUGIN_ROOT, 'state', 'fish-find-cache.json');

const DEFAULTS = {
  enabled: true,
  // 真人 + 二次元都能出结果的四条腿：
  //   lens     谷歌 Lens（真人 coser 的主战场，能直接抓到推特原帖）
  //   saucenao 插画/同人（给画师名和 pixiv id）
  //   tracemoe 动画截屏溯源（给番名 + 集数）
  // iqdb 现在长期「排队」，一次要白等 40 秒，默认关掉（要开就 --engines 里加）；
  // yandex 噪声大、baidu/bing 要浏览器，都留着手动开。
  engines: ['lens', 'saucenao', 'tracemoe'],
  timeoutMs: 45000,
  maxAccounts: 3,
  strictConsensus: true,
  // 谷歌系引擎要看得到外网。填本机代理（猫猫云/clash 这类）就能单独让它走代理，
  // 不动系统代理 —— 空串 = 直连。
  proxy: '',
  browserExe: '',
  // 填了就走 SerpAPI 版的谷歌 Lens（绕开浏览器验证码）
  serpApiKey: '',
  // SauceNAO 的 api_key：不填 = 匿名（这个 IP 每天 20 次），填了 = 100 次/天。
  // 拿 key 之后还要在 SauceNAO 账号设置里把 API access 打开，否则只给 HTML。
  sauceNaoApiKey: '',
  // Sightengine 的 AI 图像检测：填了才启用 --engines ai。
  sightengineApiUser: '',
  sightengineApiSecret: '',
  // 排序口味：auto = 认得出是插画就把 pixiv 画师放第一；pixiv = 永远优先画师；social = 永远优先社交号
  preferArtwork: 'auto',
  // SauceNAO 相似度门槛：低于这个的命中不是这张图的出处（它没命中时会给一串 45~55% 的别的图）
  minSimilarity: 0.65,
  useCache: true,
  cacheDays: 30
};

const USAGE = `鱼鱼找鸡 v1.1.0

用法：
  node bin/fish.mjs <图片文件|网址>            查出处（输出给人看的话术）
  node bin/fish.mjs <图片文件> --json          输出结构化 JSON（含 meta/links/candidates）
  node bin/fish.mjs <图片文件> --engines lens,saucenao
  node bin/fish.mjs <图片文件> --no-strict     名字对不上也把候选账号报出来
  node bin/fish.mjs --check                    自检：哪些引擎可用、代理通不通

选项：
  --engines a,b      指定引擎（默认 lens,saucenao,tracemoe）
  --max <n>          最多报几个账号（默认 3）
  --timeout <秒>     单个引擎超时（默认 45）
  --proxy <url>      浏览器走这个代理，比如 http://127.0.0.1:10090
  --browser <路径>   指定 Edge/Chrome 可执行文件（默认自动找 Edge）
  --json             结构化输出
  --config <文件>    指定配置文件（默认 ./config.json）
  -h, --help         看这段帮助

引擎说明：
  lens       谷歌 Lens（真人的主力，第 1 条通常是原帖；走 SerpAPI，先把图传图床拿公网 URL）
  saucenao   插画/同人反查（直连，给画师名 + pixiv 号；免费 100 次/天、30 秒 4 次）
  tracemoe   动画截屏溯源（直连，给番名 + 集数）
  iqdb       动漫图库（直连，2026-11 起常年排队，默认不开）
  yandex     Yandex 以图搜图（走 SerpAPI，只给「长得像」，噪声大）
  baidu      百度识图（可选，需要 Chromium，很慢）
  bing/google 浏览器路径的以图搜图（需要 Chromium）
  ai         Sightengine AI 生成检测（需 sightengineApiUser/Secret）

例子：
  node bin/fish.mjs D:/图片/a.jpg
  node bin/fish.mjs https://example.com/a.jpg --json
  node bin/fish.mjs a.png --engines lens,saucenao,tracemoe --json
`;

function parseArgs(argv) {
  const out = { image: '', engines: null, max: 0, timeout: 0, proxy: null, browser: '', json: false, strict: true, config: '', check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    else if (a === '--json') out.json = true;
    else if (a === '--no-strict') out.strict = false;
    else if (a === '--check') out.check = true;
    else if (a === '--engines') out.engines = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--max') out.max = Number(argv[++i]) || 0;
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || 0;
    else if (a === '--proxy') out.proxy = String(argv[++i] ?? '');
    else if (a === '--browser') out.browser = String(argv[++i] ?? '');
    else if (a === '--config') out.config = String(argv[++i] ?? '');
    else if (a.startsWith('-')) throw new Error(`不认识的参数：${a}`);
    else if (!out.image) out.image = a;
    else throw new Error(`多给了一个参数：${a}`);
  }
  return out;
}

function loadConfig(argv) {
  const file = argv.config ? path.resolve(argv.config) : path.join(PLUGIN_ROOT, 'config.json');
  let saved = {};
  if (fs.existsSync(file)) {
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`config.json 读不了（${file}）：${error.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...saved };
  if (argv.engines) cfg.engines = argv.engines;
  if (argv.max) cfg.maxAccounts = argv.max;
  if (argv.timeout) cfg.timeoutMs = argv.timeout * 1000;
  if (argv.proxy !== null) cfg.proxy = argv.proxy;
  if (argv.browser) cfg.browserExe = argv.browser;
  return cfg;
}

/** 按文件头认格式，不信扩展名 —— 有人把 png 存成 .jpg，反查接口会直接拒。 */
function sniffMime(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.length > 12 && bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return 'image/jpeg';
}

async function readImage(target) {
  if (/^https?:\/\//i.test(target)) {
    const got = await safeFetchBuffer(target, 20 * 1024 * 1024);
    if (!got.buffer?.length) throw new Error(`这个地址没取到图：${target}`);
    return { bytes: got.buffer, mimeType: sniffMime(got.buffer), source: target };
  }
  const file = path.resolve(target);
  if (!fs.existsSync(file)) throw new Error(`找不到这个文件：${file}`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`这不是文件：${file}`);
  if (stat.size > 20 * 1024 * 1024) throw new Error(`图太大了（${(stat.size / 1024 / 1024).toFixed(1)}MB，上限 20MB）`);
  const bytes = fs.readFileSync(file);
  return { bytes, mimeType: sniffMime(bytes), source: file };
}

async function doCheck(cfg) {
  const list = (cfg.engines ?? []).filter((id) => ENGINE_IDS.includes(id));
  console.log(`引擎：${engineLabels(list).join(' / ') || '（空）'}`);
  const unknown = (cfg.engines ?? []).filter((id) => !ENGINE_IDS.includes(id));
  if (unknown.length) console.log(`WARN 不认识的引擎：${unknown.join(', ')}`);
  console.log(`代理：${cfg.proxy ? cfg.proxy : '直连'}`);
  console.log(`超时：${Math.round(cfg.timeoutMs / 1000)} 秒/引擎`);
  console.log('\n提示：lens/google 需要外网；saucenao/iqdb/tracemoe 直连即可。');
  console.log('连不上外网时用 --proxy http://127.0.0.1:10090 只让浏览器走代理。');
  return true;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help) {
    console.log(USAGE);
    return 0;
  }
  const cfg = loadConfig(argv);
  if (argv.check) return (await doCheck(cfg)) ? 0 : 1;
  if (!argv.image) {
    console.log(USAGE);
    return 2;
  }

  const image = await readImage(argv.image);
  // 元数据先读：AI 图的「出处」多半就写在文件里，比任何反查都准，而且不花时间
  const meta = readImageMeta(image.bytes);
  const started = Date.now();
  const verb = argv.json ? null : (text) => console.log(`  ${text}`);
  if (verb) console.log(`查图：${image.source}（${(image.bytes.length / 1024).toFixed(0)}KB ${image.mimeType}）`);

  const engines = (Array.isArray(cfg.engines) ? cfg.engines : []).filter(Boolean);
  const cacheKey = `${sha256Hex(image.bytes)}:${ENGINES_VERSION}:${[...engines].sort().join(',')}`;
  let result = null;
  let cached = false;
  if (cfg.useCache !== false) {
    const hit = cacheGet(readJsonFile(CACHE_FILE, {}), cacheKey, Date.now(), { cacheDays: cfg.cacheDays });
    if (hit) {
      result = hit;
      cached = true;
      if (verb) console.log('  命中缓存，不重新查');
    }
  }
  if (!result) {
    // SauceNAO 被锁（今日 20 次用完 / 短时限流）时先把它摘掉：不然每条都白等 5 秒再报同一个错
    let blocked = sauceNaoBlocked();
    // 「匿名额度用完」那把锁对已经配了 key 的请求不作数 —— 否则配完 key 还得等到零点
    if (blocked && blocked.keyless && cfg.sauceNaoApiKey) {
      clearSauceNaoBlock();
      blocked = null;
    }
    const useEngines = blocked ? engines.filter((id) => id !== 'saucenao') : engines;
    if (blocked && verb) console.log(`  跳过 SauceNAO：${blocked.reason}`);
    // 上一轮被强杀留下的浏览器孤儿会攥着 profile 目录，先扫掉再开工
    const stale = killStaleBrowsers();
    if (stale && verb) console.log(`  清掉 ${stale} 个上次遗留的浏览器进程`);
    result = await reverseSearch(image.bytes, image.mimeType, {
      engines: useEngines,
      timeoutMs: cfg.timeoutMs,
      proxy: cfg.proxy || '',
      browserExe: cfg.browserExe || '',
      serpApiKey: cfg.serpApiKey || '',
      sauceNaoApiKey: cfg.sauceNaoApiKey || '',
      sightengineApiUser: cfg.sightengineApiUser || '',
      sightengineApiSecret: cfg.sightengineApiSecret || '',
      onLog: verb ? (line) => console.log(`  ${line}`) : null
    });
    if (blocked && engines.includes('saucenao')) {
      result.failures = [...(result.failures ?? []), { engine: 'saucenao', reason: blocked.reason }];
    }
    // 限流导致的残结果不进缓存：否则接下来一整天都在回「只查到推特」
    const degraded = (result.failures ?? []).some((f) => /额度|限流/.test(String(f?.reason ?? '')));
    if (cfg.useCache !== false && !degraded) {
      try {
        writeJsonFileAtomic(CACHE_FILE, cachePut(readJsonFile(CACHE_FILE, {}), cacheKey, result, Date.now(), {
          cacheMax: Number(cfg.cacheMax ?? 500) || 500
        }));
      } catch {
        // 缓存写不进去不影响这次查询
      }
    }
  }

  // Lens 只给 pixiv 作品页时，靠作品页反查作者 —— 二次元图「明明翻到了却报没查到」，多半卡在这
  if (result.candidates?.length) {
    try {
      await enrichArtworkPages(result.candidates, { onLog: verb ? (line) => console.log(`  ${line}`) : null });
    } catch {
      // 补作者失败不影响主结果
    }
  }

  const dropped = [];
  let weakArtwork = 0;
  const minSimilarity = Number(cfg.minSimilarity ?? 0.65) || 0.65;
  const accounts = extractAccounts(result.candidates, {
    max: cfg.maxAccounts,
    strictNames: argv.strict,
    preferArtwork: cfg.preferArtwork,
    minSimilarity,
    onDrop: (info) => {
      if (info?.weakArtwork) weakArtwork += 1;
      else dropped.push(info);
    }
  });
  // 数字 id 补成画师昵称：光给「572026」用户没法搜这个人
  await resolvePixivNames(accounts);
  // 一个账号都没认出来时，这几条链接就是答案（老版本这时只回一句「没查到」）
  const links = topSources(result.candidates, { max: 3, minSimilarity });
  // 真人图没有账号可认时，收录站标题里反复出现的名字就是答案
  const nameHints = nameHintsFromCandidates(result.candidates, { max: 3 });
  const text = formatReply({
    accounts,
    candidates: result.candidates,
    enginesUsed: result.enginesUsed,
    failures: result.failures,
    cached,
    artworkDropped: weakArtwork,
    ai: result.ai,
    links,
    meta,
    nameHints
  });
  if (argv.json) {
    console.log(JSON.stringify({
      source: image.source,
      elapsedMs: Date.now() - started,
      cached,
      enginesUsed: result.enginesUsed,
      failures: result.failures,
      accounts,
      ai: result.ai,
      meta,
      links,
      nameHints,
      // 调试用：前 25 条候选，能看出「真图源被谁挤掉了」
      candidates: (result.candidates ?? []).slice(0, 25).map((candidate) => ({
        engine: candidate.engine ?? '',
        position: candidate.position ?? null,
        similarity: candidate.similarity ?? null,
        url: candidate.sourceUrl || candidate.url || '',
        title: String(candidate.title ?? '').slice(0, 90),
        authorName: candidate.authorName ?? ''
      })),
      text
    }, null, 2));
    return 0;
  }

  console.log('');
  console.log(text);
  console.log('');
  console.log(`用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒 · 引擎 ${result.enginesUsed.join(', ') || '无'}`);
  if (result.failures?.length) {
    console.log(`没出结果的：${result.failures.map((f) => `${f.engine}(${f.reason})`).join('、')}`);
  }
  return 0;
}

/**
 * pixiv 的会员号是个数字，光有 id 用户没法去搜这个人。
 * SauceNAO 没给 author_name 时（老图常见），用 pixiv 的 ajax/user 补一个画师昵称。
 * 纯锦上添花：拿不到就算了，别拖慢整体。
 */
async function resolvePixivNames(accounts, { timeoutMs = 8000 } = {}) {
  const targets = accounts.filter(
    (acc) => acc.platform === 'pixiv' && !acc.authorName && /^\d+$/.test(String(acc.handle ?? ''))
  );
  if (!targets.length) return;
  await Promise.all(targets.map(async (acc) => {
    try {
      const res = await fetch(`https://www.pixiv.net/ajax/user/${acc.handle}?full=1`, {
        headers: {
          Referer: 'https://www.pixiv.net/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.error) return;
      const name = String(data?.body?.name ?? '').trim();
      if (name) acc.authorName = name;
    } catch {
      // 补名字失败不影响结果
    }
  }));
}

/**
 * 收尾：杀掉本进程拉起的浏览器。
 * 不杀的话 node 退出后 chromium 变成孤儿，一直占着 profile 和内存 ——
 * 服务器上真实攒出过 19 个进程、活了三天。
 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { closeBrowser(); } catch {}
    process.exit(130);
  });
}

(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (error) {
    console.error(`出错了：${error?.message ?? error}`);
    code = 1;
  } finally {
    try { await closeBrowser(); } catch {}
    // 组件缓存（CRX/Widevine/TTS）每次启动都会悄悄涨几十 M，收工时顺手清掉
    try { pruneProfileCache(); } catch {}
  }
  process.exit(code);
})();
