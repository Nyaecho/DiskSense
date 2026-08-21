"""打包 Skill 交付物 ZIP（方案书 §16.1 + cc-switch 兼容）。

cc-switch 的 install_from_zip 逻辑（src/services/skill.rs）：
解压 → 递归扫描含 SKILL.md 的目录 → 按 SKILL.md 的 name 安装到
~/.cc-switch/skills/ 并 symlink 到 ~/.claude/skills/ 等。它有 ZIP
条目数上限与解压体积预算——因此**绝不能**把开发目录整个打包
（.venv 上万文件会直接解压失败）。

本脚本只打运行交付物，布局为单个技能文件夹：

    disk-sense-manager-skill.zip
    └── disk-sense-manager/
        ├── SKILL.md
        ├── scripts/            # launcher.py / api_client.py
        ├── disk_sense/         # 核心引擎
        ├── config/
        ├── requirements.txt
        ├── README.md
        └── LICENSE

用法：python scripts/package_skill.py [输出路径]
默认输出 dist/disk-sense-manager-skill.zip
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKILL_NAME = "disk-sense-manager"  # 与 SKILL.md frontmatter 的 name 一致

# 交付物白名单（顶层）：目录整体收录，文件逐个收录
INCLUDE_DIRS = ["scripts", "disk_sense", "config"]
INCLUDE_FILES = [
    "SKILL.md",
    "requirements.txt",
    "README.md",
    "LICENSE",
]

# 目录内排除（防 __pycache__、运行时数据混入）
EXCLUDE_PARTS = {"__pycache__", ".pytest_cache", ".mypy_cache", "Data", ".venv"}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".tmp", ".lock"}
EXCLUDE_NAMES = {"desktop.ini", "Thumbs.db", ".DS_Store", "package_skill.py"}  # 本脚本为开发工具

# 固定时间戳，保证产物字节级可复现（同内容 → 同 zip）
_FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def _excluded(p: Path) -> bool:
    if any(part in EXCLUDE_PARTS for part in p.parts):
        return True
    if p.suffix.lower() in EXCLUDE_SUFFIXES:
        return True
    return p.name in EXCLUDE_NAMES


def collect_files() -> list[Path]:
    """收集交付物文件清单。"""
    files: list[Path] = []
    for name in INCLUDE_FILES:
        p = PROJECT_ROOT / name
        if not p.is_file():
            raise SystemExit(f"[error] 缺少交付文件: {p}")
        files.append(p)
    for d in INCLUDE_DIRS:
        base = PROJECT_ROOT / d
        if not base.is_dir():
            raise SystemExit(f"[error] 缺少交付目录: {base}")
        for p in sorted(base.rglob("*")):
            if p.is_file() and not _excluded(p):
                files.append(p)
    return files


def build_zip(out_path: Path) -> Path:
    """构建 ZIP，返回产物路径。"""
    files = collect_files()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in files:
            rel = p.relative_to(PROJECT_ROOT)
            arcname = f"{SKILL_NAME}/{rel.as_posix()}"
            info = zipfile.ZipInfo(arcname, date_time=_FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, p.read_bytes())

    # 自校验：zip 内必须恰好一个 SKILL.md，且位于技能文件夹根部
    with zipfile.ZipFile(out_path) as zf:
        names = zf.namelist()
        skill_mds = [n for n in names if n.endswith("SKILL.md")]
        assert skill_mds == [f"{SKILL_NAME}/SKILL.md"], f"SKILL.md 布局异常: {skill_mds}"
        assert f"{SKILL_NAME}/scripts/api_client.py" in names
        assert f"{SKILL_NAME}/config/config.yaml" in names

    size_kb = out_path.stat().st_size / 1024
    print(f"[ok] {out_path}  ({len(files)} 个文件, {size_kb:.0f} KB)")
    print(f"[ok] 布局: {SKILL_NAME}/SKILL.md （cc-switch install_from_zip 兼容）")
    return out_path


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT_ROOT / "dist" / "disk-sense-manager-skill.zip"
    build_zip(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
