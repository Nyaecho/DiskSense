"""server.py API 契约集成测试（TestClient + tmp 目录，不触碰真实系统盘）。"""

import json
import os
import time

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

        # 响应不含 report_path
        assert "report_path" not in body

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
        seq = r.json()["seq"]
        # /overlays 轮询能取回叠加层指令增量
        r = client.get("/overlays", params={"since_seq": 0})
        overlays = r.json()["overlays"]
        assert overlays and overlays[-1]["action"] == "highlight"
        assert overlays[-1]["seq"] == seq
        # 增量语义：since_seq=seq 之后无新指令
        r = client.get("/overlays", params={"since_seq": seq})
        assert r.json()["overlays"] == []
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


class TestMetadataQuery:
    """只读元数据端点：dir_stat / search_dirs / path_size（无需扫描会话）。"""

    def test_dir_stat_returns_timestamps(self, client, tree):
        r = client.get("/dir_stat", params={"path": str(tree / "Users" / "tom")})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["is_dir"] is True
        for key in ("mtime", "atime", "ctime"):
            assert isinstance(body[key], float)

    def test_dir_stat_not_found(self, client, tree):
        r = client.get("/dir_stat", params={"path": str(tree / "ghost")})
        assert r.status_code == 404

    def test_dir_stat_works_without_scan(self, client, tree):
        # 未扫描路径也可查（只读无范围校验）
        r = client.get("/dir_stat", params={"path": str(tree / "readme.txt")})
        assert r.status_code == 200
        assert r.json()["size"] > 0

    def test_search_dirs_matches_dirs_and_files(self, client, tree):
        r = client.get(
            "/search_dirs",
            params={"pattern": "*cache*", "root": str(tree)},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert any(d["path"].endswith("Cache") for d in body["dirs"])
        assert body["files"] == []  # 无匹配文件

    def test_search_dirs_matches_files(self, client, tree):
        r = client.get(
            "/search_dirs",
            params={"pattern": "*.exe", "root": str(tree)},
        )
        body = r.json()
        assert any(f["path"].endswith("chrome.exe") for f in body["files"])
        assert body["dirs"] == []

    def test_search_dirs_top_limit(self, client, tree):
        r = client.get(
            "/search_dirs",
            params={"pattern": "*", "root": str(tree), "top": 1},
        )
        body = r.json()
        assert len(body["files"]) <= 1
        assert body["total_files_matched"] >= 1

    def test_search_dirs_respects_ignore_patterns(self, client, tree):
        # 用户偏好忽略模式：命中目录不匹配也不下钻
        # （服务端启动时已加载偏好到内存，须通过同一对象修改）
        client.app.state.disk_sense.prefs.add_ignore_pattern("google")
        r = client.get(
            "/search_dirs",
            params={"pattern": "goo*", "root": str(tree)},
        )
        body = r.json()
        assert body["dirs"] == []  # Google 目录被忽略

    def test_search_dirs_root_not_found(self, client, tree):
        r = client.get(
            "/search_dirs",
            params={"pattern": "*", "root": str(tree / "ghost")},
        )
        assert r.status_code == 404

    def test_path_size_measures_tree(self, client, tree):
        r = client.get("/path_size", params={"path": str(tree / "Program Files")})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["files"] == 2  # chrome.exe/chrome.dll
        assert body["dirs"] == 1  # Google
        assert body["total_bytes"] == 32 + 1000  # MZ + 30 字节 + chrome.dll

    def test_path_size_single_file(self, client, tree):
        r = client.get("/path_size", params={"path": str(tree / "readme.txt")})
        body = r.json()
        assert body["files"] == 1
        assert body["dirs"] == 0
        assert body["total_bytes"] == len("说明".encode("utf-8"))

    def test_path_size_not_found(self, client, tree):
        r = client.get("/path_size", params={"path": str(tree / "ghost")})
        assert r.status_code == 404

    def test_pseudo_entities_flow(self, client, tmp_path):
        """纯数据盘扫描 → 伪实体生成且 /detail 可查询。"""
        data = tmp_path / "pure_data"
        (data / "datasets").mkdir(parents=True)
        (data / "datasets" / "a.bin").write_bytes(b"x" * 500)
        (data / "movies").mkdir()
        (data / "movies" / "m.mkv").write_bytes(b"y" * 200)

        body = _scan(client, data)
        fp = body["result"]
        assert fp.get("pseudo_entities") is True
        ids = {e["id"] for e in fp["entities"]}
        assert "pseudo:pure_data\\datasets" in ids and "pseudo:pure_data\\movies" in ids
        # /detail 对伪实体正常返回（不因 kind 拒绝）
        r = client.get("/detail", params={"entity_id": "pseudo:pure_data\\datasets"})
        assert r.status_code == 200

    def test_subtree_drilldown(self, client, tree):
        """subtree：下钻、深度上限、范围外 404。"""
        _scan(client, tree)
        # 下钻一层：Program Files
        r = client.get("/subtree", params={"path": str(tree / "Program Files"), "depth": 1})
        assert r.status_code == 200
        body = r.json()
        names = {c["name"] for c in body["subtree"]["children"]}
        assert "Google" in names

        # 多层下钻
        r = client.get("/subtree", params={"path": str(tree), "depth": 2})
        assert r.status_code == 200
        top = r.json()["subtree"]
        assert top["is_dir"] is True and top["children"]

        # depth 超上限 → 422（Query le=5）
        r = client.get("/subtree", params={"path": str(tree), "depth": 99})
        assert r.status_code == 422

        # 范围外路径 → 404
        r = client.get("/subtree", params={"path": "W:\\nope", "depth": 1})
        assert r.status_code == 404

        # 无会话 → 404（新 client）
        r2 = client.get("/subtree", params={"path": str(tree), "depth": 1})
        assert r2.status_code == 200  # 已有会话

    def test_async_operation_job_flow(self, client, tree):
        """异步删除：202+job_id → 轮询 succeeded；审计/撤销等价。"""
        import shutil as _sh

        _scan(client, tree)
        victim = tree / "Users" / "tom" / "AppData" / "Local" / "WeChat"
        r = client.post("/operation", json={
            "op_type": "delete",
            "sources": [str(victim)],
            "async_mode": True,
        })
        assert r.status_code == 202
        body = r.json()
        assert body["status"] == "accepted" and body["job_id"]

        # 轮询直到完成
        job_id = body["job_id"]
        for _ in range(50):
            jr = client.get("/job", params={"job_id": job_id})
            assert jr.status_code == 200
            j = jr.json()
            if j["status"] in ("succeeded", "failed"):
                break
            time.sleep(0.1)
        assert j["status"] == "succeeded", j
        assert j["result"]["status"] == "completed"
        assert j["op_uuid"]
        assert not victim.exists()

        # 审计可查（与同步等价）
        hist = client.get("/history", params={"limit": 10}).json()
        assert any(h["op_uuid"] == j["op_uuid"] for h in hist)

    def test_job_not_found(self, client):
        r = client.get("/job", params={"job_id": "job-nope"})
        assert r.status_code == 404

    def test_sync_operation_unchanged(self, client, tree):
        """同步模式行为不变（默认 async_mode=false）。"""
        _scan(client, tree)
        src = tree / "readme.txt"
        r = client.post("/operation", json={
            "op_type": "copy",
            "sources": [str(src)],
            "dest": str(tree / "Program Files"),
        })
        assert r.status_code == 200
        assert r.json()["status"] == "completed"
        assert (tree / "Program Files" / "readme.txt").exists()

    def test_stale_marked_after_delete_and_rescan(self, client, tree):
        """删除后扫描树标记 stale；rescan 后恢复且范围外不变。"""
        _scan(client, tree)
        victim = tree / "Users" / "tom" / "AppData" / "Local" / "WeChat"
        r = client.post("/operation", json={
            "op_type": "delete", "sources": [str(victim)],
        })
        assert r.status_code == 200

        # subtree 透传 stale
        r = client.get("/subtree", params={"path": str(victim.parent), "depth": 2})
        assert r.status_code == 200
        sub = r.json()["subtree"]
        assert sub.get("stale") is True

        # rescan 后 stale 清除、体积更新
        r = client.post("/rescan", params={"path": str(victim.parent)})
        assert r.status_code == 200
        r = client.get("/subtree", params={"path": str(victim.parent), "depth": 2})
        sub = r.json()["subtree"]
        assert "stale" not in sub
        names = {c["name"] for c in sub.get("children", [])}
        assert "WeChat" not in names  # 已删除

    def test_rescan_out_of_scope(self, client, tree):
        _scan(client, tree)
        r = client.post("/rescan", params={"path": "W:\\nope"})
        assert r.status_code == 404

    def test_recycle_bin_status(self, client):
        r = client.get("/recycle_bin_status")
        assert r.status_code == 200
        body = r.json()
        assert "entries" in body and "total_bytes" in body and "per_drive" in body

    def test_recycle_bin_empty_requires_op_uuid(self, client):
        r = client.post("/recycle_bin/empty", json={"op_uuid": ""})
        assert r.status_code == 400

    def test_recycle_bin_empty_unknown_op(self, client):
        r = client.post("/recycle_bin/empty", json={"op_uuid": "no-such-op"})
        assert r.status_code == 404

    def test_recycle_bin_empty_after_delete(self, client, tree):
        """删除 → 受控清空该 op 的条目 → 释放字节数返回。"""
        _scan(client, tree)
        victim = tree / "Users" / "tom" / "AppData" / "Local" / "WeChat"
        r = client.post("/operation", json={
            "op_type": "delete", "sources": [str(victim)],
        })
        op_uuid = r.json()["op_uuid"]

        r = client.post("/recycle_bin/empty", json={"op_uuid": op_uuid})
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "completed"
        assert body["emptied"] >= 1  # 至少清掉一个条目
        assert "不可再撤销" in body["warning"]


class TestLegacyRoutesAbsent:
    """旧路由（/、/poll）不存在。"""

    def test_root_returns_404(self, client):
        r = client.get("/")
        assert r.status_code == 404

    def test_poll_removed(self, client):
        assert client.get("/poll", params={"since": 0}).status_code == 404

    def test_shutdown_endpoint(self, client):
        r = client.get("/shutdown")
        assert r.status_code == 200
        assert r.json()["status"] == "shutting_down"


class TestFieldReportFixes:
    """回合自 OpenCode 侧真实使用报告的三个 bug（多会话取错/盘符正则无组/裸盘符）。"""

    def test_detail_serves_latest_completed_session(self, client, tree, tmp_path):
        """/detail 必须服务「最新」完成会话，而非字典序首个。"""
        _scan(client, tree)  # 第一次：google/wechat

        b = tmp_path / "b"
        (b / "Program Files" / "Steam").mkdir(parents=True)
        (b / "Program Files" / "Steam" / "steam.exe").write_bytes(b"MZ" + b"\x00" * 30)
        body_b = _scan(client, b)  # 第二次：仅 steam

        # 确保时间戳严格递增（防 Windows 时钟粒度导致的并列）
        st = client.app.state.disk_sense
        st.sessions[body_b["session_id"]].started_at += 1.0

        r = client.get("/detail", params={"entity_id": "steam", "category": "program_base"})
        assert r.status_code == 200  # 修复前：旧会话挡路 → 404
        r = client.get("/detail", params={"entity_id": "google", "category": "program_base"})
        assert r.status_code == 404  # 旧会话实体不再由 /detail 服务

    def test_bare_drive_session_scope(self, client, tmp_path):
        """盘符形式会话的 roots 键为 "C:"；/operation 不再 500（正则缺组）且放行同盘文件。"""
        import os

        from disk_sense.aggregator import Aggregator
        from disk_sense.server import ScanSession

        f = tmp_path / "ok.txt"
        f.write_text("x")
        dest = tmp_path / "d"
        dest.mkdir()
        drive = os.path.splitdrive(str(f))[0]  # tmp 所在盘（本机为 C:）

        st = client.app.state.disk_sense
        s = ScanSession(session_id="manual-drive", target=drive)
        s.status = "completed"
        s.aggregator = Aggregator()
        st.sessions["manual-drive"] = s
        s2 = ScanSession(session_id="manual-drive-slash", target=drive + "/")
        s2.status = "completed"
        s2.aggregator = Aggregator()
        s2.started_at = s.started_at - 1
        st.sessions["manual-drive-slash"] = s2

        assert st.scanned_roots() == {drive}  # "C:" 与 "C:/" 归一为同一键

        # 修复前：scanned_roots 的 m.group(1) 抛 IndexError → 500
        r = client.post(
            "/operation", json={"op_type": "copy", "sources": [str(f)], "dest": str(dest)}
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "completed"

        # 未扫描盘符仍被范围防线拒绝
        r = client.post(
            "/operation", json={"op_type": "copy", "sources": ["Q:/x.txt"], "dest": str(dest)}
        )
        assert r.status_code == 400
        assert "未经扫描" in r.json()["detail"]
