"""菲比找鸡 —— AstrBot 薄壳插件。

设计思路：**不重写核心逻辑**。菲比找鸡 v1.1.0 的 Node 核心（抓页面、认账号、排序、
strictConsensus 去重那一坨启发式）原样放在 /opt/fish-find-chicken，
本插件只负责：
  1. 从消息（含引用消息）里取图并落成本地文件；
  2. subprocess 调 `node bin/fish.mjs <图> --json`；
  3. 把 JSON 里的 text 直接回给用户。

这样核心可独立升级（换目录即可），插件侧几乎没有可坏的地方。
"""

from __future__ import annotations

import asyncio
import json

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Image as AstrImage
from astrbot.api.message_components import Reply
from astrbot.api.star import Context, Star, register

KNOWN_ENGINES = ("lens", "saucenao", "iqdb", "tracemoe", "yandex", "baidu", "bing", "google", "ai")

DEFAULT_CORE = "/opt/fish-find-chicken/bin/fish.mjs"
DEFAULT_NODE = "/usr/bin/node"


@register(
    "astrbot_plugin_fish_find_chicken",
    "fish-find-chicken",
    "引用一张图反查出处：真人 coser / 二次元插画 / AI 生成图（谷歌 Lens + SauceNAO + trace.moe，并读图片自带元数据）",
    "1.1.0",
    "布鲁戈",
)
class FishFindChicken(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}

    # ---------- 配置读取 ----------

    def _get(self, key: str, default):
        value = self.config.get(key, default)
        if value is None or value == "":
            return default
        return value

    # ---------- 取图 ----------

    @staticmethod
    def _pick_image(event: AstrMessageEvent) -> AstrImage | None:
        """优先取被引用消息里的图，其次取本条消息自己的图。"""
        for comp in event.get_messages():
            if isinstance(comp, Reply):
                for sub in getattr(comp, "chain", None) or []:
                    if isinstance(sub, AstrImage):
                        return sub
        for comp in event.get_messages():
            if isinstance(comp, AstrImage):
                return comp
        return None

    # ---------- 调核心 ----------

    async def _run_core(self, image_path: str, engines: str) -> dict:
        node = str(self._get("node_path", DEFAULT_NODE))
        core = str(self._get("core_path", DEFAULT_CORE))
        engine_timeout = int(self._get("engine_timeout", 30))
        total_timeout = int(self._get("total_timeout", 150))
        max_accounts = int(self._get("max_accounts", 3))

        cmd = [
            node,
            core,
            image_path,
            "--json",
            "--timeout",
            str(engine_timeout),
            "--max",
            str(max_accounts),
        ]
        if engines:
            cmd += ["--engines", engines]
        if not bool(self._get("strict_consensus", True)):
            cmd.append("--no-strict")

        logger.info("[fish] 调用核心：%s", " ".join(cmd))
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=total_timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"核心进程超时（{total_timeout} 秒）")

        stdout = out.decode("utf-8", "replace").strip()
        stderr = err.decode("utf-8", "replace").strip()
        if stderr:
            logger.debug("[fish] stderr: %s", stderr[:800])
        if proc.returncode != 0 and not stdout:
            raise RuntimeError(stderr[:300] or f"核心退出码 {proc.returncode}")

        # node 的 ExperimentalWarning 走 stderr，stdout 应是纯 JSON；
        # 仍做一次容错：从第一个 { 开始截取。
        start = stdout.find("{")
        if start < 0:
            raise RuntimeError(f"核心没有输出 JSON：{stdout[:200]}")
        return json.loads(stdout[start:])

    # ---------- 命令 ----------

    @filter.command("菲比找鸡", alias={"/菲比找鸡"})
    async def fish(self, event: AstrMessageEvent):
        """引用一张图，发「菲比找鸡」；可在命令后加引擎名，如「菲比找鸡 lens」。"""
        raw = (event.message_str or "").strip()
        engines = str(self._get("engines", "lens,saucenao,tracemoe"))
        for word in raw.replace("/", " ").split():
            if word.lower() in KNOWN_ENGINES:
                engines = word.lower()
                break

        image = self._pick_image(event)
        if image is None:
            yield event.plain_result("要引用一张图，再发「菲比找鸡」")
            return

        yield event.plain_result("收到，开始找鸡…")

        try:
            path = await image.convert_to_file_path()
            data = await self._run_core(path, engines)
        except Exception as exc:  # noqa: BLE001 - 任何异常都要变成人话回给用户
            logger.error("[fish] 执行失败：%s", exc)
            yield event.plain_result(f"菲比找鸡出错了：{exc}")
            return

        text = str(data.get("text") or "").strip() or "没查到结果"
        used = data.get("enginesUsed") or []
        failures = data.get("failures") or []
        lines = [text]
        if used:
            lines.append("引擎：" + "、".join(str(u) for u in used))
        if failures:
            lines.append(
                "没出结果的："
                + "、".join(
                    f"{f.get('engine')}（{f.get('reason')}）"
                    for f in failures
                    if isinstance(f, dict)
                )
            )
        yield event.plain_result("\n\n".join(lines))
