"""scanner.py 多线程 walk 扫描与调度逻辑测试（使用 tmp_path，不触碰真实系统盘）。"""

import os
import subprocess
import sys
import time

import pytest

from disk_sense import scanner
from disk_sense.config import ScanConfig


def _make_tree(base):
    """构造: base/{a.bin(1000), sub/{b.bin(200), deep/{c.bin(50)}}, keep/{x(10)}"""
    sub = base / "sub"
    deep = sub / "deep"
    keep = base / "keep"
    deep.mkdir(parents=True)
    keep.mkdir()
    (base / "a.bin").write_bytes(b"x" * 1000)
    (sub / "b.bin").write_bytes(b"x" * 200)
    (deep / "c.bin").write_bytes(b"x" * 50)
    (keep / "x.bin").write_bytes(b"x" * 10)
    return sub, deep


def test_walk_basic_sizes_and_counts(tmp_path):
    _make_tree(tmp_path)
    result = scanner.scan_via_walk(str(tmp_path), cfg=ScanConfig(max_workers=2))
    assert result.mode == "walk"
    assert result.files == 4
    assert result.total_bytes == 1260
    # 目录大小聚合
    root = result.root
    assert root.size == 1260
    assert root.children["sub"].size == 250
    assert root.children["keep"].size == 10
    # 目录时间 = 子节点最新时间
    assert root.children["sub"].mtime >= time.time() - 3600


def test_walk_progress_callback(tmp_path):
    _make_tree(tmp_path)
    calls = []
    scanner.scan_via_walk(
        str(tmp_path), progress_cb=lambda p, f, b: calls.append(p), cfg=ScanConfig()
    )
    assert calls and calls[-1] == 1.0
    assert all(0 <= p <= 1 for p in calls)
    # 进度单调不减
    assert calls == sorted(calls)


def test_walk_ignore_globs(tmp_path):
    _make_tree(tmp_path)
    result = scanner.scan_via_walk(str(tmp_path), ignore_globs=["keep"])
    assert result.files == 3
    assert "keep" not in result.root.children


def test_cache_pattern_recognition(tmp_path):
    """命中缓存模式库的目录节点应携带 cache_type 标注。"""
    from disk_sense.scanner import load_cache_dir_patterns, match_cache_pattern, scan_via_walk

    (tmp_path / ".pnpm-store" / "v10").mkdir(parents=True)
    (tmp_path / ".pnpm-store" / "v10" / "pkg.tgz").write_bytes(b"x" * 100)
    (tmp_path / "huggingface").mkdir()
    (tmp_path / "huggingface" / "model.bin").write_bytes(b"y" * 50)
    (tmp_path / "normal_dir").mkdir()
    (tmp_path / "normal_dir" / "a.txt").write_bytes(b"z")

    result = scan_via_walk(str(tmp_path))

    def find(name):
        for n in (result.root.children or {}).values():
            if n.name == name:
                return n
        return None

    pnpm = find(".pnpm-store")
    assert pnpm is not None and pnpm.cache_type == "pnpm"
    hf = find("huggingface")
    assert hf is not None and hf.cache_type == "huggingface"
    normal = find("normal_dir")
    assert normal is not None and normal.cache_type is None


def test_match_cache_pattern():
    from disk_sense.scanner import match_cache_pattern

    patterns = [(".pnpm-store", "pnpm"), ("pkgs", "conda")]
    assert match_cache_pattern(".PNPM-STORE", patterns) == "pnpm"
    assert match_cache_pattern("pkgs", patterns) == "conda"
    assert match_cache_pattern("other", patterns) is None
    assert match_cache_pattern("other", []) is None


def test_load_cache_dir_patterns_missing(tmp_path):
    from disk_sense.scanner import load_cache_dir_patterns

    assert load_cache_dir_patterns(tmp_path / "nonexistent.yaml") == []


def test_walk_default_ignores(tmp_path):
    (tmp_path / "$RECYCLE.BIN").mkdir()
    (tmp_path / "$RECYCLE.BIN" / "junk").write_bytes(b"x" * 100)
    _make_tree(tmp_path)
    result = scanner.scan_via_walk(str(tmp_path))
    assert "$RECYCLE.BIN" not in result.root.children


def test_walk_missing_target_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        scanner.scan_via_walk(str(tmp_path / "nope"))


def test_scan_dispatcher_uses_walk_for_plain_path(tmp_path):
    _make_tree(tmp_path)
    result = scanner.scan(str(tmp_path), cfg=ScanConfig())
    assert result.mode == "walk"  # 非 "X:" 盘符一律 walk


def test_empty_dir(tmp_path):
    result = scanner.scan_via_walk(str(tmp_path))
    assert result.files == 0 and result.root.size == 0


def test_unicode_names(tmp_path):
    d = tmp_path / "项目文件"
    d.mkdir()
    (d / "报告.txt").write_bytes(b"y" * 7)
    result = scanner.scan_via_walk(str(tmp_path))
    assert result.root.children["项目文件"].children["报告.txt"].size == 7


@pytest.mark.skipif(sys.platform != "win32", reason="Junction 仅 Windows")
def test_junction_not_traversed(tmp_path):
    """Junction 指向含文件的目录：自身可见但不下钻（死循环防护）。"""
    real = tmp_path / "real"
    real.mkdir()
    (real / "big.bin").write_bytes(b"x" * 500)
    link = tmp_path / "link_to_real"
    r = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(real)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        pytest.skip("无法创建 Junction（环境限制）")
    result = scanner.scan_via_walk(str(tmp_path))
    node = result.root.children["link_to_real"]
    assert node.is_link is True
    # real/big.bin 只计一次，不因 Junction 重复遍历
    assert result.files == 1
    assert result.total_bytes == 500


@pytest.mark.skipif(sys.platform != "win32", reason="盘符探测仅 Windows")
def test_get_drive_type_system_drive():
    assert scanner.get_drive_type("C:\\") == 3  # 系统盘必为本地硬盘
    assert scanner.get_drive_type("D:\\adobe\\nonexistent\\") == 0  # 非盘符


class TestNormalizeTarget:
    """裸盘符归一化（Windows 陷阱：abspath("C:") 指向 C 盘的 CWD 而非盘根）。"""

    @pytest.mark.parametrize("raw,expect", [
        ("C:", "C:\\"),
        ("c:", "C:\\"),
        ("C:\\", "C:\\"),
        ("C:/", "C:\\"),
        ("C:\\\\", "C:\\"),
        (r"D:\dir", r"D:\dir"),
        ("D:/dir/x", "D:/dir/x"),
        ("relative/path", "relative/path"),
    ])
    def test_normalize(self, raw, expect):
        assert scanner._normalize_target(raw) == expect
