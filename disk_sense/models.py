"""共享数据模型：目录树节点与扫描结果。

Node 树只保存元数据（名称/大小/时间），不含任何文件内容——
这是「零内容读取」铁律在数据结构层面的体现。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass(slots=True)
class Node:
    """目录树节点。

    Attributes:
        name: 文件/目录名（不含路径前缀）。
        size: 字节数。文件为其逻辑大小；目录在扫描完成后聚合为子树总大小。
        mtime / atime: 修改/访问时间（Unix 时间戳，秒）。
        is_dir: 是否目录。
        is_link: 是否 Junction/符号链接（不向下遍历，防死循环）。
        cache_type: 命中缓存目录模式库时的类型标注（如 pnpm/huggingface），
            否则为 None；聚合时据此打 CACHE_DOMINANT:<type> 信号。
        stale: 变更操作后标记为过期（scan-invalidation）；查询端点透传。
        children: 子节点映射（仅目录拥有；文件为 None 以节省内存）。
    """

    name: str
    size: int = 0
    mtime: float = 0.0
    atime: float = 0.0
    is_dir: bool = False
    is_link: bool = False
    cache_type: Optional[str] = None
    stale: bool = False
    stale_since: float = 0.0
    children: Optional[dict[str, "Node"]] = None

    def add_child(self, child: "Node") -> None:
        """把子节点挂到本目录（自动创建 children 映射）。"""
        if self.children is None:
            self.children = {}
        self.children[child.name] = child


@dataclass
class ScanResult:
    """一次扫描的完整结果。"""

    root: Node
    mode: str  # "mft" | "walk"
    files: int = 0
    dirs: int = 0
    total_bytes: int = 0
    skipped_paths: list[str] = field(default_factory=list)
    orphans: int = 0  # MFT 模式：父链断裂的记录数
    elapsed_sec: float = 0.0


# 进度回调：cb(progress∈[0,1], files_seen, bytes_seen)
ProgressCallback = Callable[[float, int, int], None]


def finalize_tree(root: Node) -> tuple[int, int, int]:
    """自底向上聚合目录大小与时间，返回 (文件数, 目录数, 总字节数)。

    迭代后序遍历，避免深路径触发递归上限。
    """

    def iter_postorder(node: Node):
        stack: list[Node] = [node]
        order: list[Node] = []
        while stack:
            n = stack.pop()
            order.append(n)
            if n.children:
                stack.extend(n.children.values())
        return order

    files = dirs = total = 0
    for n in reversed(iter_postorder(root)):
        if n.is_dir:
            dirs += 1
            if n.children:
                for c in n.children.values():
                    n.size += c.size
                    if c.mtime > n.mtime:
                        n.mtime = c.mtime
        else:
            files += 1
            total += n.size
    return files, dirs, total
