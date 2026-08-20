"""指纹聚合器（方案书 §7，Token 优化的核心）。

不把百万条文件路径塞给 LLM，而是聚合为 50~200 个「软件实体」，
令指纹档案 JSON 控制在 ~5000 Token 内。

算法（贪婪匹配）：
1. 种子提取：Program Files(-x86)/ProgramData 一级子目录，以及
   Users\\*\\AppData\\{Local,Roaming,LocalLow} 的一级子目录；
2. 角色映射：program_base / user_data / cache / logs（Temp、Cache、
   Logs 等路径标记自动改写角色）；
3. 关联扩展：标准目录之外的路径若包含已知种子名（如 C:\\AdobeTemp），
   归入对应实体并标记 location_anomaly；
4. 未归类的大文件进入 global_anomalies，批量完成魔数识别，
   Agent 无需逐个查询。

附加（超出方案书、服务于仪表盘与 /detail）：
- treemap 树形数据；
- 每实体每角色的 Top5 文件（供 query_detail，不进入 JSON）；
- 「系统临时文件」伪实体（AppData\\Local\\Temp 与 Windows\\Temp 的
  无主缓存，天然是清理建议的高价值目标）。
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional

from . import magic
from .config import ReportConfig
from .models import Node, ScanResult
from .rules_engine import RulesEngine

logger = logging.getLogger(__name__)

MB = 1024 * 1024

ROLE_PROGRAM = "program_base"
ROLE_USER = "user_data"
ROLE_CACHE = "cache"
ROLE_LOGS = "logs"
_ROLES = (ROLE_PROGRAM, ROLE_USER, ROLE_CACHE, ROLE_LOGS)
_ROLE_LABELS = {
    ROLE_PROGRAM: "安装目录",
    ROLE_USER: "用户数据",
    ROLE_CACHE: "缓存",
    ROLE_LOGS: "日志",
}

_PROGRAM_BASES = {"program files", "program files (x86)"}
_APPDATA_MODES = {"local", "localLow".lower(), "roaming"}
# 种子黑名单：这些名字位于种子位置但只是系统区域，不构成软件实体
_SEED_BLACKLIST = {"temp", "tmp", "cache", "caches", "logs", "log", "crashdumps", "microsoft windows"}
_CACHE_MARKERS = {"temp", "tmp", "cache", "caches", "cache2", "gpucache", "code cache", "shadercache", "crash dumps"}
_LOG_MARKERS = {"logs", "log", "_logs", "logging"}
_SYSTEM_TEMP_ID = "system-temp"

# Treemap 顶层直接展示、不做实体归属的根目录
_COVERED_TOP = {"program files", "program files (x86)", "users", "programdata"}


def _mb(size_bytes: int) -> float:
    return round(size_bytes / MB, 1)


@dataclass
class _Loc:
    bytes: int = 0
    files: int = 0
    has_exe: bool = False
    # Top5 文件堆（按大小降序维护，供 /detail）
    top: list[dict] = field(default_factory=list)

    def add_file(self, name: str, path: str, size: int, mtime: float, is_exe: bool) -> None:
        self.bytes += size
        self.files += 1
        if is_exe:
            self.has_exe = True
        item = {"name": name, "path": path, "size": size, "mtime": mtime}
        if len(self.top) < 5:
            self.top.append(item)
            self.top.sort(key=lambda x: x["size"], reverse=True)
        elif size > self.top[-1]["size"]:
            self.top[-1] = item
            self.top.sort(key=lambda x: x["size"], reverse=True)


@dataclass
class _Entity:
    id: str
    display: str
    locs: dict = field(default_factory=lambda: {r: _Loc() for r in _ROLES})
    anomaly: bool = False
    newest_activity: float = 0.0
    ext_bytes: dict = field(default_factory=dict)  # ext → bytes
    tags: set = field(default_factory=set)

    @property
    def total_bytes(self) -> int:
        return sum(loc.bytes for loc in self.locs.values())


class Aggregator:
    """把 ScanResult 树聚合成指纹档案。"""

    def __init__(
        self,
        cfg: Optional[ReportConfig] = None,
        rules: Optional[RulesEngine] = None,
        tags_by_prefix: Optional[dict[str, str]] = None,
        now: Optional[float] = None,
        magic_classifier=None,
    ):
        """Args:
            magic_classifier: 魔数分类函数（默认 magic.classify_magic_number，
                注入接缝仅为测试，不影响生产行为）。
        """
        self.cfg = cfg or ReportConfig()
        self.rules = rules or RulesEngine()
        self.tags_by_prefix = {
            k.lower().replace("/", "\\").rstrip("\\"): v for k, v in (tags_by_prefix or {}).items()
        }
        self.now = now if now is not None else time.time()
        self._classify_magic = magic_classifier or magic.classify_magic_number
        self.seeds: dict[str, str] = {}  # seed_lower → display
        # 供 /detail 使用（不进指纹 JSON）
        self.entity_top_files: dict[str, dict[str, list[dict]]] = {}
        self._unassigned_bytes = 0

    # ------------------------------------------------------------------
    def aggregate(self, result: ScanResult, session_id: str) -> dict:
        """执行聚合，返回方案书 §7.3 形状的指纹档案（附加 treemap/legend）。"""
        root = result.root
        self._collect_seeds(root)

        entities: dict[str, _Entity] = {}
        anomalies: list[tuple[str, int, float]] = []  # (path, size, mtime)

        self._walk(
            root,
            [root.name],
            [root.name.lower()],
            entities,
            anomalies,
        )

        ordered = sorted(entities.values(), key=lambda e: e.total_bytes, reverse=True)
        truncated = max(0, len(ordered) - self.cfg.max_entities)
        ordered = ordered[: self.cfg.max_entities]

        # --- global_anomalies：未归类大文件，批量魔数识别 ---
        anomalies.sort(key=lambda a: a[1], reverse=True)
        picked = anomalies[: self.cfg.max_anomalies]
        global_anomalies = []
        for path, size, mtime in picked:
            info = self._classify_magic(path)
            global_anomalies.append(
                {
                    "path_preview": path if len(path) <= 160 else path[:157] + "...",
                    "size_mb": _mb(size),
                    "magic_type": info["magic_type"],
                }
            )

        # --- 实体字典化 + 信号评估 ---
        entity_dicts = [self._entity_to_dict(e) for e in ordered]

        fingerprint = {
            "session_id": session_id,
            "drive": root.name,
            "entities": entity_dicts,
            "global_anomalies": global_anomalies,
            "summary": {
                "total_scanned_mb": _mb(result.total_bytes),
                "files": result.files,
                "dirs": result.dirs,
                "skipped_dirs_count": len(result.skipped_paths),
                "skipped_paths": result.skipped_paths[:5],
                "scan_time_sec": round(result.elapsed_sec, 1),
                "scan_mode": result.mode,
                "entities_count": len(entity_dicts),
                "entities_truncated": truncated,
            },
            "signals_legend": {r.signal: r.description for r in self.rules.rules},
            "treemap": self._build_treemap(root, ordered),
        }
        return fingerprint

    # ------------------------------------------------------------------
    def _collect_seeds(self, root: Node) -> None:
        """贪婪种子提取：标准安装/数据目录的一级子目录名。"""

        def add_children_as_seeds(node: Node) -> None:
            if not node.children:
                return
            for name, child in node.children.items():
                low = name.lower()
                if low in _SEED_BLACKLIST or not child.size:
                    continue
                self.seeds[low] = name

        for top_name, top in (root.children or {}).items():
            low = top_name.lower()
            if low in _PROGRAM_BASES or low == "programdata":
                add_children_as_seeds(top)
            elif low == "users":
                for user in (top.children or {}).values():
                    appdata = (user.children or {}).get("AppData")
                    if appdata is None:
                        continue
                    for mode, node in (appdata.children or {}).items():
                        if mode.lower() in _APPDATA_MODES:
                            add_children_as_seeds(node)

    # ------------------------------------------------------------------
    def _classify_path(
        self, parts_low: list[str], is_dir: bool = False
    ) -> tuple[Optional[str], Optional[str], bool, int]:
        """路径 → (实体种子名|None, 角色|None, 是否异常位置, 基准目录下标)。

        角色由基准目录之后的路径标记（Temp/Cache/Logs）决定；
        无种子但角色为缓存者归入系统临时伪实体。
        """
        base_idx = -1
        base_role: Optional[str] = None
        for i, p in enumerate(parts_low):
            if p in _PROGRAM_BASES:
                base_idx, base_role = i, ROLE_PROGRAM
                break
            if p == "appdata":
                base_idx, base_role = i, ROLE_USER
                break
            if p == "programdata":
                base_idx, base_role = i, ROLE_USER
                break

        seed: Optional[str] = None
        role: Optional[str] = None
        is_appdata = base_idx >= 0 and parts_low[base_idx] == "appdata"
        if base_idx >= 0:
            rest = parts_low[base_idx + 1 :]
            # AppData 需要穿过 Local/Roaming/LocalLow 才到种子
            if is_appdata:
                if rest and rest[0] in _APPDATA_MODES:
                    rest = rest[1:]
                else:
                    rest = []  # AppData 根下散落文件，不构成实体
            seed = rest[0] if rest else None
            if seed in _SEED_BLACKLIST:
                seed = None
            # 基准目录根下的散文件（如 Program Files\x.dll）不构成实体
            if seed is not None and not is_dir:
                seed_pos = base_idx + (2 if is_appdata else 1)
                if seed_pos == len(parts_low) - 1:
                    seed = None
            cache_idx = max((i for i, p in enumerate(rest) if p in _CACHE_MARKERS), default=-1)
            log_idx = max((i for i, p in enumerate(rest) if p in _LOG_MARKERS), default=-1)
            if cache_idx > log_idx:
                role = ROLE_CACHE
            elif log_idx > cache_idx:
                role = ROLE_LOGS
            else:
                role = base_role
            if seed is not None:
                return seed, role, False, base_idx

        # Windows\Temp 等系统临时区 → 系统临时伪实体
        if base_idx == -1:
            for i in range(len(parts_low) - 1):
                if parts_low[i] == "windows" and parts_low[i + 1] in _CACHE_MARKERS:
                    return _SYSTEM_TEMP_ID, ROLE_CACHE, False, -1

        # 关联扩展：路径任意段包含已知种子名 → 归入该实体（位置异常）
        for i, p in enumerate(parts_low):
            if p in self.seeds:
                return p, self._marker_role(parts_low, i) or ROLE_USER, True, base_idx
        for i, p in enumerate(parts_low):
            for s in self.seeds:
                if len(s) >= 3 and s in p:
                    return s, self._marker_role(parts_low, i) or ROLE_USER, True, base_idx

        # 无实体：纯缓存角色 → 系统临时伪实体；否则未归类
        if role == ROLE_CACHE and base_idx >= 0:
            return _SYSTEM_TEMP_ID, ROLE_CACHE, False, base_idx
        return None, role, False, base_idx

    @staticmethod
    def _marker_role(parts_low: list[str], up_to: int) -> Optional[str]:
        cache = any(p in _CACHE_MARKERS for p in parts_low[: up_to + 1])
        logs = any(p in _LOG_MARKERS for p in parts_low[: up_to + 1])
        if cache and not logs:
            return ROLE_CACHE
        if logs and not cache:
            return ROLE_LOGS
        return None

    # ------------------------------------------------------------------
    def _walk(
        self,
        node: Node,
        parts: list[str],
        parts_low: list[str],
        entities: dict[str, _Entity],
        anomalies: list[tuple[str, int, float]],
    ) -> None:
        """DFS 实体归集。parts 为显示路径段，parts_low 为小写匹配段。"""
        for name, child in (node.children or {}).items():
            cparts = parts + [name]
            cparts_low = parts_low + [name.lower()]
            path = "\\".join(cparts)

            if child.is_dir and child.children:
                self._walk(child, cparts, cparts_low, entities, anomalies)
                continue

            size = child.size
            if size <= 0:
                continue

            seed, role, anomaly, _ = self._classify_path(cparts_low, is_dir=child.is_dir)
            ext = os.path.splitext(name)[1].lower()

            if seed is None:
                # 未归类：按体积门槛进入 global_anomalies 候选
                threshold = self.cfg.anomaly_root_min_mb if len(cparts) <= 2 else self.cfg.anomaly_min_mb
                if size >= threshold * MB:
                    anomalies.append((path, size, child.mtime))
                self._unassigned_bytes += size
                continue

            entity = entities.get(seed)
            if entity is None:
                display = (
                    "系统临时文件" if seed == _SYSTEM_TEMP_ID else self.seeds.get(seed, seed)
                )
                entity = entities[seed] = _Entity(id=seed, display=display)
            if anomaly:
                entity.anomaly = True

            target_role = role or ROLE_USER
            loc = entity.locs[target_role]
            loc.add_file(name, path, size, child.mtime, ext == ".exe" and target_role == ROLE_PROGRAM)
            entity.ext_bytes[ext] = entity.ext_bytes.get(ext, 0) + size
            activity = max(child.mtime, child.atime)
            if activity > entity.newest_activity:
                entity.newest_activity = activity

            # 用户标签：最长前缀匹配
            for prefix, tag in self.tags_by_prefix.items():
                if path.lower().startswith(prefix):
                    entity.tags.add(tag)
                    break

    # ------------------------------------------------------------------
    def _entity_to_dict(self, e: _Entity) -> dict:
        total = e.total_bytes
        last_days = (
            max(0, int((self.now - e.newest_activity) / 86400)) if e.newest_activity else None
        )
        top_exts = sorted(e.ext_bytes.items(), key=lambda kv: kv[1], reverse=True)[:3]
        d = {
            "id": e.id,
            "display": e.display,
            "total_size_mb": _mb(total),
            "locations": {
                r: {
                    "size_mb": _mb(e.locs[r].bytes),
                    "file_count": e.locs[r].files,
                    "has_exe": e.locs[r].has_exe,
                }
                for r in _ROLES
            },
            "signals": self.rules.evaluate(
                {
                    "id": e.id,
                    "total_size_mb": _mb(total),
                    "last_access_days": last_days,
                    "location_anomaly": e.anomaly,
                    "locations": {
                        r: {
                            "size_mb": _mb(e.locs[r].bytes),
                            "file_count": e.locs[r].files,
                            "has_exe": e.locs[r].has_exe,
                        }
                        for r in _ROLES
                    },
                }
            ),
            "last_access_days": last_days,
            "top_extensions": [ext or "(无扩展名)" for ext, _ in top_exts],
            "location_anomaly": e.anomaly,
            "tags": sorted(e.tags),
        }
        # /detail 数据留存在聚合器实例上（不进指纹 JSON，省 Token）
        self.entity_top_files[e.id] = {
            r: [
                {"name": f["name"], "path": f["path"], "size": f["size"], "mtime": f["mtime"]}
                for f in e.locs[r].top
            ]
            for r in _ROLES
        }
        return d

    # ------------------------------------------------------------------
    def _build_treemap(self, root: Node, ordered: list[_Entity]) -> dict:
        """实体树 + 非覆盖根目录 → 仪表盘 Treemap 数据（含实体 id 供高亮）。"""
        children: list[dict] = []
        for e in ordered:
            role_children = [
                {
                    "name": _ROLE_LABELS[r],
                    "id": f"{e.id}:{r}",
                    "value": e.locs[r].bytes,
                }
                for r in _ROLES
                if e.locs[r].bytes > 0
            ]
            children.append(
                {
                    "name": e.display,
                    "id": e.id,
                    "value": e.total_bytes,
                    "children": role_children,
                }
            )

        covered = {"program files", "program files (x86)", "users", "programdata"}
        rest_dirs = [
            c for n, c in (root.children or {}).items() if n.lower() not in covered and c.size > 0
        ]
        rest_dirs.sort(key=lambda c: c.size, reverse=True)
        for d in rest_dirs[: self.cfg.treemap_children]:
            sub = sorted((d.children or {}).values(), key=lambda c: c.size, reverse=True)
            children.append(
                {
                    "name": d.name,
                    "id": f"dir:{d.name.lower()}",
                    "value": d.size,
                    "children": [
                        {"name": s.name, "id": f"dir:{d.name.lower()}\\{s.name.lower()}", "value": s.size}
                        for s in sub[: self.cfg.treemap_children]
                        if s.size > 0
                    ],
                }
            )

        if self._unassigned_bytes > 0:
            children.append(
                {"name": "未归类文件", "id": "unassigned", "value": self._unassigned_bytes}
            )
        return {"name": root.name, "id": "root", "children": children}
