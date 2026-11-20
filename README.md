# 鱼鱼找鸡 v1.3.1

给一张图，反查这人是哪个 coser、账号在哪。

- 多引擎：**谷歌 Lens**、**Yandex**（真人 cosplay 最有用）、SauceNAO（动漫/同人）、trace.moe（动漫截屏）、IQDB、百度识图。
- 零 token：不调用任何大模型，**不花 API 钱**（只有 Lens/Yandex 走 SerpAPI，免费额度每月 250 次）。
- 不依赖 npm 包（只用 Node 内置模块 + 本机已装的 Edge/Chrome）。
- 认不出账号时，还会告诉你**这张图在哪些站被标成了谁**。

---

## 1. 装环境

| 需要 | 说明 |
|---|---|
| Node.js ≥ 20 | 内置 `fetch`、`WebSocket`，不用装依赖 |
| Edge 或 Chrome | 谷歌 Lens 那条路要开一个无头浏览器（Windows 自带 Edge 就够） |
| 外网（可选） | 只用 SauceNAO / trace.moe 的话，国内直连也能用 |

```bash
node bin/fish.mjs --check
```

## 2. 配配置

```bash
cp config.example.json config.json
```

| 配置 | 什么时候改 |
|---|---|
| `engines` | 想加/减引擎。推荐 `lens,saucenao,tracemoe,yandex` |
| `serpApiKey` | 用 Lens / Yandex 必须填（[serpapi.com](https://serpapi.com)，免费 250 次/月） |
| `sauceNaoApiKey` | 二次元图建议填，不填容易被匿名额度限流 |
| `proxy` | 机器上没全局代理、但你有本地代理端口（clash 7890、猫猫云 10090…）时填，只让浏览器走它 |
| `strictConsensus` | 想「宁可多报」就设 false |
| `foundImage` | 想命中时顺带发张图（比如一张「找到了」的表情） |

### 引擎都擅长什么

| 引擎 | 强项 | 弱项 |
|---|---|---|
| `lens` | 二次元、老图、带社交卡片的主页 | **几小时内的新图必然搜不到**（索引没爬到） |
| `yandex` | 真人 cosplay，返回「哪些网页收录了这张图」 | 会把同角色的**别人的图**混进来 |
| `saucenao` | 动漫插画、同人图，能给出 danbooru/pixiv 原页 | 真人照基本无解 |
| `tracemoe` | 动漫截图（按时间轴定位） | 只认番剧画面 |
| `iqdb` | 老番/画集 | 长期排队，默认关掉 |

## 3. 用

```bash
# 查本机图片
node bin/fish.mjs D:/图片/a.jpg

# 查网址
node bin/fish.mjs https://example.com/a.jpg

# 只看结构化结果（方便自己接脚本）
node bin/fish.mjs D:/图片/a.jpg --json

# 只走直连引擎（不开浏览器、不碰外网）
node bin/fish.mjs D:/图片/a.jpg --engines saucenao,tracemoe

# 名字对不上也报（自己挑）
node bin/fish.mjs D:/图片/a.jpg --no-strict
```

认出账号时输出长这样：

```
🎯 鱼鱼找鸡结果

🌐 平台：Twitter
👤 名字：阿薰kaOri
🆔 账号：@izayoill · https://x.com/izayoill
```

**真人 cosplay 图**（没有社交账号可认）会走另一条路：

```
🎯 鱼鱼找鸡结果

🔎 收录站的标题里反复出现的名字（越靠前越像作者）：
1. lunananya（www.v2ph.ru、www.v2ph.com）
   → https://www.v2ph.ru/album/z48775nz.html
2. Etsu_ko（www.v2ph.ru、imgcup.com）
   → https://www.v2ph.ru/album/z64893nz.html
· 大概率就是这个人，点点看：https://x.com/lunananya

· 另外还匹配到 2 个画这个角色的画师（KyujuuKyu、wako），不是照片里的人
```

名字是怎么排的：收录站（v2ph / telegra.ph / hentai-cosplay 等）的标题几乎都是「**作者 - 角色 - 站名**」，把这些标题里的拉丁词按 `Σ(1/搜索结果位次)` 打分、跨 ≥2 个站再乘 2，取前 3。名字下面挂的是它出现过的那一页，点开能核对。这一段**只在没认出真人账号时**才输出，二次元图不会被搅浑。

## 4. 自建图床（重要）

Lens 和 Yandex 都只吃**公网能访问的图片 URL**，所以查图前必须先把图传出去。而公共图床……2026-11 实测：

| 图床 | 状态 |
|---|---|
| pomf2 | 断连 `UND_ERR_SOCKET`，连传十几张回 429 |
| uguu | 502 |
| 0x0.st | 明说因 AI 爬虫关闭上传 |
| catbox | 连接超时 |
| tmpfiles | 不返地址 |

图床一挂，这两条最强的通道就整条废掉。所以本插件支持**自建**：把图写进你自己 web 服务器的站点根目录，随机文件名 + 10 分钟自删。

```bash
# Linux，nginx 站点根目录是 /var/www/html
export FISH_SELF_HOST_DIR=/var/www/html
export FISH_SELF_HOST_BASE=https://img.example.com
```

| 环境变量 | 说明 |
|---|---|
| `FISH_SELF_HOST_DIR` | 站点根目录，默认 `/var/www/html` |
| `FISH_SELF_HOST_BASE` | 该目录对应的公网地址，**留空 = 不启用自建图床** |

配了就走自建图床（失败自动回落公共图床），没配就只走公共图床。

> 走这条路意味着：图会在你的服务器上**短暂公开可下载**（10 分钟，随机名，猜不到）。介意的话别配。

## 5. 挂进 QQ 机器人（OneBot 11）

```js
import { handleFishCommand } from './adapters/onebot.mjs';

const onebot = (action, params) =>
  fetch(`http://127.0.0.1:3000/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer 你的token' },
    body: JSON.stringify(params)
  }).then((r) => r.json());

onMessage(async (event) => {
  const key = event.group_id ? `group:${event.group_id}` : `private:${event.user_id}`;
  const done = await handleFishCommand({ text: event.raw_message, key, event, onebot });
  if (done.handled) return;
});
```

用法：**引用一张图**，发 `/鱼鱼找鸡`。它先回「收到，开始找鸡」，再回结果；有 `foundImage` 时图 + 文一条发出去。

## 6. 它是怎么认的（也是「为什么有时候查不到」的原因）

1. 各引擎返回「相似图的所在页面」；
2. 从页面里抽社交账号（推特/微博/B站/Instagram/小红书…），作者页比帖子页可信；
3. 同一角色常有好几个 coser，只留「标题里出现同一个人名」的那一撮（`strictConsensus`）；
4. 画作平台（pixiv/danbooru）容易把画师当 coser；一张真人照如果只翻得到画师，那说明**照片本身还没被索引**，此时走第 3 节的「名字提示」；
5. danbooru 的 `source` 字段记着图的「最初发布地址」，比标题可靠——v1.2.0 起会顺着它找到推特原帖或小红书笔记。

## 7. 常见问题

**Lens 一直没结果 / 报 `GOOGLE_UNREACHABLE`**
谷歌连不上。要么开系统代理，要么在 `config.json` 填 `proxy`（只让浏览器走，不动系统代理）。

**报 `GOOGLE_CAPTCHA`**
谷歌要人机验证。用 `--proxy` 换个出口，或者先用 `--engines saucenao,tracemoe` 顶着。

**刚发的图怎么都搜不到**
反向图搜比对的是**图像指纹**，不是画面特征。刚发出去几小时的图，索引还没爬到，越准的引擎越搜不出。等一天再试。

**Yandex 报 `The URL does not refer to an image`**
它偶尔拉不到自建图床的图（文件还在、nginx 也 200）。插件会自动等 1.5 秒重试一次。

**查到一堆别人的号**
保持 `strictConsensus: true`（默认）。它是「只报标题里出现同一个名字的人」。

**第一次跑很慢**
无头浏览器冷启动要 2~4 秒；它会复用同一个 profile 目录（`state/`），第二次就快。

**SauceNAO 报 429**
免费额度被刷完了，等一会儿，或者少查几张。

**图片会不会被上传到网上**
会——反查必须把图发给引擎（SauceNAO/Lens/Yandex…）。上传目标写死在 `src/fish-find-chicken.js` 的 `UPLOAD_HOSTS` 白名单里，不读配置，防止被配置改去奇怪的域名。不想上传就别用。

## 8. 基准测试

`bench/` 里有一套 12 张图的测试集（图不在仓库里，只有标准答案 `meta.json`），改动前后跑一遍就知道有没有变好。

```bash
python3 bench/bench.py lens,saucenao,tracemoe,yandex cosplay1.jpg ... anime6.png
```

当前成绩：**11/12**（唯一没中的是官方 CDN 上的图，索引里本来就没有）。详见 `bench/README.md`。

## 9. 隐私与许可

- 不收集、不上报任何使用数据；所有请求只发给你配置在引擎白名单里的域名。
- 浏览器 profile 存在插件目录 `state/` 下，只用来复用谷歌的验证 cookie，可以随时删。
- 代码 MIT。

---

版本 1.3.1 · 文件名 `coser-image-search`
