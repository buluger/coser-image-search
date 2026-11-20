#!/usr/bin/env python3
"""菲比找鸡 基准测试：拿一批「知道真出处」的图，跑核心，比对账号/图源。

用法（在服务器上）：
    cd /opt/fish-find-chicken/bench
    python3 bench.py lens,saucenao,tracemoe cosplay1.jpg anime2.png

图集目录默认 /tmp/fishtest（易失），可用环境变量 FISH_BENCH_DIR 指到别处；
meta.json 是这个目录里的「标准答案」（文件名 → 真出处 URL + danbooru 页 + 画师标签）。
结果写到 <图集目录>/res/<文件名>.<引擎串>.json，并打印一行的摘要。

要点：
  · **必须关缓存**（useCache=false），否则第二次跑就是读上一次的旧结果；
  · 图集里的图要自带 meta.json，否则「命中」无法判定；
  · 每张图会消耗 1 次 SerpAPI 额度（lens 引擎），跑 12 张就是 12 次。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

DIR = os.environ.get("FISH_BENCH_DIR", "/tmp/fishtest")
CORE = os.environ.get("FISH_CORE", "/opt/fish-find-chicken/bin/fish.mjs")
NODE = os.environ.get("FISH_NODE", "node")
BASE_CONFIG = os.environ.get("FISH_CONFIG", "/opt/fish-find-chicken/config.json")


def whisper(path: str, key: str) -> str:
    """从核心配置里取密钥，避免在脚本里重复写一份。"""
    try:
        with open(path, encoding="utf-8") as handle:
            return str(json.load(handle).get(key) or "")
    except Exception:
        return ""


def judge(truth: dict, accounts: list) -> str:
    """判定这张图算不算命中：真出处是社媒原帖就比账号，是插画就比画师名。

    比名字时三样都认：display name、danbooru 画师 tag（evidence.artistTag）、handle。
    早先只比 authorName，结果 anime6 明明第一条就是 @ruoganzhua（名字栏空着）也判 MISS ——
    那是判定器的问题，不是插件的问题，别让它继续吃掉真实成绩。
    """
    source = str(truth.get("source") or "").lower()
    if not source:
        return "?"
    handles = [str(a.get("handle") or "").lower().lstrip("@") for a in accounts]
    names = [str(a.get("authorName") or "").lower() for a in accounts]
    tags = [
        str((a.get("evidence") or {}).get("artistTag") or "").lower().replace("_", " ")
        for a in accounts
    ]
    if "x.com/" in source or "twitter.com/" in source:
        parts = source.rstrip("/").split("/")
        slug = parts[3] if len(parts) > 3 else ""
        if handles and slug and handles[0] == slug:
            return "HIT-1"
        return "hit" if slug and slug in handles else "MISS"
    artist = str(truth.get("artist_tag") or "").lower().replace("_", " ")
    if not artist:
        return "?"
    if names and artist in names[0]:
        return "HIT-1"
    if tags and artist in tags[0]:
        return "HIT-1"
    flat = artist.replace("_", "").replace(" ", "")
    if handles and handles[0].replace("_", "") == flat:
        return "HIT-1"
    return "hit" if (
        any(artist in name for name in names)
        or any(artist in tag for tag in tags)
        or any(handle.replace("_", "") == flat for handle in handles)
    ) else "MISS"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    engines = sys.argv[1]
    files = sys.argv[2:]

    # 关缓存的临时配置：其余项沿用线上 config.json，免得测的和跑的不是一套
    cfg = {"useCache": False, "engines": []}
    for key in ("serpApiKey", "sauceNaoApiKey", "sightengineApiUser", "sightengineApiSecret", "timeoutMs"):
        value = whisper(BASE_CONFIG, key)
        if value:
            cfg[key] = value
    cfg_path = os.path.join(DIR, "cfg.bench.json")
    with open(cfg_path, "w", encoding="utf-8") as handle:
        json.dump(cfg, handle, ensure_ascii=False, indent=2)

    meta_path = os.path.join(DIR, "meta.json")
    meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}
    outdir = os.path.join(DIR, "res")
    os.makedirs(outdir, exist_ok=True)

    for name in files:
        path = name if os.path.isabs(name) else os.path.join(DIR, name)
        base = os.path.basename(path)
        cmd = [NODE, CORE, path, "--json", "--engines", engines, "--config", cfg_path, "--timeout", "40"]
        started = time.time()
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
            raw = proc.stdout
            cut = raw.find("{")
            data = json.loads(raw[cut:]) if cut >= 0 else {"error": (raw[-300:] + proc.stderr[-300:]).strip()}
        except Exception as exc:  # 单张图失败不该中断整批
            data = {"error": str(exc)}
        elapsed = time.time() - started

        truth = meta.get(base, {})
        data["_truth"] = truth
        data["_elapsed"] = round(elapsed, 1)
        with open(os.path.join(outdir, f"{base}.{engines.replace(',', '-')}.json"), "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=1)

        accounts = data.get("accounts") or []
        used = data.get("enginesUsed") or []
        failures = data.get("failures") or []
        accs = " ".join(
            f"{a.get('platform')}:{a.get('handle')}({a.get('authorName') or ''})" for a in accounts[:3]
        )
        fails = "; ".join(f"{f.get('engine')}={str(f.get('reason'))[:30]}" for f in failures)
        print(f"[{engines}] {base:<14} {elapsed:5.1f}s {judge(truth, accounts):<5} "
              f"used={','.join(used)} accs=[{accs}] fails=[{fails}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
