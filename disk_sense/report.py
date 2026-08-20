"""HTML 报告渲染（方案书 §9.1）。

``templates/template.html`` 内嵌全部前端资源（D3、样式、交互脚本），
仅保留 ``{{ TREEMAP_DATA }}`` 与 ``{{ D3_LIB }}`` 两个占位符：
渲染时以 ``json.dumps`` 填充聚合数据、以内联方式嵌入 vendor 中的 D3
源码，产物是**完全独立、可离线打开**的单文件 HTML（无 CDN 依赖）。

静态快照保存至 ``Data/reports/report_{timestamp}.html``。
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from .config import REPORTS_DIR, TEMPLATES_DIR

logger = logging.getLogger(__name__)

TEMPLATE_FILE = TEMPLATES_DIR / "template.html"
D3_VENDOR_FILE = TEMPLATES_DIR / "vendor" / "d3.min.js"

# 空扫描状态的占位数据（首屏仪表盘用）
EMPTY_DATA = {
    "session_id": "",
    "drive": "",
    "entities": [],
    "global_anomalies": [],
    "summary": {},
    "treemap": {"name": "DiskSense", "id": "root", "children": []},
    "signals_legend": {},
    "empty": True,
}


def _safe_json_for_html(data: dict) -> str:
    """序列化为可直接嵌入 <script> 的 JSON（转义 </ 防提前闭合标签）。"""
    return json.dumps(data, ensure_ascii=False).replace("</", "<\\/")


def render_dashboard_html(data: Optional[dict] = None) -> str:
    """渲染仪表盘 HTML；模板缺失时返回提示页（服务仍可用）。"""
    if not TEMPLATE_FILE.exists():
        return (
            "<!DOCTYPE html><html lang='zh'><head><meta charset='utf-8'>"
            "<title>DiskSense</title></head><body style='font-family:sans-serif;"
            "background:#111827;color:#e5e7eb;padding:2rem'>"
            "<h1>DiskSense 仪表盘</h1><p>模板文件缺失："
            f"{TEMPLATE_FILE}</p></body></html>"
        )
    template = TEMPLATE_FILE.read_text(encoding="utf-8")
    payload = _safe_json_for_html(data or EMPTY_DATA)

    d3_source = ""
    if D3_VENDOR_FILE.exists():
        d3_source = D3_VENDOR_FILE.read_text(encoding="utf-8")
    else:
        logger.warning("D3 vendor 缺失：%s（模板将回退到内置布局引擎）", D3_VENDOR_FILE)

    return template.replace("{{ TREEMAP_DATA }}", payload).replace("{{ D3_LIB }}", d3_source)


def save_report(data: dict, out_dir: Optional[Path] = None) -> Path:
    """保存静态 HTML 快照到 Data/reports/，返回文件路径。"""
    out = Path(out_dir) if out_dir else REPORTS_DIR
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"report_{datetime.now():%Y%m%d_%H%M%S}.html"
    path.write_text(render_dashboard_html(data), encoding="utf-8")
    logger.info("报告已保存: %s", path)
    return path
