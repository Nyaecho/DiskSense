/**
 * 共享数据模型：目录树节点与扫描结果。
 *
 * Node 树只保存元数据（名称/大小/时间），不含任何文件内容——
 * 这是「零内容读取」铁律在数据结构层面的体现。
 */

/** 目录树节点（对应 Python 版 models.Node） */
export interface TreeNode {
  /** 文件/目录名（不含路径前缀） */
  name: string;
  /** 字节数。文件为逻辑大小；目录在扫描完成后聚合为子树总大小 */
  size: number;
  /** 修改/访问时间（Unix 时间戳，秒） */
  mtime: number;
  atime: number;
  isDir: boolean;
  /** Junction/符号链接（不向下遍历，防死循环） */
  isLink: boolean;
  /** 命中缓存目录模式库时的类型标注（如 pnpm/huggingface），否则 null */
  cacheType: string | null;
  /** 变更操作后标记为过期（scan-invalidation）；查询端点透传 */
  stale?: boolean;
  staleSince?: number;
  /** 子节点映射（仅目录拥有；文件为 undefined 以节省内存） */
  children?: Map<string, TreeNode>;
}

export function createNode(name: string, init: Partial<TreeNode> = {}): TreeNode {
  return {
    name,
    size: 0,
    mtime: 0,
    atime: 0,
    isDir: false,
    isLink: false,
    cacheType: null,
    ...init,
  };
}

export function addChild(parent: TreeNode, child: TreeNode): void {
  if (!parent.children) parent.children = new Map();
  parent.children.set(child.name, child);
}

/** 一次扫描的完整结果 */
export interface ScanResult {
  root: TreeNode;
  mode: "mft" | "walk";
  files: number;
  dirs: number;
  totalBytes: number;
  skippedPaths: string[];
  /** MFT 模式：父链断裂的记录数 */
  orphans: number;
  elapsedSec: number;
}

/** 进度回调：cb(progress∈[0,1], files_seen, bytes_seen) */
export type ProgressCallback = (
  progress: number,
  filesSeen: number,
  bytesSeen: number
) => void;

/**
 * 自底向上聚合目录大小与时间，返回 [文件数, 目录数, 总字节数]。
 * 迭代后序遍历，避免深路径触发递归上限。
 */
export function finalizeTree(root: TreeNode): [number, number, number] {
  const stack: TreeNode[] = [root];
  const order: TreeNode[] = [];
  while (stack.length > 0) {
    const n = stack.pop()!;
    order.push(n);
    if (n.children) {
      for (const c of n.children.values()) stack.push(c);
    }
  }

  let files = 0;
  let dirs = 0;
  let total = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i]!;
    if (n.isDir) {
      dirs++;
      if (n.children) {
        for (const c of n.children.values()) {
          n.size += c.size;
          if (c.mtime > n.mtime) n.mtime = c.mtime;
        }
      }
    } else {
      files++;
      total += n.size;
    }
  }
  return [files, dirs, total];
}
