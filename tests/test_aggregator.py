"""aggregator.py 指纹聚合测试：内存构造 Node 树 + 少量真实临时文件（魔数）。"""

import time

import pytest

from disk_sense import aggregator as agg
from disk_sense.aggregator import Aggregator
from disk_sense.config import ReportConfig, RULES_FILE
from disk_sense.models import Node, ScanResult, finalize_tree
from disk_sense.rules_engine import RulesEngine

NOW = time.time()


def f(name, mb, mtime_days_ago=10, atime_days_ago=10):
    return Node(name, int(mb * agg.MB), NOW - mtime_days_ago * 86400, NOW - atime_days_ago * 86400)


def build_tree():
    """模拟典型 C 盘（镜像方案书 §7.3 微信场景）。"""
    root = Node("C:", is_dir=True, children={})

    pf = Node("Program Files", is_dir=True, children={})
    google = Node("Google", is_dir=True, children={})
    google.add_child(f("chrome.exe", 120, 5, 5))
    google.add_child(f("chrome.dll", 60, 5, 5))
    adobe = Node("Adobe", is_dir=True, children={})
    adobe.add_child(f("photoshop.exe", 800, 300, 300))
    pf.add_child(google)
    pf.add_child(adobe)
    root.add_child(pf)

    users = Node("Users", is_dir=True, children={})
    tom = Node("tom", is_dir=True, children={})
    appdata = Node("AppData", is_dir=True, children={})
    local = Node("Local", is_dir=True, children={})
    wechat_local = Node("WeChat", is_dir=True, children={})
    cache_dir = Node("Cache", is_dir=True, children={})
    cache_dir.add_child(f("msg_1.dat", 1500, 45, 45))
    cache_dir.add_child(f("msg_2.dat", 1500, 45, 45))
    wechat_local.add_child(cache_dir)
    temp = Node("Temp", is_dir=True, children={})
    temp.add_child(f("junk1.tmp", 150, 20, 20))
    temp.add_child(f("junk2.tmp", 150, 20, 20))
    local.add_child(wechat_local)
    local.add_child(temp)
    roaming = Node("Roaming", is_dir=True, children={})
    wechat_roam = Node("WeChat", is_dir=True, children={})
    wechat_roam.add_child(f("user_db.dat", 1800, 45, 45))
    roaming.add_child(wechat_roam)
    appdata.add_child(local)
    appdata.add_child(roaming)
    tom.add_child(appdata)
    users.add_child(tom)
    root.add_child(users)

    # 关联异常：标准目录之外的 Adobe 散落
    adobe_temp = Node("AdobeTemp", is_dir=True, children={})
    adobe_temp.add_child(f("ps_cache.dat", 500, 300, 300))
    root.add_child(adobe_temp)

    # Windows\Temp → 系统临时伪实体
    win = Node("Windows", is_dir=True, children={})
    wtemp = Node("Temp", is_dir=True, children={})
    wtemp.add_child(f("wtmp.log", 200, 30, 30))
    win.add_child(wtemp)
    root.add_child(win)

    return root


def make_result(root):
    files, dirs, total = finalize_tree(root)
    return ScanResult(root=root, mode="walk", files=files, dirs=dirs, total_bytes=total, elapsed_sec=1.0)


@pytest.fixture
def fingerprint(tmp_path):
    root = build_tree()
    # 真实大文件触发 global_anomalies（内容是 ISO 魔数，验证批量魔数识别）
    iso = tmp_path / "backup.iso"
    with open(iso, "wb") as fh:
        fh.write(b"\x00" * 16)
        fh.seek(0x8001)
        fh.write(b"CD001")
    root.add_child(f("backup.iso", iso.stat().st_size / agg.MB, 100, 100))
    root.children["backup.iso"].size = iso.stat().st_size

    cfg = ReportConfig(anomaly_min_mb=0, anomaly_root_min_mb=0)

    def fake_classifier(path):
        # 合成树的路径不存在于真实文件系统，注入分类器验证批量魔数装配逻辑
        if path.endswith("backup.iso"):
            return {"magic_type": "ISO 9660 光盘镜像", "mime": "x", "confidence": "high"}
        return {"magic_type": "UNKNOWN", "mime": "", "confidence": "low"}

    a = Aggregator(
        cfg=cfg, rules=RulesEngine.from_yaml(RULES_FILE), now=NOW, magic_classifier=fake_classifier
    )
    return a, a.aggregate(make_result(root), "scan-test")


class TestClassifyPath:
    def test_program_base(self):
        a = Aggregator()
        seed, role, anomaly, _ = a._classify_path(
            ["c:", "program files", "google", "chrome", "chrome.exe"]
        )
        assert (seed, role, anomaly) == ("google", "program_base", False)

    def test_appdata_cache_marker(self):
        a = Aggregator()
        seed, role, _, _ = a._classify_path(
            ["c:", "users", "tom", "appdata", "local", "wechat", "cache", "a.dat"]
        )
        assert (seed, role) == ("wechat", "cache")

    def test_appdata_user_data(self):
        a = Aggregator()
        seed, role, _, _ = a._classify_path(
            ["c:", "users", "tom", "appdata", "roaming", "wechat", "db.dat"]
        )
        assert (seed, role) == ("wechat", "user_data")

    def test_local_temp_is_system_temp(self):
        a = Aggregator()
        seed, role, _, _ = a._classify_path(
            ["c:", "users", "tom", "appdata", "local", "temp", "a.tmp"]
        )
        assert (seed, role) == ("system-temp", "cache")

    def test_windows_temp_is_system_temp(self):
        a = Aggregator()
        seed, role, _, _ = a._classify_path(["c:", "windows", "temp", "a.log"])
        assert (seed, role) == ("system-temp", "cache")

    def test_logs_marker(self):
        a = Aggregator()
        _, role, _, _ = a._classify_path(
            ["c:", "users", "t", "appdata", "local", "app", "logs", "a.log"]
        )
        assert role == "logs"

    def test_association_anomaly(self):
        a = Aggregator()
        a.seeds = {"adobe": "Adobe"}
        seed, role, anomaly, _ = a._classify_path(["c:", "adobetemp", "x.dat"])
        assert (seed, anomaly) == ("adobe", True)

    def test_association_exact_segment(self):
        a = Aggregator()
        a.seeds = {"adobe": "Adobe"}
        seed, _, anomaly, _ = a._classify_path(["d:", "tools", "adobe", "x.dat"])
        assert (seed, anomaly) == ("adobe", True)

    def test_root_loose_file_no_entity(self):
        a = Aggregator()
        assert a._classify_path(["c:", "backup.iso"])[0] is None

    def test_loose_file_under_base_root_no_entity(self):
        a = Aggregator()
        assert a._classify_path(["c:", "program files", "stray.dll"], is_dir=False)[0] is None

    def test_programdata_base(self):
        a = Aggregator()
        seed, role, _, _ = a._classify_path(["c:", "programdata", "npm", "a.js"])
        assert (seed, role) == ("npm", "user_data")


class TestAggregate:
    def test_entities_present(self, fingerprint):
        _, fp = fingerprint
        ids = {e["id"] for e in fp["entities"]}
        assert {"google", "adobe", "wechat", "system-temp"} <= ids
        assert fp["summary"]["entities_count"] == len(fp["entities"])

    def test_wechat_locations(self, fingerprint):
        _, fp = fingerprint
        wechat = next(e for e in fp["entities"] if e["id"] == "wechat")
        assert wechat["locations"]["cache"]["size_mb"] == pytest.approx(3000, abs=1)
        assert wechat["locations"]["user_data"]["size_mb"] == pytest.approx(1800, abs=1)
        assert wechat["total_size_mb"] == pytest.approx(4800, abs=1)
        assert wechat["last_access_days"] == 45
        assert "CACHE_DOMINANT" in wechat["signals"]  # 3000 > (0+1800)*1.5=2700

    def test_google_has_exe(self, fingerprint):
        _, fp = fingerprint
        google = next(e for e in fp["entities"] if e["id"] == "google")
        assert google["locations"]["program_base"]["has_exe"] is True
        assert google["last_access_days"] == 5
        assert google["signals"] == []

    def test_adobe_ancient_and_anomaly(self, fingerprint):
        _, fp = fingerprint
        adobe = next(e for e in fp["entities"] if e["id"] == "adobe")
        # photoshop.exe 800MB 300 天未访问 + AdobeTemp 500MB 异常位置
        assert adobe["location_anomaly"] is True
        assert "ANCIENT_DATA" in adobe["signals"]  # >180 天且 >1000MB
        assert adobe["locations"]["user_data"]["size_mb"] == pytest.approx(500, abs=1)

    def test_system_temp(self, fingerprint):
        _, fp = fingerprint
        st = next(e for e in fp["entities"] if e["id"] == "system-temp")
        assert st["locations"]["cache"]["size_mb"] == pytest.approx(500, abs=1)
        assert st["display"] == "系统临时文件"

    def test_global_anomalies_with_magic(self, fingerprint):
        _, fp = fingerprint
        assert len(fp["global_anomalies"]) >= 1
        iso = next(a for a in fp["global_anomalies"] if a["path_preview"].endswith("backup.iso"))
        assert iso["magic_type"] == "ISO 9660 光盘镜像"

    def test_summary_shape(self, fingerprint):
        _, fp = fingerprint
        s = fp["summary"]
        for key in ("total_scanned_mb", "files", "dirs", "skipped_dirs_count", "scan_time_sec"):
            assert key in s
        assert fp["session_id"] == "scan-test"
        assert fp["drive"] == "C:"

    def test_treemap_structure(self, fingerprint):
        _, fp = fingerprint
        tm = fp["treemap"]
        assert tm["name"] == "C:"
        by_id = {c["id"]: c for c in tm["children"]}
        assert "wechat" in by_id
        wechat_node = by_id["wechat"]
        role_ids = {c["id"] for c in wechat_node["children"]}
        assert "wechat:cache" in role_ids and "wechat:user_data" in role_ids
        assert "dir:windows" in by_id  # 非覆盖根目录进入 treemap

    def test_top_files_kept_outside_json(self, fingerprint):
        a, fp = fingerprint
        top = a.entity_top_files["wechat"]["cache"]
        names = {t["name"] for t in top}
        assert names == {"msg_1.dat", "msg_2.dat"}
        # JSON 实体内不应包含 top 文件列表（Token 优化）
        wechat = next(e for e in fp["entities"] if e["id"] == "wechat")
        assert "top_files" not in wechat

    def test_entity_cap(self):
        root = Node("C:", is_dir=True, children={})
        pf = Node("Program Files", is_dir=True, children={})
        for i in range(12):
            appdir = Node(f"App{i:02d}", is_dir=True, children={})
            appdir.add_child(f(f"x{i}.dll", 100))
            pf.add_child(appdir)
        root.add_child(pf)
        cfg = ReportConfig(max_entities=5, anomaly_min_mb=10_000)
        a = Aggregator(cfg=cfg, rules=RulesEngine(), now=NOW)
        fp = a.aggregate(make_result(root), "s")
        assert len(fp["entities"]) == 5
        assert fp["summary"]["entities_truncated"] == 7

    def test_tags_prefix_match(self):
        root = build_tree()
        cfg = ReportConfig(anomaly_min_mb=10_000)
        a = Aggregator(
            cfg=cfg,
            rules=RulesEngine(),
            now=NOW,
            tags_by_prefix={"c:\\program files\\google": "浏览器"},
        )
        fp = a.aggregate(make_result(root), "s")
        google = next(e for e in fp["entities"] if e["id"] == "google")
        assert google["tags"] == ["浏览器"]

    def test_token_budget(self, fingerprint):
        """方案书 §7.1：指纹 JSON 应控制在 ~5000 Token（约 20KB 文本）内。"""
        import json

        _, fp = fingerprint
        text = json.dumps(fp, ensure_ascii=False)
        assert len(text) < 20_000
