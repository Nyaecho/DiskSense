"""``python -m disk_sense`` → 启动本地服务（与 ``python -m disk_sense.server`` 等价）。"""

from .server import main

if __name__ == "__main__":
    main()
