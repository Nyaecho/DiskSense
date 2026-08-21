"""file_operator.py 测试：$I 解析/快照比对/五步回滚（纯逻辑）+ 回收站真实往返（win32）。"""

import os
import struct
import sys
import uuid

import pytest

from disk_sense import file_operator as fo
from disk_sense.file_operator import (
    FileOperator,
    FileOperatorError,
    ProtectedPathError,
    execute_undo,
)
from disk_sense.undo_manager import UndoManager


def make_i_bytes(original_path: str, size: int = 123, deleted_ft: int = 132000000000000000) -> bytes:
    p = original_path.encode("utf-16-le") + b"\x00\x00"
    return struct.pack("<QQQ", 2, size, deleted_ft) + p


# ---------------------------------------------------------------------------
# $I 解析与快照比对（跨平台纯逻辑）
# ---------------------------------------------------------------------------
class TestRecycleParsing:
    def test_parse_i_file(self):
        info = fo.parse_i_file(make_i_bytes("C:\\Users\\tom\\报告.docx", size=456))
        assert info is not None
        assert info["size"] == 456
        assert info["deleted_at_ft"] == 132000000000000000
        assert info["original_path"] == "C:\\Users\\tom\\报告.docx"

    def test_parse_i_file_bad_version(self):
        assert fo.parse_i_file(b"\x00" * 24) is None
        assert fo.parse_i_file(struct.pack("<Q", 9) + b"\x00" * 40) is None

    def test_snapshot_and_diff(self, tmp_path):
        # 伪造 $Recycle.Bin 结构（纯文件，无需 Shell）
        sid = tmp_path / "$Recycle.Bin" / "S-1-5-21-x"
        sid.mkdir(parents=True)
        before = fo._snapshot_recycle_i(str(tmp_path))
        assert before == {}

        (sid / "$IAAAA11").write_bytes(make_i_bytes("C:\\gone.bin", size=77))
        new = fo._diff_new_i(str(tmp_path), before)
        assert len(new) == 1
        assert new[0]["original_path"].endswith("gone.bin")
        assert new[0]["r_path"].endswith("$RAAAA11")

    def test_snapshot_tolerates_locked_sid(self, tmp_path):
        rb = tmp_path / "$Recycle.Bin"
        (rb / "S-locked").mkdir(parents=True)
        (rb / "S-ok").mkdir()
        (rb / "S-ok" / "$IBBBB22").write_bytes(make_i_bytes("C:\\x"))
        # 无法读的 SID 目录不会中断快照（模拟：Windows 下权限拒绝不可注入，
        # 至少验证正常路径全部收集；键为小写路径）
        snap = fo._snapshot_recycle_i(str(tmp_path))
        assert any(k.endswith("$ibbbb22") for k in snap)
        assert snap[[k for k in snap if k.endswith("$ibbbb22")][0]].endswith("$IBBBB22")


# ---------------------------------------------------------------------------
# 五步回滚（fabricated 回收站 + MOVE/COPY 语义，跨平台）
# ---------------------------------------------------------------------------
class TestExecuteUndo:
    def _setup(self, tmp_path):
        undo = UndoManager(tmp_path / "op_log.db")
        return undo, FileOperator(undo, session_id="test")

    def test_move_undo_restores(self, tmp_path):
        undo, op = self._setup(tmp_path)
        src = tmp_path / "a.txt"
        src.write_text("x" * 10)
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()
        result = op.move([str(src)], str(dest_dir))
        assert result["status"] == "completed"
        assert not src.exists() and (dest_dir / "a.txt").exists()

        r = execute_undo(1, undo)
        assert r["status"] == "success"
        assert src.read_text() == "x" * 10
        assert not (dest_dir / "a.txt").exists()
        # 步骤 1：再次撤销 → skipped
        r2 = execute_undo(1, undo)
        assert r2["skipped"] and r2["status"] == "success"

    def test_move_undo_conflict_rename(self, tmp_path):
        undo, op = self._setup(tmp_path)
        src = tmp_path / "dup.txt"
        src.write_text("original")
        dest_dir = tmp_path / "d2"
        dest_dir.mkdir()
        op.move([str(src)], str(dest_dir))
        src.write_text("new occupant")  # 原位置出现同名新文件
        r = execute_undo(1, undo)
        assert r["status"] == "success"
        restored = r["restored"][0]["restored_to"]
        assert restored.endswith("dup_restored_1.txt")
        assert "original" in open(restored, encoding="utf-8").read()

    def test_delete_undo_with_fabricated_recycle(self, tmp_path):
        undo, _ = self._setup(tmp_path)
        src_dir = tmp_path / "docs"
        src_dir.mkdir()
        src = src_dir / "precious.dat"
        src.write_bytes(b"v" * 32)

        # 手工构造回收站物理文件 + 日志（模拟 delete() 完成后的状态）
        rbin = tmp_path / "$Recycle.Bin" / "S-1"
        rbin.mkdir(parents=True)
        (rbin / "$RZZZ99").write_bytes(b"v" * 32)
        (rbin / "$IZZZ99").write_bytes(make_i_bytes(str(src)))
        (i,) = undo.log_batch(
            "u-del", "DELETE",
            [{"source_path": str(src), "file_size": 32}],
        )
        undo.update_entry(
            i, status="DONE", recycle_bin_name="$RZZZ99", recycle_info_name="$IZZZ99",
            recycle_path=str(rbin / "$RZZZ99"),
        )
        src.unlink()  # 模拟已删除

        r = execute_undo(i, undo)
        assert r["status"] == "success"
        assert src.read_bytes() == b"v" * 32
        assert not (rbin / "$RZZZ99").exists()
        assert not (rbin / "$IZZZ99").exists()

    def test_delete_undo_missing_recycle_fails_gracefully(self, tmp_path):
        undo, _ = self._setup(tmp_path)
        src_dir = tmp_path / "docs2"
        src_dir.mkdir()
        (i,) = undo.log_batch("u-del2", "DELETE", [{"source_path": str(src_dir / "f.bin")}])
        undo.update_entry(i, status="DONE")  # 无映射且回收站空
        r = execute_undo(i, undo)
        assert r["status"] == "failed"
        assert "回收站" in r["failed"][0]["error"]

    def test_parent_dir_gone_fails_with_clear_error(self, tmp_path):
        undo, _ = self._setup(tmp_path)
        (i,) = undo.log_batch("u3", "DELETE", [{"source_path": str(tmp_path / "nope" / "f.bin")}])
        undo.update_entry(i, status="DONE")
        r = execute_undo(i, undo)
        assert r["status"] == "failed"
        assert "父目录" in r["failed"][0]["error"]

    def test_unknown_op_id(self, tmp_path):
        undo, _ = self._setup(tmp_path)
        assert execute_undo(404, undo)["status"] == "failed"

    def test_batch_undo_partial(self, tmp_path):
        """批量原子性：整批逐条回滚，单条失败不阻断。"""
        undo, op = self._setup(tmp_path)
        f1, f2 = tmp_path / "1.txt", tmp_path / "2.txt"
        f1.write_text("a")
        f2.write_text("b")
        dest = tmp_path / "d3"
        dest.mkdir()
        r = op.move([str(f1), str(f2)], str(dest))
        assert r["status"] == "completed"
        (dest / "2.txt").unlink()  # 人为破坏一条
        out = execute_undo(1, undo)
        assert out["status"] == "partial"
        assert f1.exists() and not f2.exists()
        assert len(out["restored"]) == 1 and len(out["failed"]) == 1


# ---------------------------------------------------------------------------
# 保护路径 / move / copy / compress（跨平台）
# ---------------------------------------------------------------------------
class TestFileOperator:
    def _op(self, tmp_path, protected=None):
        undo = UndoManager(tmp_path / "op_log.db")
        return undo, FileOperator(undo, protected_check=protected)

    def test_protection_blocks(self, tmp_path):
        protected_root = str(tmp_path).lower()
        undo, op = self._op(tmp_path, protected=lambda p: p.lower().startswith(protected_root))
        (tmp_path / "f.txt").write_text("x")
        with pytest.raises(ProtectedPathError):
            op.delete([str(tmp_path / "f.txt")])
        assert (tmp_path / "f.txt").exists()  # 未被删除
        assert undo.list_ops(10) == []  # 未落任何日志

    def test_missing_source_raises(self, tmp_path):
        undo, op = self._op(tmp_path)
        with pytest.raises(FileOperatorError):
            op.delete([str(tmp_path / "ghost")])

    def test_move_copy_roundtrip(self, tmp_path):
        undo, op = self._op(tmp_path)
        src = tmp_path / "m.txt"
        src.write_text("hello")
        d1, d2 = tmp_path / "d1", tmp_path / "d2"
        d1.mkdir(); d2.mkdir()
        op.move([str(src)], str(d1))
        assert (d1 / "m.txt").read_text() == "hello"
        op.copy([str(d1 / "m.txt")], str(d2))
        assert (d2 / "m.txt").read_text() == "hello"
        rows = undo.list_ops(10)
        assert [r["op_type"] for r in rows] == ["COPY", "MOVE"]
        assert all(r["status"] == "DONE" for r in rows)

    def test_compress_creates_zip_and_logs(self, tmp_path):
        undo, op = self._op(tmp_path)
        f = tmp_path / "data.bin"
        f.write_bytes(b"z" * 2048)
        r = op.compress([str(f)], str(tmp_path))
        assert r["status"] == "completed"
        zips = list(tmp_path.glob("data*.zip"))
        assert len(zips) == 1
        import zipfile

        with zipfile.ZipFile(zips[0]) as zf:
            assert zf.namelist() == ["data.bin"]
        row = undo.list_ops(1)[0]
        assert row["op_type"] == "COMPRESS" and row["status"] == "DONE"

    def test_compress_name_collision(self, tmp_path):
        undo, op = self._op(tmp_path)
        f = tmp_path / "dup.bin"
        f.write_bytes(b"q" * 10)
        (tmp_path / "dup.zip").write_bytes(b"occupied")
        r = op.compress([str(f)], str(tmp_path))
        assert r["results"][0]["dest"].endswith("dup_1.zip")


# ---------------------------------------------------------------------------
# 真实回收站往返（仅 Windows）
# ---------------------------------------------------------------------------
@pytest.mark.win32
@pytest.mark.skipif(sys.platform != "win32", reason="回收站仅 Windows")
class TestRealRecycleBin:
    def test_delete_capture_and_restore(self, tmp_path):
        """端到端：删除 → $R 精确映射捕获 → 撤销还原。"""
        undo = UndoManager(tmp_path / "op_log.db")
        op = FileOperator(undo, session_id="it")
        target = tmp_path / f"disksense_{uuid.uuid4().hex[:8]}.bin"
        payload = os.urandom(64)
        target.write_bytes(payload)

        r = op.delete([str(target)])
        assert r["status"] == "completed", r
        assert not target.exists()

        entry = undo.list_ops(1)[0]
        assert entry["op_type"] == "DELETE"
        assert entry["status"] == "DONE"
        # 精确 $R 映射必须被捕获
        assert entry["recycle_bin_name"] and entry["recycle_bin_name"].startswith("$R")
        assert entry["recycle_info_name"] and entry["recycle_info_name"].startswith("$I")
        # recycle_path 必须是含盘根分隔符的绝对路径（回归防护：
        # 盘相对路径 "C:$Recycle.Bin\..." 依赖进程 CWD，属未定义行为）
        drive = os.path.splitdrive(str(target))[0]
        assert entry["recycle_path"].startswith(drive + "\\$Recycle.Bin\\")
        assert os.path.exists(entry["recycle_path"])

        # 撤销 → 文件按原路径还原，$I/$R 消失
        out = execute_undo(entry["id"], undo)
        assert out["status"] == "success", out
        assert target.read_bytes() == payload
        assert not os.path.exists(entry["recycle_path"])

    def test_delete_directory_to_recycle(self, tmp_path):
        undo = UndoManager(tmp_path / "op_log.db")
        op = FileOperator(undo)
        d = tmp_path / f"ds_dir_{uuid.uuid4().hex[:6]}"
        d.mkdir()
        (d / "inner.txt").write_text("inner")
        r = op.delete([str(d)])
        assert r["status"] == "completed"
        assert not d.exists()
        out = execute_undo(undo.list_ops(1)[0]["id"], undo)
        assert out["status"] == "success"
        assert (d / "inner.txt").read_text() == "inner"
