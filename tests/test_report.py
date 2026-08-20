"""report.py 模板渲染与离线报告测试。"""

import json

import pytest

from disk_sense import report


SAMPLE = {
    "session_id": "scan-test",
    "drive": "C:",
    "entities": [
        {"id": "wechat", "display": "WeChat", "total_size_mb": 4800,
         "locations": {}, "signals": ["CACHE_DOMINANT"], "last_access_days": 45,
         "top_extensions": [], "location_anomaly": False, "tags": []}
    ],
    "global_anomalies": [],
    "summary": {"total_scanned_mb": 256000, "files": 300000, "dirs": 40000,
                "skipped_dirs_count": 0, "skipped_paths": [], "scan_time_sec": 12.3,
                "scan_mode": "mft", "entities_count": 1, "entities_truncated": 0},
    "treemap": {"name": "C:", "id": "root",
                "children": [{"name": "WeChat", "id": "wechat", "value": 5e9}]},
    "signals_legend": {},
}


def test_render_contains_placeholders_filled():
    html = report.render_dashboard_html(SAMPLE)
    assert "DISKSENSE_DATA" in html
    assert "{{ TREEMAP_DATA }}" not in html
    assert "{{ D3_LIB }}" not in html
    # 指纹数据已注入
    assert "scan-test" in html and "CACHE_DOMINANT" in html


def test_render_inlines_d3_vendor():
    """内嵌 D3：离线打开无 CDN 依赖（方案书 §9.1）。"""
    html = report.render_dashboard_html(SAMPLE)
    assert len(html) > 200_000          # d3.min.js ~280KB 内联
    assert "https://d3js.org" in html   # D3 官方版本头注释


def test_render_escapes_script_breakout():
    evil = dict(SAMPLE)
    evil["treemap"] = {"name": "</script><b>恶意", "id": "root", "children": []}
    html = report.render_dashboard_html(evil)
    assert "</script><b>" not in html          # 原样出现即注入成功
    assert "<\\/script>" in html               # 已转义


def test_render_empty_data():
    html = report.render_dashboard_html(None)
    assert "DiskSense" in html


def test_render_missing_template_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(report, "TEMPLATE_FILE", tmp_path / "nope.html")
    html = report.render_dashboard_html(SAMPLE)
    assert "模板文件缺失" in html


def test_save_report(tmp_path):
    path = report.save_report(SAMPLE, tmp_path)
    assert path.exists() and path.suffix == ".html"
    assert "report_" in path.name
    content = path.read_text(encoding="utf-8")
    assert "scan-test" in content
