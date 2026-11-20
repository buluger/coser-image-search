# bench —— 菲比找鸡 基准测试集

拿一批「知道真出处」的图，验证改动是否真的变好了。

## 内容

| 文件 | 干什么 |
|---|---|
| `bench.py` | 批量跑核心，逐张输出 `HIT-1 / hit / MISS`、耗时、用的引擎、失败原因 |
| `meta.json` | **标准答案**：文件名 → `kind`（cosplay/anime）、`danbooru` 页、`source`（真原帖或 pixiv 原图）、`artist_tag` |
| `ai_make.mjs` | 合成一张带 A1111 参数的 PNG，用来测 AI 元数据解析（不需要网络） |

图片本体不在仓库里（体积 + 版权），服务器上那批在 `/tmp/fishtest/`，重启就没了。

## 跑法（服务器）

```bash
mkdir -p /tmp/fishtest && cd /tmp/fishtest
# 把 bench.py / meta.json / ai_make.mjs 和 12 张图放进来（图名要与 meta.json 一致）
python3 bench.py lens,saucenao,tracemoe cosplay1.jpg cosplay2.jpg cosplay3.jpg \
  cosplay4.jpg cosplay5.jpg cosplay6.jpg anime1.jpg anime2.png anime3.jpg anime4.png anime5.jpg anime6.png
```

- 默认读 `/opt/fish-find-chicken/config.json` 里的密钥，自动写一份 `useCache:false` 的临时配置——**不关缓存会读到上一轮的旧结果**。
- 环境变量：`FISH_BENCH_DIR`（图集目录）、`FISH_CORE`、`FISH_NODE`、`FISH_CONFIG`。
- **每张图消耗 1 次 SerpAPI 额度**（lens 引擎），跑完一轮 12 次。
- 结果 JSON 落在 `<图集目录>/res/<文件名>.<引擎串>.json`，含 `meta` / `links` / `candidates` / `failures`，排障用。

## 换图（扩充数据集）

挑一张 danbooru 上的图（`danbooru.donmai.us/posts/<id>`）：

1. 看这张图的 `source` 字段——那才是真出处（原推特帖 / pixiv 原图 / 官方站）；
2. 把图和答案写进 `meta.json`：

```json
"新图.jpg": {"kind": "cosplay", "danbooru": "https://danbooru.donmai.us/posts/123",
             "source": "https://x.com/某人/status/456", "artist_tag": "某人"}
```

3. 真出处是社媒帖时判「账号对不对」，是插画时判「画师名对不对」（`bench.py::judge`）。

> 注意：danbooru 的 API 要带**程序 UA**，浏览器 UA 会被 Cloudflare 拦（详见 HANDOFF §11）。
