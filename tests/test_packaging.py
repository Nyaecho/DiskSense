"""package_skill.py 打包脚本测试：产物必须能被 cc-switch install_from_zip 识别。"""

import importlib.util
import sys
import zipfile
from pathlib import Path

import pytest


def _load_packager():
    spec = importlib.util.spec_from_file_location(
        "package_skill", Path(__file__).parent.parent / "scripts" / "package_skill.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def built_zip(tmp_path_factory):
    mod = _load_packager()
    out = tmp_path_factory.mktemp("dist") / "skill.zip"
    mod.build_zip(out)
    return out, mod


class TestPackage:
    def test_layout_skill_md_at_folder_root(self, built_zip):
        """cc-switch 递归扫描 SKILL.md；必须恰好一个且在技能文件夹根部。"""
        out, _ = built_zip
        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
        skill_mds = [n for n in names if n.endswith("SKILL.md")]
        assert skill_mds == ["disk-sense-manager/SKILL.md"]

    def test_no_dev_artifacts(self, built_zip):
        """开发产物绝不能入包（.venv 会撞 cc-switch 条目/体积上限）。"""
        out, _ = built_zip
        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
        forbidden = [n for n in names if any(
            seg in n for seg in (".venv", "Data/", "tests/", "__pycache__", ".git", ".pytest_cache")
        ) or n.endswith((".pyc", ".pyo", ".lock", ".tmp"))]
        assert forbidden == [], forbidden

    def test_essentials_present(self, built_zip):
        out, _ = built_zip
        with zipfile.ZipFile(out) as zf:
            names = set(zf.namelist())
        for must in (
            "disk-sense-manager/SKILL.md",
            "disk-sense-manager/requirements.txt",
            "disk-sense-manager/scripts/api_client.py",
            "disk-sense-manager/scripts/launcher.py",
            "disk-sense-manager/disk_sense/server.py",
            "disk-sense-manager/disk_sense/templates/template.html",
            "disk-sense-manager/disk_sense/templates/vendor/d3.min.js",  # 离线仪表盘
            "disk-sense-manager/config/config.yaml",
            "disk-sense-manager/config/classification_rules.yaml",
        ):
            assert must in names, must

    def test_entry_count_within_safe_limit(self, built_zip):
        """远低于 cc-switch 的 ZIP 条目数上限（防 zip 炸弹阈值）。"""
        out, _ = built_zip
        with zipfile.ZipFile(out) as zf:
            count = len(zf.namelist())
        assert count < 200

    def test_skill_md_frontmatter_name_matches_folder(self, built_zip):
        """SKILL.md 的 name 与技能文件夹名一致（cc-switch 以 name 为安装名）。"""
        out, mod = built_zip
        with zipfile.ZipFile(out) as zf:
            skill_md = zf.read("disk-sense-manager/SKILL.md").decode("utf-8")
        assert f"name: {mod.SKILL_NAME}" in skill_md

    def test_deterministic_bytes(self, built_zip, tmp_path):
        """同内容两次构建字节一致（固定时间戳）。"""
        out, mod = built_zip
        second = tmp_path / "again.zip"
        mod.build_zip(second)
        assert out.read_bytes() == second.read_bytes()

    def test_missing_file_fails_loudly(self, tmp_path, monkeypatch):
        mod = _load_packager()
        monkeypatch.setattr(mod, "PROJECT_ROOT", tmp_path)  # 空目录
        with pytest.raises(SystemExit):
            mod.collect_files()
