"""disk_sense.config 配置加载测试。"""

from pathlib import Path

from disk_sense.config import (
    Config,
    RULES_FILE,
    ensure_data_dirs,
    load_config,
)


def test_defaults_when_file_missing(tmp_path: Path):
    cfg = load_config(tmp_path / "nonexistent.yaml")
    assert isinstance(cfg, Config)
    assert cfg.server.port == 58901
    assert cfg.server.host == "127.0.0.1"
    assert cfg.scan.use_mft is True
    assert cfg.scan.max_workers is None
    assert cfg.scan.throttle_every == 1000
    assert cfg.idle.shutdown_timeout_sec == 300
    assert not hasattr(cfg, "report")  # report 配置段已不存在


def test_load_repo_default_config():
    """仓库自带的 config.yaml 必须能被解析且结构合法。"""
    cfg = load_config()
    assert cfg.server.port == 58901
    assert "$RECYCLE.BIN" in cfg.scan.default_dir_ignores
    assert cfg.scan_api.sync_timeout_sec == 120
    assert cfg.history.retention_days == 30


def test_override_from_yaml(tmp_path: Path):
    f = tmp_path / "config.yaml"
    f.write_text(
        "server:\n  port: 6000\nscan:\n  use_mft: false\n",
        encoding="utf-8",
    )
    cfg = load_config(f)
    assert cfg.server.port == 6000
    assert cfg.scan.use_mft is False
    # 未覆盖的字段保持默认
    assert cfg.idle.shutdown_timeout_sec == 300


def test_unknown_keys_ignored(tmp_path: Path):
    f = tmp_path / "config.yaml"
    f.write_text("server:\n  nonsense: 1\n", encoding="utf-8")
    cfg = load_config(f)  # 不应抛异常
    assert cfg.server.port == 58901


def test_ensure_data_dirs_idempotent(tmp_path: Path, monkeypatch):
    import disk_sense.config as c

    # 把 Data 目录重定向到临时目录，避免污染仓库
    monkeypatch.setattr(c, "DATA_DIR", tmp_path / "Data")
    monkeypatch.setattr(c, "ARCHIVE_DIR", tmp_path / "Data" / "archive")
    c.ensure_data_dirs()
    assert (tmp_path / "Data").is_dir()
    assert (tmp_path / "Data" / "archive").is_dir()
    c.ensure_data_dirs()  # 幂等


def test_rules_yaml_exists_and_parseable():
    """规则文件是规则引擎的输入，交付物中必须存在且为合法 YAML。"""
    import yaml

    assert RULES_FILE.exists()
    with open(RULES_FILE, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    rules = data["rules"]
    assert len(rules) >= 8
    for rule in rules:
        assert "signal" in rule and "condition" in rule and "description" in rule
        assert isinstance(rule["signal"], str) and rule["signal"].isupper()
