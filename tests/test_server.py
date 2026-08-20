"""server.py API 契约集成测试（TestClient + tmp 目录，不触碰真实系统盘）。"""

import json
import os

import pytest
from fastapi.testclient import TestClient

from disk_sense.server import create_app


@pytest.fixture
def tree(tmp_path):
    """构造一个可扫描的迷你『盘』：Program Files/Google + AppData + 散文件。"""
    google = tmp_path / "Program Files" / "Google"
    google.mkdir(parents=True)
    (google / "chrome.exe").write_bytes(b"MZ" + b"\x00" * 30)
    (google / "chrome.dll").write_bytes(b"x" * 1000)
    wechat_cache = tmp_path / "Users" / "tom" / "AppData" / "Local" / "WeChat" / "Cache"
    wechat_cache.mkdir(parents=True)
    (wechat_cache / "msg.db").write_bytes(b"c" * 3000)
    (tmp_path / "readme.txt").write_text("说明", encoding="utf-8")
    return tmp_path


@pytest.fixture
def client(tmp_path):
    app = create_app(data_dir=tmp_path / "data", exit_hook=lambda: None)
    with TestClient(app) as c:
        yield c


def _scan(client, target) -> dict:
    r = client.post("/scan", json={"drive": str(target)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "completed", body
    return body


class TestCoreEndpoints:
    def test_health(self, client):
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "alive"
        assert body["scanning"] is False

    def test_scan_invalid_target(self, client, tmp_path):
        r = client.post("/scan", json={"drive": str(tmp_path / "ghost")})
        assert r.status_code == 400

    def test_scan_result_detail_flow(self, client, tree):
        body = _scan(client, tree)
        sid = body["session_id"]
        fp = body["result"]

        assert fp["drive"] == tree.name
        ids = {e["id"] for e in fp["entities"]}
        assert "google" in ids and "wechat" in ids

        # /result
        r = client.get("/result", params={"session_id": sid})
        assert r.status_code == 200 and r.json()["status"] == "completed"
        r = client.get("/result", params={"session_id": "nope"})
        assert r.status_code == 404

        # /detail
        r = client.get("/detail", params={"entity_id": "wechat", "category": "cache"})
        assert r.status_code == 200
        top = r.json()
        assert top and top[0]["name"] == "msg.db"
        r = client.get("/detail", params={"entity_id": "ghost", "category": "cache"})
        assert r.status_code == 404
        r = client.get("/detail", params={"entity_id": "wechat", "category": "bogus"})
        assert r.status_code == 400

        # 报告文件落盘
        assert os.path.exists(body["report_path"])

    def test_classify(self, client, tree):
        f = tree / "pic.png"
        f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"p" * 20)
        r = client.post("/classify", json={"path": str(f)})
        assert r.status_code == 200
        assert r.json()["magic_type"] == "PNG 图片"
        r = client.post("/classify", json={"path": str(tree / "nope")})
        assert r.status_code == 404

    def test_viz(self, client):
        r = client.post(
            "/viz",
            json={"action": "highlight", "target": {"id": "wechat"},
                  "payload": {"color": "#FF4500", "label": "卸载残留"}},
        )
        assert r.status_code == 200 and r.json()["status"] == "ok"
        # /poll 降级通道能取到叠加层指令
        r = client.get("/poll", params={"since": 0})
        overlays = r.json()["overlays"]
        assert overlays and overlays[-1]["action"] == "highlight"
        # 无效动作
        r = client.post("/viz", json={"action": "explode", "target": {}, "payload": {}})
        assert r.status_code == 400


class TestOperations:
    def test_move_history_undo_roundtrip(self, client, tree):
        _scan(client, tree)
        src = tree / "readme.txt"
        dest_dir = tree / "Users" / "tom" / "AppData" / "Local"
        r = client.post(
            "/operation",
            json={"op_type": "move", "sources": [str(src)], "dest": str(dest_dir)},
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "completed"
        assert not src.exists()

        r = client.get("/history", params={"limit": 5})
        rows = r.json()
        assert rows and rows[0]["op_type"] == "MOVE" and rows[0]["status"] == "DONE"

        r = client.post("/undo", json={"op_id": rows[0]["id"]})
        out = r.json()
        assert out["status"] == "success", out
        assert src.read_text(encoding="utf-8") == "说明"

    def test_protect_blocks_operation(self, client, tree):
        _scan(client, tree)
        client.post("/protect", json={"path": str(tree / "Program Files"), "add": True})
        r = client.post(
            "/operation",
            json={"op_type": "move",
                  "sources": [str(tree / "Program Files" / "Google" / "chrome.dll")],
                  "dest": str(tree)},
        )
        assert r.status_code == 403
        assert (tree / "Program Files" / "Google" / "chrome.dll").exists()

    def test_scope_check_rejects_unscanned_drive(self, client, tree):
        _scan(client, tree)  # 只扫描了 tmp 目录
        r = client.post(
            "/operation",
            json={"op_type": "copy", "sources": ["C:\\Windows\\notepad.exe"], "dest": str(tree)},
        )
        assert r.status_code == 400
        assert "未经扫描" in r.json()["detail"]

    def test_invalid_op_type(self, client, tree):
        r = client.post(
            "/operation", json={"op_type": "shred", "sources": [str(tree / "readme.txt")]}
        )
        assert r.status_code == 400

    def test_tag_endpoint(self, client, tree):
        r = client.post("/tag", json={"path": str(tree / "Users" / "tom"), "tag": "个人数据"})
        assert r.json()["status"] == "tagged"


class TestDashboardAndWs:
    def test_dashboard_html(self, client, tree):
        _scan(client, tree)
        r = client.get("/")
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]

    def test_ws_ping_snapshot_and_operation(self, client, tree):
        _scan(client, tree)
        with client.websocket_connect("/ws") as ws:
            # 已有会话 → 首条是 snapshot
            snapshot = ws.receive_json()
            assert snapshot["type"] == "snapshot"
            assert snapshot["status"] == "completed"

            ws.send_json({"type": "ping"})
            assert ws.receive_json()["type"] == "pong"

            # 右键菜单走 WS 执行 copy 操作
            src = tree / "readme.txt"
            ws.send_json({
                "type": "operation",
                "op_type": "copy",
                "sources": [str(src)],
                "dest": str(tree / "Users" / "tom" / "AppData" / "Local"),
            })
            result = ws.receive_json()
            assert result["type"] == "operation_result"
            assert result["status"] == "completed"
            assert (tree / "Users" / "tom" / "AppData" / "Local" / "readme.txt").exists()

    def test_shutdown_endpoint(self, client):
        r = client.get("/shutdown")
        assert r.status_code == 200
        assert r.json()["status"] == "shutting_down"
