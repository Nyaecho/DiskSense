"""preferences.py 偏好持久化测试。"""

import json
import threading

import pytest

from disk_sense.preferences import Preferences


def test_defaults_when_missing(tmp_path):
    p = Preferences(tmp_path / "user_preferences.json")
    assert p.data["protected_paths"] == []
    assert p.data["tags"] == {}
    assert p.data["auto_clean_rules"]["temp"]["max_age_days"] == 30
    assert not p.is_protected("D:\\Work\\a.txt")


def test_protection_roundtrip_and_prefix(tmp_path):
    p = Preferences(tmp_path / "user_preferences.json")
    p.add_protection("D:/Work")
    # 大小写与分隔符不敏感；子路径受保护
    assert p.is_protected("d:\\work")
    assert p.is_protected("D:\\Work\\Projects\\alpha")
    assert not p.is_protected("D:\\Workshop")  # 前缀必须是完整目录段
    # 落盘后重载仍有效
    p2 = Preferences(tmp_path / "user_preferences.json")
    assert p2.is_protected("D:\\Work\\x")
    p.remove_protection("d:\\work")
    assert not p.is_protected("D:\\Work\\x")


def test_tag_roundtrip(tmp_path):
    p = Preferences(tmp_path / "user_preferences.json")
    p.set_tag("E:/Downloads", "temp")
    assert p.tags_by_prefix["e:\\downloads"] == "temp"
    p.set_tag("D:/Projects/Alpha", "work")
    assert len(p.tags_by_prefix) == 2
    p.remove_tag("E:\\Downloads")
    assert "e:\\downloads" not in p.tags_by_prefix


def test_corrupt_file_falls_back_to_defaults(tmp_path):
    f = tmp_path / "user_preferences.json"
    f.write_text("{ this is not json", encoding="utf-8")
    p = Preferences(f)
    assert p.data["protected_paths"] == []


def test_unknown_keys_preserved_on_merge(tmp_path):
    f = tmp_path / "user_preferences.json"
    f.write_text(
        json.dumps({"protected_paths": ["C:\\VIP"], "future_key": 42}),
        encoding="utf-8",
    )
    p = Preferences(f)
    assert p.is_protected("C:\\VIP\\secret.txt")
    assert p.data["future_key"] == 42  # 未知键不丢弃
    assert p.data["tags"] == {}  # 缺失键补默认


def test_atomic_write_no_tmp_leftover(tmp_path):
    p = Preferences(tmp_path / "user_preferences.json")
    p.add_protection("C:\\Data")
    leftovers = list(tmp_path.glob("*.tmp"))
    assert leftovers == []
    # 文件内容为合法 JSON
    raw = json.loads((tmp_path / "user_preferences.json").read_text(encoding="utf-8"))
    assert raw["protected_paths"] == ["C:\\Data"]


def test_concurrent_writes_consistent(tmp_path):
    """多线程同时写不应产生损坏文件。"""
    p = Preferences(tmp_path / "user_preferences.json")
    errors = []

    def worker(n):
        try:
            for i in range(10):
                p.set_tag(f"D:\\dir{n}_{i}", f"tag{n}")
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    # 重载校验完整性
    p2 = Preferences(tmp_path / "user_preferences.json")
    assert len(p2.data["tags"]) == 40


def test_ignore_patterns(tmp_path):
    p = Preferences(tmp_path / "user_preferences.json")
    p.add_ignore_pattern("*.pdb")
    assert p.ignore_patterns == ["*.pdb"]
    p.add_ignore_pattern("*.pdb")  # 幂等
    assert p.ignore_patterns == ["*.pdb"]
