"""端到端冒烟：扫描（伪实体）→ subtree → 异步删除 → query_job → rescan → recycle_bin。

使用 tmp 目录模拟纯数据盘，走真实 HTTP 服务（TestClient）。
"""
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, ".")

from fastapi.testclient import TestClient

from disk_sense.server import create_app


def main() -> int:
    disk = Path(tempfile.mkdtemp(prefix="ds_e2e_"))
    # 纯数据盘：无 Program Files/Users → 无已知实体 → 伪实体
    (disk / "datasets").mkdir()
    (disk / "datasets" / "model.bin").write_bytes(b"x" * 5000)
    (disk / "datasets" / "old").mkdir()
    (disk / "datasets" / "old" / "v1.bin").write_bytes(b"y" * 3000)
    (disk / ".pnpm-store").mkdir()
    (disk / ".pnpm-store" / "pkg.tgz").write_bytes(b"z" * 2000)

    app = create_app(data_dir=disk / "data", exit_hook=lambda: None)
    ok = True
    with TestClient(app) as c:
        # 1. 扫描 → 伪实体 + 缓存识别
        r = c.post("/scan", json={"drive": str(disk)})
        fp = r.json()["result"]
        assert fp.get("pseudo_entities") is True, "伪实体未生成"
        ids = {e["id"] for e in fp["entities"]}
        assert any("datasets" in i for i in ids), ids
        assert any("pnpm" in cd["cache_type"] for cd in fp["cache_dirs"]), "缓存未识别"
        print("[1] 扫描: 伪实体 + cache_dirs OK")

        # 2. subtree 下钻
        r = c.get("/subtree", params={"path": str(disk / "datasets"), "depth": 2})
        sub = r.json()["subtree"]
        assert sub["children"], "subtree 空"
        print(f"[2] subtree: {sub['name']} value={sub['value']} children={len(sub['children'])}")

        # 3. 异步删除 datasets/old
        victim = disk / "datasets" / "old"
        r = c.post("/operation", json={
            "op_type": "delete", "sources": [str(victim)], "async_mode": True,
        })
        assert r.status_code == 202
        job_id = r.json()["job_id"]

        # 4. query_job 轮询
        for _ in range(50):
            j = c.get("/job", params={"job_id": job_id}).json()
            if j["status"] in ("succeeded", "failed"):
                break
            time.sleep(0.1)
        assert j["status"] == "succeeded", j
        op_uuid = j["op_uuid"]
        print(f"[3] 异步删除: job={j['status']} op_uuid={op_uuid[:8]}...")

        # 5. stale + rescan
        r = c.get("/subtree", params={"path": str(disk / "datasets"), "depth": 1})
        assert r.json()["subtree"].get("stale") is True, "stale 未标记"
        r = c.post("/rescan", params={"path": str(disk / "datasets")})
        assert r.status_code == 200, r.text
        r = c.get("/subtree", params={"path": str(disk / "datasets"), "depth": 1})
        names = {ch["name"] for ch in r.json()["subtree"]["children"]}
        assert "old" not in names, names
        print("[4] rescan: stale 清除、old 已消失")

        # 6. 回收站闭环
        r = c.get("/recycle_bin_status")
        assert r.status_code == 200
        r = c.post("/recycle_bin/empty", json={"op_uuid": op_uuid})
        body = r.json()
        assert body["emptied"] >= 1, body
        print(f"[5] 回收站: emptied={body['emptied']} freed={body['freed_bytes']}B")

    print("\n端到端冒烟全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
