"""DiskSense API 客户端（Agent 的工具执行入口，方案书 §5.5）。

约定：
- **stdout 只输出最终 JSON**（Agent 读取），进度信息走 stderr；
- 服务未启动时自动调用 launcher.py 拉起（Agent 无需关心生命周期）；
- start_scan 内部轮询直到完成（或超时返回 scanning/timeout 状态）。

用法示例：
    python scripts/api_client.py start_scan --drive C:
    python scripts/api_client.py query_detail --entity_id wechat --category cache
    python scripts/api_client.py execute_operation --op_type delete --sources '["C:\\a"]'
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

import requests  # noqa: E402

from disk_sense.config import load_config  # noqa: E402

CFG = load_config()
BASE_URL = f"http://{CFG.server.host}:{CFG.server.port}"
LAUNCHER = os.path.join(PROJECT_ROOT, "scripts", "launcher.py")

TOOLS = [
    "status", "start_scan", "query_detail", "classify_unknown",
    "viz_command", "execute_operation", "list_recent_ops",
    "undo_operation", "add_protection", "remove_protection", "apply_tag",
]


def ensure_service() -> None:
    """健康检查失败则调用 launcher 拉起；仍失败则输出错误 JSON 并退出。"""
    try:
        if requests.get(f"{BASE_URL}/health", timeout=1).status_code == 200:
            return
    except requests.RequestException:
        pass
    r = subprocess.run(
        [sys.executable, LAUNCHER, "--start"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        print(json.dumps({
            "status": "error",
            "error": "DiskSense 服务启动失败，请检查 Python 依赖（pip install -r requirements.txt）",
            "launcher_output": (r.stdout or "") + (r.stderr or ""),
        }, ensure_ascii=False))
        sys.exit(1)


def call_api(endpoint: str, method: str = "POST", data=None, params=None, timeout: int = 60) -> dict:
    """通用 API 调用；HTTP 错误转成 {"status":"error"} JSON 而非抛栈。"""
    ensure_service()
    try:
        if method == "POST":
            resp = requests.post(f"{BASE_URL}/{endpoint}", json=data, timeout=timeout)
        else:
            resp = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=timeout)
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except ValueError:
                detail = resp.text
            return {"status": "error", "http_code": resp.status_code, "error": str(detail)}
        return resp.json()
    except requests.RequestException as e:
        return {"status": "error", "error": f"连接服务失败: {e}"}


def call_scan_with_polling(drive: str, timeout: int = 180) -> dict:
    """POST /scan → 若仍在扫描则内部轮询 /result（方案书：Agent 单次调用）。"""
    result = call_api("scan", data={"drive": drive}, timeout=timeout + 30)

    if result.get("status") == "scanning":
        session_id = result.get("session_id")
        started = time.time()
        while time.time() - started < timeout:
            time.sleep(3)
            poll = call_api("result", "GET", params={"session_id": session_id}, timeout=10)
            if "progress" in poll:
                print(f"[..] 扫描进度: {poll['progress'] * 100:.1f}%", file=sys.stderr)
            if poll.get("status") in ("completed", "failed"):
                return poll
        return {
            "status": "timeout",
            "session_id": session_id,
            "message": "扫描超时仍在进行，稍后可再次调用 start_scan 查询（返回当前会话状态）",
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="DiskSense API 客户端（Agent 工具入口）")
    parser.add_argument("tool", choices=TOOLS)
    parser.add_argument("--drive", type=str)
    parser.add_argument("--entity_id", type=str)
    parser.add_argument("--category", type=str)
    parser.add_argument("--path", type=str)
    parser.add_argument("--action", type=str)
    parser.add_argument("--target", type=str)
    parser.add_argument("--payload", type=str)
    parser.add_argument("--op_type", type=str)
    parser.add_argument("--sources", type=str)
    parser.add_argument("--dest", type=str)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--op_id", type=int)
    parser.add_argument("--tag", type=str)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()

    def jload(s):
        """解析 JSON 参数；给出可操作的错误提示而非栈回溯。

        注意：经过 bash/MSYS 传参时反斜杠可能被吞掉一层，提示语引导
        使用双反斜杠或正斜杠路径。
        """
        if not s:
            return None
        try:
            return json.loads(s)
        except json.JSONDecodeError as e:
            print(json.dumps({
                "status": "error",
                "error": f"JSON 参数解析失败: {e}",
                "hint": '路径请用正斜杠（C:/x）或双反斜杠（C:\\\\x），JSON 数组如 ["C:/a.txt"]',
            }, ensure_ascii=False))
            sys.exit(1)

    if args.tool == "status":
        result = call_api("health", "GET")
    elif args.tool == "start_scan":
        if not args.drive:
            result = {"status": "error", "error": "缺少 --drive 参数（如 --drive C:）"}
        else:
            result = call_scan_with_polling(args.drive, timeout=args.timeout)
    elif args.tool == "query_detail":
        result = call_api("detail", "GET", params={
            "entity_id": args.entity_id, "category": args.category,
        })
    elif args.tool == "classify_unknown":
        result = call_api("classify", data={"path": args.path})
    elif args.tool == "viz_command":
        result = call_api("viz", data={
            "action": args.action,
            "target": jload(args.target) or {},
            "payload": jload(args.payload) or {},
        })
    elif args.tool == "execute_operation":
        result = call_api("operation", data={
            "op_type": args.op_type,
            "sources": jload(args.sources) or [],
            "dest": args.dest,
        }, timeout=args.timeout)
    elif args.tool == "list_recent_ops":
        result = call_api("history", "GET", params={"limit": args.limit})
    elif args.tool == "undo_operation":
        result = call_api("undo", data={"op_id": args.op_id})
    elif args.tool == "add_protection":
        result = call_api("protect", data={"path": args.path, "add": True})
    elif args.tool == "remove_protection":
        result = call_api("protect", data={"path": args.path, "add": False})
    elif args.tool == "apply_tag":
        result = call_api("tag", data={"path": args.path, "tag": args.tag})
    else:  # pragma: no cover
        result = {"status": "error", "error": f"未知工具: {args.tool}"}

    print(json.dumps(result, ensure_ascii=False))
    # 部分工具（如 query_detail）按契约返回数组而非状态对象
    is_error = isinstance(result, dict) and result.get("status") == "error"
    return 1 if is_error else 0


if __name__ == "__main__":
    sys.exit(main())
