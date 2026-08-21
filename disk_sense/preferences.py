"""用户偏好与长期记忆系统。

持久化于 ``Data/user_preferences.json``：
- 保护路径（protected_paths）：任何文件操作直接拒绝；
- 标签（tags）：路径前缀 → 标签，聚合时合并进实体 tags；
- 忽略模式（ignore_patterns）：扫描时跳过匹配的目录名；
- 自动清理规则（auto_clean_rules）：供 Agent 生成建议时参考。

写入策略：FileLock 互斥 + 临时文件 fsync + os.replace 原子替换，
进程在任何时刻崩溃都不会留下半截 JSON。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Optional

from filelock import FileLock

logger = logging.getLogger(__name__)

DEFAULT_PREFS: dict[str, Any] = {
    "protected_paths": [],
    "tags": {},
    "ignore_patterns": [],
    "pseudo_entity_paths": [],
    "auto_clean_rules": {
        "temp": {"max_age_days": 30, "enabled": True},
        "logs": {"max_age_days": 90, "enabled": False},
    },
}


def _norm(path: str) -> str:
    """路径归一化（小写 + 反斜杠 + 去尾分隔符），用于大小写不敏感前缀比较。"""
    return os.path.abspath(path).replace("/", "\\").rstrip("\\").lower()


class Preferences:
    """用户偏好的内存态与磁盘态同步。"""

    def __init__(self, filepath: Path | str):
        self.filepath = Path(filepath)
        self.lock_path = Path(str(self.filepath) + ".lock")
        self._lock = threading.RLock()
        self._data: dict[str, Any] = {}
        self.load()

    # ------------------------------------------------------------------
    def load(self) -> None:
        """从磁盘加载；损坏或缺失时回退默认值（绝不抛异常阻断服务）。"""
        with self._lock:
            if not self.filepath.exists():
                self._data = json.loads(json.dumps(DEFAULT_PREFS))  # 深拷贝
                return
            try:
                with open(self.filepath, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if not isinstance(loaded, dict):
                    raise ValueError("偏好文件顶层必须是对象")
            except (OSError, ValueError) as e:
                logger.warning("偏好文件损坏，使用默认值: %s", e)
                self._data = json.loads(json.dumps(DEFAULT_PREFS))
                return
            # 与默认结构合并，保证新增键向后兼容
            merged = json.loads(json.dumps(DEFAULT_PREFS))
            merged.update(loaded)
            self._data = merged

    def save(self) -> None:
        """原子写入磁盘（FileLock + 临时文件 + os.replace）。"""
        with self._lock:
            self.filepath.parent.mkdir(parents=True, exist_ok=True)
            with FileLock(str(self.lock_path), timeout=5):
                fd, tmp = tempfile.mkstemp(
                    dir=str(self.filepath.parent), suffix=".tmp"
                )
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as f:
                        json.dump(self._data, f, ensure_ascii=False, indent=2)
                        f.flush()
                        os.fsync(f.fileno())
                    os.replace(tmp, self.filepath)
                except OSError:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
                    raise

    @property
    def data(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._data))  # 深拷贝防外部篡改

    # ------------------------------------------------------------------
    # 保护路径
    # ------------------------------------------------------------------
    def is_protected(self, path: str) -> bool:
        """路径是否位于任一保护路径之下（含自身）。"""
        with self._lock:
            targets = [_norm(p) for p in self._data["protected_paths"]]
        p = _norm(path)
        return any(p == t or p.startswith(t + "\\") for t in targets)

    def add_protection(self, path: str) -> dict:
        with self._lock:
            if path not in self._data["protected_paths"]:
                self._data["protected_paths"].append(path)
                self.save()
        return {"status": "added", "path": path}

    def remove_protection(self, path: str) -> dict:
        with self._lock:
            self._data["protected_paths"] = [
                p for p in self._data["protected_paths"] if _norm(p) != _norm(path)
            ]
            self.save()
        return {"status": "removed", "path": path}

    # ------------------------------------------------------------------
    # 标签
    # ------------------------------------------------------------------
    def set_tag(self, path: str, tag: str) -> dict:
        with self._lock:
            self._data["tags"][path] = tag
            self.save()
        return {"status": "tagged", "path": path, "tag": tag}

    def remove_tag(self, path: str) -> dict:
        """移除标签（路径按归一化比较，大小写/分隔符不敏感）。"""
        with self._lock:
            want = _norm(path)
            self._data["tags"] = {
                k: v for k, v in self._data["tags"].items() if _norm(k) != want
            }
            self.save()
        return {"status": "untagged", "path": path}

    @property
    def tags_by_prefix(self) -> dict[str, str]:
        """{归一化前缀: 标签}，供聚合器做最长前缀匹配。"""
        with self._lock:
            return {_norm(k): v for k, v in self._data["tags"].items()}

    # ------------------------------------------------------------------
    # 忽略模式 / 自动清理规则
    # ------------------------------------------------------------------
    @property
    def ignore_patterns(self) -> list[str]:
        with self._lock:
            return list(self._data["ignore_patterns"])

    def add_ignore_pattern(self, pattern: str) -> dict:
        with self._lock:
            if pattern not in self._data["ignore_patterns"]:
                self._data["ignore_patterns"].append(pattern)
                self.save()
        return {"status": "added", "pattern": pattern}

    def get_auto_clean_rule(self, kind: str) -> Optional[dict]:
        with self._lock:
            rule = self._data["auto_clean_rules"].get(kind)
            return dict(rule) if rule else None

    # ------------------------------------------------------------------
    # 伪实体标记路径（pseudo-entities）
    # ------------------------------------------------------------------
    @property
    def pseudo_entity_paths(self) -> list[str]:
        with self._lock:
            return list(self._data.get("pseudo_entity_paths", []))

    def add_pseudo_entity_path(self, path: str) -> dict:
        with self._lock:
            paths = self._data.setdefault("pseudo_entity_paths", [])
            if _norm(path) not in [_norm(p) for p in paths]:
                paths.append(path)
                self.save()
        return {"status": "added", "path": path}

    def remove_pseudo_entity_path(self, path: str) -> dict:
        with self._lock:
            want = _norm(path)
            self._data["pseudo_entity_paths"] = [
                p for p in self._data.get("pseudo_entity_paths", []) if _norm(p) != want
            ]
            self.save()
        return {"status": "removed", "path": path}
