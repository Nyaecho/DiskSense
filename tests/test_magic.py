"""magic.py 魔数识别测试（真实临时文件，仅头部字节）。"""

import os

from disk_sense import magic


def _mk(path, data: bytes, pad_to: int = 0):
    if pad_to and len(data) < pad_to:
        data = data + b"\x00" * (pad_to - len(data))
    path.write_bytes(data)
    return str(path)


def test_png(tmp_path):
    r = magic.classify_magic_number(_mk(tmp_path / "a.png", b"\x89PNG\r\n\x1a\n" + b"x" * 20))
    assert r["magic_type"] == "PNG 图片" and r["confidence"] == "high"


def test_jpeg(tmp_path):
    r = magic.classify_magic_number(_mk(tmp_path / "b.jpg", b"\xff\xd8\xff\xe0" + b"y" * 20))
    assert "JPEG" in r["magic_type"]


def test_zip(tmp_path):
    r = magic.classify_magic_number(_mk(tmp_path / "c.zip", b"PK\x03\x04" + b"z" * 20))
    assert "ZIP" in r["magic_type"]


def test_riff_webp(tmp_path):
    data = b"RIFF" + (100).to_bytes(4, "little") + b"WEBP" + b"v" * 8
    r = magic.classify_magic_number(_mk(tmp_path / "d.webp", data))
    assert r["magic_type"] == "WebP 图片"


def test_riff_wave(tmp_path):
    data = b"RIFF" + (100).to_bytes(4, "little") + b"WAVE" + b"fmt " + b"v" * 8
    r = magic.classify_magic_number(_mk(tmp_path / "e.wav", data))
    assert "WAV" in r["magic_type"]


def test_mp4_ftyp_at_offset4(tmp_path):
    data = b"\x00\x00\x00\x20ftypisom" + b"m" * 8
    r = magic.classify_magic_number(_mk(tmp_path / "f.mp4", data))
    assert "MP4" in r["magic_type"]


def test_exe(tmp_path):
    r = magic.classify_magic_number(_mk(tmp_path / "g.exe", b"MZ" + b"\x00" * 30))
    assert r["magic_type"] == "PE 可执行(exe/dll)"


def test_iso_cd001_at_0x8001(tmp_path):
    p = tmp_path / "h.iso"
    with open(p, "wb") as f:
        f.write(b"\x00" * 16)
        f.seek(0x8001)
        f.write(b"CD001")
    r = magic.classify_magic_number(str(p))
    assert r["magic_type"] == "ISO 9660 光盘镜像" and r["mime"] == "application/x-iso9660-image"


def test_tar_ustar_at_0x101(tmp_path):
    p = tmp_path / "i.tar"
    with open(p, "wb") as f:
        f.write(b"\x00" * 16)
        f.seek(0x101)
        f.write(b"ustar")
    r = magic.classify_magic_number(str(p))
    assert r["magic_type"] == "TAR 归档"


def test_rar5_beats_shorter_prefixes(tmp_path):
    r = magic.classify_magic_number(
        _mk(tmp_path / "j.rar", b"Rar!\x1a\x07\x01\x00\x00" + b"r" * 10)
    )
    assert "RAR5" in r["magic_type"]


def test_tiny_file(tmp_path):
    r = magic.classify_magic_number(_mk(tmp_path / "k.txt", b"abc"))
    assert r["magic_type"] == "EMPTY_OR_SPARSE" and r["confidence"] == "low"


def test_unknown_content(tmp_path):
    # 文本内容一律 UNKNOWN——本工具绝不解析文本（铁律 1）
    r = magic.classify_magic_number(_mk(tmp_path / "l.txt", "普通文本内容" .encode("utf-8") * 4))
    assert r["magic_type"] == "UNKNOWN"


def test_missing_file(tmp_path):
    r = magic.classify_magic_number(str(tmp_path / "nope.bin"))
    assert r["magic_type"] == "UNKNOWN" and "error" in r
