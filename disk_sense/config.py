"""配置加载与路径常量。

所有路径遵循「纯便携」铁律：运行时状态只写入项目根目录的 ``Data/``。
配置文件可整体缺失，缺失时使用内置默认值，保证零配置即可运行。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 路径常量（便携铁律：一切运行时产物都在 Data/ 下）
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "Data"
REPORTS_DIR = DATA_DIR / "reports"
ARCHIVE_DIR = DATA_DIR / "archive"
TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
CONFIG_DIR = PROJECT_ROOT / "config"

CONFIG_FILE = CONFIG_DIR / "config.yaml"
RULES_FILE = CONFIG_DIR / "classification_rules.yaml"

LOCK_FILE = DATA_DIR / "disk_sense.lock"
OP_LOG_DB = DATA_DIR / "op_log.db"
CACHE_DB = DATA_DIR / "cache.db"
PREFS_FILE = DATA_DIR / "user_preferences.json"

DEFAULT_PORT = 58901
DEFAULT_HOST = "127.0.0.1"


def ensure_data_dirs() -> None:
    """创建 Data 目录树（幂等）。首次启动时调用。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# 配置数据类（字段默认值即文档）
# ---------------------------------------------------------------------------
@dataclass
class ServerConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT


@dataclass
class ScanConfig:
    use_mft: bool = True
    max_workers: Optional[int] = None  # None = max(1, CPU-2)
    throttle_every: int = 1000
    throttle_sleep_sec: float = 0.001
    default_dir_ignores: list[str] = field(
        default_factory=lambda: ["$RECYCLE.BIN", "System Volume Information"]
    )


@dataclass
class ScanApiConfig:
    sync_timeout_sec: int = 120


@dataclass
class IdleConfig:
    shutdown_timeout_sec: int = 300


@dataclass
class HistoryConfig:
    retention_days: int = 30


@dataclass
class ReportConfig:
    max_entities: int = 200
    anomaly_min_mb: int = 200
    anomaly_root_min_mb: int = 50
    max_anomalies: int = 50
    treemap_depth: int = 3
    treemap_children: int = 10


@dataclass
class Config:
    server: ServerConfig = field(default_factory=ServerConfig)
    scan: ScanConfig = field(default_factory=ScanConfig)
    scan_api: ScanApiConfig = field(default_factory=ScanApiConfig)
    idle: IdleConfig = field(default_factory=IdleConfig)
    history: HistoryConfig = field(default_factory=HistoryConfig)
    report: ReportConfig = field(default_factory=ReportConfig)


def _apply(dataclass_obj: Any, overrides: Any) -> None:
    """把 YAML 字典中的同名键覆写到 dataclass 实例上（忽略未知键并告警）。"""
    if not isinstance(overrides, dict):
        return
    for key, value in overrides.items():
        if hasattr(dataclass_obj, key):
            setattr(dataclass_obj, key, value)
        else:
            logger.warning("配置项 %s.%s 不存在，已忽略", type(dataclass_obj).__name__, key)


def load_config(path: Path | str | None = None) -> Config:
    """加载 YAML 配置并合并默认值。

    Args:
        path: 配置文件路径，默认 ``config/config.yaml``。文件不存在时
            返回全默认值（不抛异常，保证零配置可运行）。

    Returns:
        Config: 合并后的配置对象。
    """
    cfg = Config()
    p = Path(path) if path is not None else CONFIG_FILE
    if not p.exists():
        logger.info("配置文件 %s 不存在，使用默认配置", p)
        return cfg

    with open(p, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    _apply(cfg.server, raw.get("server"))
    _apply(cfg.scan, raw.get("scan"))
    _apply(cfg.scan_api, raw.get("scan_api"))
    _apply(cfg.idle, raw.get("idle"))
    _apply(cfg.history, raw.get("history"))
    _apply(cfg.report, raw.get("report"))
    return cfg


def default_scan_workers() -> int:
    """os.walk 降级模式的默认线程数：max(1, CPU核心数-2)。"""
    import os

    return max(1, (os.cpu_count() or 4) - 2)
