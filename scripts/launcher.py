"""DiskSense 服务启动/停止脚本（方案书 §5 便携启动与生命周期）。

- 健康检查：http://localhost:58901/health（端口读自 config/config.yaml）
- 单例：filelock 原子锁消除 Check-Then-Act 竞态；服务进程自身也持锁
- 拉起：subprocess + CREATE_NO_WINDOW | DETACHED_PROCESS（无黑框、独立于
  Agent 进程存活）
- 用法：python scripts/launcher.py --start | --stop | --status
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(errors="replace")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

import requests  # noqa: E402
from filelock import FileLock, Timeout  # noqa: E402

from disk_sense.config import DATA_DIR, LOCK_FILE, load_config  # noqa: E402

CFG = load_config()
PORT = CFG.server.port
HOST = CFG.server.host
HEALTH_URL = f"http://{HOST}:{PORT}/health"

os.makedirs(DATA_DIR, exist_ok=True)

_lock_handle = None  # 进程存活期间保持锁句柄


def is_running() -> bool:
    try:
        return requests.get(HEALTH_URL, timeout=1).status_code == 200
    except requests.RequestException:
        return False


def acquire_singleton() -> bool:
    """filelock 原子单例：获取失败说明已有进程持有（正在启动或运行中）。"""
    global _lock_handle
    try:
        _lock_handle = FileLock(str(LOCK_FILE), timeout=0.5)
        _lock_handle.acquire(timeout=0.1)
        return True
    except Timeout:
        return False


def start_daemon() -> bool:
    if is_running():
        print("[ok] DiskSense 服务已在运行。")
        return True

    if not acquire_singleton():
        print("[..] 其他进程正在启动服务，等待就绪...")
        for _ in range(15):
            time.sleep(0.2)
            if is_running():
                print("[ok] DiskSense 服务已启动。")
                return True
        print("[error] 等待超时，请检查 Python 环境与端口占用。")
        return False

    print("[..] 正在启动 DiskSense 服务...")
    creationflags = 0
    if sys.platform == "win32":
        creationflags = 0x08000000 | 0x00000008  # CREATE_NO_WINDOW | DETACHED_PROCESS
    subprocess.Popen(
        [sys.executable, "-m", "disk_sense.server", "--host", HOST, "--port", str(PORT)],
        cwd=PROJECT_ROOT,
        env={**os.environ, "PYTHONPATH": PROJECT_ROOT},
        creationflags=creationflags,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # 关键：立刻释放启动协调锁——服务进程启动时会获取同一把锁实现自身单例，
    # 若 launcher 持锁等待健康检查会与服务形成死锁
    if _lock_handle is not None:
        try:
            _lock_handle.release()
        except Exception:  # noqa: BLE001
            pass

    for _ in range(30):
        time.sleep(0.2)
        if is_running():
            print(f"[ok] DiskSense 服务启动成功，监听 {HOST}:{PORT}。")
            return True

    print("[error] 启动超时，请手动检查 Python 环境与依赖安装。")
    return False


def stop_daemon() -> bool:
    try:
        requests.get(f"http://{HOST}:{PORT}/shutdown", timeout=1)
        print("[ok] 已请求服务关闭。")
    except requests.RequestException:
        print("[ok] 服务未在运行。")
    return True


def status() -> bool:
    if is_running():
        print(f"[ok] DiskSense 服务运行中：{HEALTH_URL}")
        try:
            print(requests.get(HEALTH_URL, timeout=1).json())
        except requests.RequestException:
            pass
        return True
    print("[--] DiskSense 服务未运行。")
    return False


def main() -> int:
    arg = sys.argv[1] if len(sys.argv) > 1 else "--status"
    if arg == "--start":
        return 0 if start_daemon() else 1
    if arg == "--stop":
        return 0 if stop_daemon() else 1
    if arg == "--status":
        return 0 if status() else 1
    print(f"用法: python {sys.argv[0]} --start | --stop | --status")
    return 2


if __name__ == "__main__":
    sys.exit(main())
