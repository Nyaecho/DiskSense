"""mft.py 纯解析函数测试：用合成 MFT 记录字节验证，无需真实卷/管理员权限。"""

import struct
import time

import pytest

from disk_sense import mft
from disk_sense.models import finalize_tree

RECORD_SIZE = 1024
_EPOCH = 116444736000000000


def _ft(ts: float) -> int:
    return int(ts * 1e7 + _EPOCH)


def _file_name_value(parent: int, name: str, size: int, mtime: float = 1000.0, atime: float = 2000.0) -> bytes:
    nm = name.encode("utf-16-le")
    return (
        struct.pack("<Q", parent)
        + struct.pack("<4Q", 0, _ft(mtime), 0, _ft(atime))  # 创建/修改/MFT修改/访问
        + struct.pack("<2Q", size, size)                     # 分配大小/实际大小
        + struct.pack("<2I", 0, 0)                           # flags/ea
        + bytes([len(name), 1])                              # 名长(字符数), namespace=WIN32
        + nm
    )


def _resident_attr(attr_type: int, value: bytes) -> bytes:
    value_off = 24
    total = value_off + len(value)
    total += (-total) % 8
    return (
        struct.pack("<II", attr_type, total)
        + bytes([0, 0])                       # nonresident=0, name_len=0
        + struct.pack("<HHH", 0, 0, 0)        # name_off/flags/instance
        + struct.pack("<IH", len(value), value_off)
        + b"\x00\x00"                         # 对齐填充到 value_off
        + value
        + b"\x00" * ((-(value_off + len(value))) % 8)
    )


def _make_record(attrs: bytes, *, is_dir: bool = False, in_use: bool = True, base: int = 0) -> bytes:
    """组装一个带 Fixup 的 1024 字节 FILE 记录。"""
    flags = (1 if in_use else 0) | (2 if is_dir else 0)
    usa_off, usa_cnt, attrs_off = 0x30, 3, 0x38
    used = attrs_off + len(attrs)
    buf = bytearray(RECORD_SIZE)
    struct.pack_into("<4s", buf, 0, b"FILE")
    struct.pack_into("<HH", buf, 4, usa_off, usa_cnt)
    struct.pack_into("<H", buf, 0x10, 1)   # sequence
    struct.pack_into("<H", buf, 0x12, 1)   # link_count
    struct.pack_into("<H", buf, 0x14, attrs_off)
    struct.pack_into("<H", buf, 0x16, flags)
    struct.pack_into("<I", buf, 0x18, used)
    struct.pack_into("<I", buf, 0x1C, RECORD_SIZE)
    struct.pack_into("<q", buf, 0x20, base)
    buf[attrs_off : attrs_off + len(attrs)] = attrs
    tag = 0x1234
    struct.pack_into("<HHH", buf, usa_off, tag, 0x1111, 0x2222)
    struct.pack_into("<H", buf, 510, tag)    # 每扇区尾部写 tag，Fixup 后还原
    struct.pack_into("<H", buf, 1022, tag)
    return bytes(buf)


def _file_record(parent: int, name: str, size: int, mtime=1000.0, atime=2000.0, **kw) -> bytes:
    return _make_record(
        _resident_attr(0x30, _file_name_value(parent, name, size, mtime, atime)), **kw
    )


class TestParseRecord:
    def test_file_record(self):
        rec = mft.parse_record(_file_record(5, "data.bin", 1234))
        assert rec is not None
        assert rec.parent == 5
        assert rec.name == "data.bin"
        assert rec.size == 1234
        assert rec.mtime == pytest.approx(1000.0)
        assert rec.atime == pytest.approx(2000.0)
        assert rec.flags == 0  # 非目录非链接

    def test_directory_record(self):
        rec = mft.parse_record(_file_record(5, "Windows", 0, is_dir=True))
        assert rec is not None and rec.flags & 1

    def test_not_in_use_skipped(self):
        assert mft.parse_record(_file_record(5, "x", 1, in_use=False)) is None

    def test_extension_record_skipped(self):
        assert mft.parse_record(_file_record(5, "x", 1, base=0x50000)) is None

    def test_corrupt_fixup_rejected(self):
        buf = bytearray(_file_record(5, "x", 1))
        buf[510:512] = b"\xde\xad"  # 破坏扇区尾校验
        assert mft._apply_fixups(bytes(buf)) is None

    def test_bad_magic_rejected(self):
        assert mft._apply_fixups(b"\x00" * 1024) is None

    def test_attribute_list_record_skipped(self):
        # 含 $ATTRIBUTE_LIST 的记录信息不完整，应跳过
        attrs = _resident_attr(0x20, b"\x00" * 32) + _resident_attr(
            0x30, _file_name_value(5, "y", 9)
        )
        assert mft.parse_record(_make_record(attrs)) is None

    def _fn_value(self, parent: int, name: str, size: int, namespace: int) -> bytes:
        nm = name.encode("utf-16-le")
        return (
            struct.pack("<Q", parent)
            + struct.pack("<4Q", 0, _ft(1.0), 0, _ft(1.0))
            + struct.pack("<2Q", size, size)
            + struct.pack("<2I", 0, 0)
            + bytes([len(name), namespace])
            + nm
        )

    def test_win32_name_preferred_over_dos(self):
        dos = _resident_attr(0x30, self._fn_value(5, "LONGFI~1.TXT", 7, namespace=2))
        win32 = _resident_attr(0x30, self._fn_value(5, "LongFileName.txt", 7, namespace=1))
        attrs = dos + win32  # DOS 在前，Win32 在后，应选 Win32 长名
        rec = mft.parse_record(_make_record(attrs))
        assert rec is not None and rec.name == "LongFileName.txt"

    def test_dos_only_name_fallback(self):
        dos = _resident_attr(0x30, self._fn_value(5, "PROGRA~1", 0, namespace=2))
        rec = mft.parse_record(_make_record(dos))
        assert rec is not None and rec.name == "PROGRA~1"

    def test_unicode_name(self):
        rec = mft.parse_record(_file_record(5, "新建文件夹", 100))
        assert rec is not None and rec.name == "新建文件夹"


class TestParseVolumeData:
    def test_roundtrip(self):
        values = [1, 2, 3, 4, 5, 4096, 512, 1024, 0, 400_000_000, 786_432]
        buf = struct.pack("<11q", *values)
        info = mft.parse_volume_data(buf)
        assert info["bytes_per_cluster"] == 4096
        assert info["bytes_per_frs"] == 1024
        assert info["mft_valid_data_length"] == 400_000_000
        assert info["mft_start_lcn"] == 786_432

    def test_short_buffer_rejected(self):
        with pytest.raises(mft.MFTUnavailableError):
            mft.parse_volume_data(b"\x00" * 16)

    def test_invalid_frs_rejected(self):
        buf = struct.pack("<11q", *([1] * 7 + [0, 0, 100, 100]))
        with pytest.raises(mft.MFTUnavailableError):
            mft.parse_volume_data(buf)


class TestParseMftBuffer:
    def test_two_records(self):
        chunk = _file_record(5, "a.txt", 10) + _file_record(5, "b.txt", 20)
        records = {}
        n, sz = mft.parse_mft_buffer(chunk, RECORD_SIZE, records, start_rec=100)
        assert n == 2 and sz == 30
        assert 100 in records and 101 in records
        assert records[101].name == "b.txt"

    def test_mixed_with_garbage(self):
        garbage = b"\x00" * RECORD_SIZE
        chunk = garbage + _file_record(5, "c.txt", 5)
        records = {}
        n, _ = mft.parse_mft_buffer(chunk, RECORD_SIZE, records, start_rec=0)
        assert n == 1 and 1 in records and 0 not in records


class TestBuildTree:
    def _records(self):
        return {
            5: mft.Record(5, "C:", 0, 0.0, 0.0, 1),        # 根（自引用父）
            100: mft.Record(5, "Users", 0, 1.0, 1.0, 1),    # 目录
            101: mft.Record(100, "tom", 0, 1.0, 1.0, 1),    # 目录
            102: mft.Record(101, "a.doc", 1000, 2.0, 3.0, 0),
            103: mft.Record(101, "b.doc", 2000, 4.0, 4.0, 0),
            104: mft.Record(5, "pagefile.sys", 5000, 9.0, 9.0, 0),
            105: mft.Record(5, "junction", 0, 0.0, 0.0, 1 | 2),  # 链接目录
            106: mft.Record(5, "$RECYCLE.BIN", 9999, 0.0, 0.0, 1),  # 应被忽略
            200: mft.Record(999_999, "orphan.txt", 10, 0.0, 0.0, 0),  # 孤儿
        }

    def test_tree_structure_and_sizes(self):
        root, orphans = mft.build_tree(self._records(), "C:", ["$RECYCLE.BIN"])
        assert root.name == "C:"
        assert set(root.children) == {"Users", "pagefile.sys", "junction"}
        users = root.children["Users"]
        tom = users.children["tom"]
        files, dirs, total = finalize_tree(root)
        assert tom.size == 3000  # 目录大小由 finalize_tree 聚合
        assert files == 3        # a.doc, b.doc, pagefile.sys
        assert total == 8000
        assert orphans == 1

    def test_junction_not_traversed_but_present(self):
        root, _ = mft.build_tree(self._records(), "C:", ["$RECYCLE.BIN"])
        j = root.children["junction"]
        assert j.is_link and j.is_dir and j.children is None

    def test_ignore_glob(self):
        root, _ = mft.build_tree(self._records(), "C:", ["$RECYCLE.BIN", "$*"])
        assert "$RECYCLE.BIN" not in root.children

    def test_ignores_dot_entries(self):
        records = {
            5: mft.Record(5, "C:", 0, 0, 0, 1),
            10: mft.Record(5, ".", 0, 0, 0, 1),
            11: mft.Record(5, "..", 0, 0, 0, 1),
        }
        root, _ = mft.build_tree(records, "C:", [])
        assert root.children == {}

    def test_cycle_protection(self):
        # 100 ↔ 101 互相为父，访问集必须阻断环
        records = {
            5: mft.Record(5, "C:", 0, 0, 0, 1),
            100: mft.Record(101, "a", 0, 0, 0, 1),
            101: mft.Record(100, "b", 0, 0, 0, 1),
        }
        root, _ = mft.build_tree(records, "C:", [])
        assert root.children == {}  # 环不可达自根，安全终止


class TestFiletime:
    def test_zero(self):
        assert mft.filetime_to_unix(0) == 0.0

    def test_epoch(self):
        assert mft.filetime_to_unix(_EPOCH) == pytest.approx(0.0)
        assert mft.filetime_to_unix(_ft(1700000000)) == pytest.approx(1700000000)
