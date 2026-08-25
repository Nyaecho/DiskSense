/**
 * 指纹聚合器（Token 优化的核心）。
 *
 * 不把百万条文件路径塞给 LLM，而是聚合为 50~200 个「软件实体」，
 * 令指纹档案 JSON 控制在 ~5000 Token 内。
 *
 * 算法（贪婪匹配）：
 * 1. 种子提取：Program Files(-x86)/ProgramData 一级子目录，以及
 *    Users\*\AppData\{Local,Roaming,LocalLow} 的一级子目录；
 * 2. 角色映射：program_base / user_data / cache / logs（Temp、Cache、
 *    Logs 等路径标记自动改写角色）；
 * 3. 关联扩展：标准目录之外的路径若包含已知种子名（如 C:\AdobeTemp），
 *    归入对应实体并标记 location_anomaly；
 * 4. 未归类的大文件进入 global_anomalies，批量完成魔数识别，
 *    Agent 无需逐个查询。
 */

import path from "node:path";
import { classifyMagicNumber } from "./magic.js";
import type { ScanResult, TreeNode } from "./types.js";
import { RulesEngine } from "./rules-engine.js";

const MB = 1024 * 1024;

/** 聚合阈值默认值。 */
export interface AggregateOptions {
  maxEntities: number;
  anomalyMinMb: number;
  anomalyRootMinMb: number;
  maxAnomalies: number;
  treemapDepth: number;
  treemapChildren: number;
}

const DEFAULTS: AggregateOptions = {
  maxEntities: 200,
  anomalyMinMb: 200,
  anomalyRootMinMb: 50,
  maxAnomalies: 50,
  treemapDepth: 3,
  treemapChildren: 10,
};

export const ROLE_PROGRAM = "program_base";
export const ROLE_USER = "user_data";
export const ROLE_CACHE = "cache";
export const ROLE_LOGS = "logs";
const ROLES = [ROLE_PROGRAM, ROLE_USER, ROLE_CACHE, ROLE_LOGS] as const;
type Role = (typeof ROLES)[number];

const ROLE_LABELS: Record<Role, string> = {
  [ROLE_PROGRAM]: "安装目录",
  [ROLE_USER]: "用户数据",
  [ROLE_CACHE]: "缓存",
  [ROLE_LOGS]: "日志",
};

const PROGRAM_BASES = new Set(["program files", "program files (x86)"]);
const APPDATA_MODES = new Set(["local", "locallow", "roaming"]);
// 种子黑名单：这些名字位于种子位置但只是系统区域，不构成软件实体
const SEED_BLACKLIST = new Set([
  "temp", "tmp", "cache", "caches", "logs", "log", "crashdumps", "microsoft windows",
]);
const CACHE_MARKERS = new Set([
  "temp", "tmp", "cache", "caches", "cache2", "gpucache", "code cache", "shadercache", "crash dumps",
]);
const LOG_MARKERS = new Set(["logs", "log", "_logs", "logging"]);
const SYSTEM_TEMP_ID = "system-temp";

function mb(sizeBytes: number): number {
  return Math.round((sizeBytes / MB) * 10) / 10;
}

interface TopFile {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

class Loc {
  bytes = 0;
  files = 0;
  hasExe = false;
  /** Top5 文件堆（按大小降序维护，供 detail 查询） */
  top: TopFile[] = [];

  addFile(name: string, filePath: string, size: number, mtime: number, isExe: boolean): void {
    this.bytes += size;
    this.files++;
    if (isExe) this.hasExe = true;
    const item: TopFile = { name, path: filePath, size, mtime };
    if (this.top.length < 5) {
      this.top.push(item);
      this.top.sort((a, b) => b.size - a.size);
    } else if (size > this.top[this.top.length - 1]!.size) {
      this.top[this.top.length - 1] = item;
      this.top.sort((a, b) => b.size - a.size);
    }
  }
}

class Entity {
  locs: Record<Role, Loc>;
  anomaly = false;
  newestActivity = 0;
  /** ext → bytes */
  extBytes = new Map<string, number>();
  tags = new Set<string>();
  kind: "known" | "pseudo" = "known";

  constructor(
    public id: string,
    public display: string
  ) {
    this.locs = Object.fromEntries(ROLES.map((r) => [r, new Loc()])) as Record<Role, Loc>;
  }

  get totalBytes(): number {
    return ROLES.reduce((sum, r) => sum + this.locs[r].bytes, 0);
  }
}

export interface CacheDirHit {
  name: string;
  path: string;
  size: number;
  mtime: number;
  cache_type: string;
  /** 开发者产物附加信号（STALE_DEV_CACHE / ORPHAN_NODE_MODULES），可空 */
  signals?: string[];
}

/** 视为「可重建开发产物」的缓存类型。 */
const DEV_CACHE_TYPES = new Set(["node_modules", "python-venv"]);
/** 开发产物过期阈值（天）：超过即打 STALE_DEV_CACHE。 */
const DEV_STALE_DAYS = 90;
/** 判定 node_modules 是否「孤立」的清单/锁文件名（小写）。 */
const JS_MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
]);
/** 常见源码目录/入口，作为「项目仍存活」的辅助证据。 */
const SOURCE_MARKERS = new Set(["src", "lib", "app", "index.js", "index.ts", "tsconfig.json"]);

/** 把 ScanResult 树聚合成指纹档案。 */
export class Aggregator {
  cfg: AggregateOptions;
  rules: RulesEngine;
  tagsByPrefix: Record<string, string>;
  now: number;
  private classifyMagic: (p: string) => { magic_type: string; mime: string; confidence: string };
  seeds = new Map<string, string>(); // seed_lower → display
  /** 供 detail 使用（不进指纹 JSON） */
  entityTopFiles = new Map<string, Record<string, TopFile[]>>();
  private unassignedBytes = 0;
  /** 缓存目录模式库命中项：整棵子树归入缓存桶 */
  cacheDirs: CacheDirHit[] = [];
  /** 伪实体标记路径（小写、反斜杠、去尾分隔符） */
  pseudoEntityPaths: string[];

  constructor(options: {
    cfg?: Partial<AggregateOptions>;
    rules?: RulesEngine;
    tagsByPrefix?: Record<string, string>;
    now?: number;
    magicClassifier?: typeof Aggregator.prototype["classifyMagic"];
    pseudoEntityPaths?: string[];
  } = {}) {
    this.cfg = { ...DEFAULTS, ...options.cfg };
    this.rules = options.rules ?? new RulesEngine();
    this.tagsByPrefix = {};
    for (const [k, v] of Object.entries(options.tagsByPrefix ?? {})) {
      this.tagsByPrefix[k.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, "")] = v;
    }
    this.now = options.now ?? Date.now() / 1000;
    this.classifyMagic = options.magicClassifier ?? classifyMagicNumber;
    this.pseudoEntityPaths = (options.pseudoEntityPaths ?? []).map(
      (p) => p.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, "")
    );
  }

  /** 执行聚合，返回指纹档案（附加 treemap/legend）。 */
  aggregate(result: ScanResult, sessionId: string): Record<string, unknown> {
    const root = result.root;
    this.collectSeeds(root);

    const entities = new Map<string, Entity>();
    const anomalies: [string, number, number][] = []; // (path, size, mtime)

    this.walk(root, [root.name], [root.name.toLowerCase()], entities, anomalies);

    let ordered = [...entities.values()].sort((a, b) => b.totalBytes - a.totalBytes);
    const truncated = Math.max(0, ordered.length - this.cfg.maxEntities);
    ordered = ordered.slice(0, this.cfg.maxEntities);

    // --- 伪实体降级（pseudo-entities）：无已知实体时按顶层目录切分 ---
    let pseudoGenerated = false;
    if (ordered.length === 0) {
      for (const pe of this.generatePseudoEntities(root)) {
        if (!entities.has(pe.id)) entities.set(pe.id, pe);
      }
      ordered = [...entities.values()]
        .sort((a, b) => b.totalBytes - a.totalBytes)
        .slice(0, this.cfg.maxEntities);
      pseudoGenerated = true;
    }

    // --- global_anomalies：未归类大文件，批量魔数识别 ---
    anomalies.sort((a, b) => b[1] - a[1]);
    const globalAnomalies = anomalies.slice(0, this.cfg.maxAnomalies).map(([p, size]) => {
      const info = this.classifyMagic(p);
      return {
        path_preview: p.length <= 160 ? p : `${p.slice(0, 157)}...`,
        size_mb: mb(size),
        magic_type: info.magic_type,
      };
    });

    // --- 实体字典化 + 信号评估 ---
    const entityDicts = ordered.map((e) => this.entityToDict(e));

    const fingerprint: Record<string, unknown> = {
      session_id: sessionId,
      drive: root.name,
      entities: entityDicts,
      global_anomalies: globalAnomalies,
      cache_dirs: [...this.cacheDirs]
        .sort((a, b) => b.size - a.size)
        .slice(0, this.cfg.maxEntities)
        .map((c) => ({
          path: c.path,
          cache_type: c.cache_type,
          size_mb: mb(c.size),
          mtime: c.mtime,
          signal: `CACHE_DOMINANT:${c.cache_type}`,
          ...(c.signals && c.signals.length > 0 ? { signals: c.signals } : {}),
        })),
      summary: {
        total_scanned_mb: mb(result.totalBytes),
        files: result.files,
        dirs: result.dirs,
        skipped_dirs_count: result.skippedPaths.length,
        skipped_paths: result.skippedPaths.slice(0, 5),
        scan_time_sec: Math.round(result.elapsedSec * 10) / 10,
        scan_mode: result.mode,
        entities_count: entityDicts.length,
        entities_truncated: truncated,
        cache_dirs_count: this.cacheDirs.length,
      },
      signals_legend: {
        ...Object.fromEntries(this.rules.rules.map((r) => [r.signal, r.description])),
        STALE_DEV_CACHE: `node_modules/venv 等开发产物超过 ${DEV_STALE_DAYS} 天未访问，可删除后按需重建`,
        ORPHAN_NODE_MODULES: "node_modules 同级无 package.json/lockfile/源码标记，疑似源码已删的孤立依赖目录",
      },
      treemap: this.buildTreemap(root, ordered),
    };
    if (pseudoGenerated) fingerprint["pseudo_entities"] = true;
    return fingerprint;
  }

  // ------------------------------------------------------------------
  /**
   * 目录级伪实体：用户标记路径优先，否则按顶层目录切分。
   * 每个伪实体携带路径/体积/文件数/mtime 聚合元数据，kind="pseudo"。
   */
  private generatePseudoEntities(root: TreeNode): Entity[] {
    const pseudo: Entity[] = [];

    const makeEntity = (name: string, p: string, node: TreeNode): Entity => {
      const e = new Entity(`pseudo:${p.toLowerCase()}`, name);
      e.kind = "pseudo";
      e.locs[ROLE_USER].bytes = node.size;
      // 文件数/时间从子树粗略聚合
      let files = 0;
      let newest = node.mtime;
      const stack: TreeNode[] = [node];
      while (stack.length > 0) {
        const n = stack.pop()!;
        for (const c of n.children?.values() ?? []) {
          if (c.isDir) stack.push(c);
          else files++;
          if (c.mtime > newest) newest = c.mtime;
        }
      }
      e.locs[ROLE_USER].files = files;
      e.newestActivity = newest;
      e.extBytes.set("", node.size); // 目录级聚合无扩展名细分
      return e;
    };

    // 用户标记路径优先
    const rootLow = root.name.toLowerCase();
    for (const marked of this.pseudoEntityPaths) {
      // 标记路径须在扫描根之下（范围外静默跳过）
      if (!marked.startsWith(`${rootLow}\\`) && marked !== rootLow) continue;
      const rest = marked.slice(root.name.length).replace(/^\\+/, "");
      let node: TreeNode | undefined = root;
      for (const seg of rest ? rest.split("\\") : []) {
        if (!node?.children) {
          node = undefined;
          break;
        }
        node =
          node.children.get(seg) ??
          [...node.children.entries()].find(([k]) => k.toLowerCase() === seg.toLowerCase())?.[1];
        if (!node) break;
      }
      if (node && node.size > 0) pseudo.push(makeEntity(node.name, marked, node));
    }
    if (pseudo.length > 0) return pseudo;

    // 无标记：按顶层目录切分（跳过缓存目录与零体积目录）
    for (const [name, child] of root.children ?? []) {
      if (child.size <= 0 || !child.isDir || child.cacheType) continue;
      pseudo.push(makeEntity(name, `${root.name}\\${name}`, child));
    }
    return pseudo;
  }

  // ------------------------------------------------------------------
  /** 贪婪种子提取：标准安装/数据目录的一级子目录名。 */
  private collectSeeds(root: TreeNode): void {
    const addChildrenAsSeeds = (node: TreeNode): void => {
      if (!node.children) return;
      for (const [name, child] of node.children) {
        const low = name.toLowerCase();
        if (SEED_BLACKLIST.has(low) || child.size === 0) continue;
        this.seeds.set(low, name);
      }
    };

    for (const [topName, top] of root.children ?? []) {
      const low = topName.toLowerCase();
      if (PROGRAM_BASES.has(low) || low === "programdata") {
        addChildrenAsSeeds(top);
      } else if (low === "users") {
        for (const user of top.children?.values() ?? []) {
          const appdata = user.children?.get("AppData");
          if (!appdata) continue;
          for (const [mode, node] of appdata.children ?? []) {
            if (APPDATA_MODES.has(mode.toLowerCase())) addChildrenAsSeeds(node);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  /**
   * 路径 → (实体种子名|null, 角色|null, 是否异常位置)。
   * 角色由基准目录之后的路径标记（Temp/Cache/Logs）决定；
   * 无种子但角色为缓存者归入系统临时伪实体。
   */
  private classifyPath(
    partsLow: string[],
    isDir = false
  ): [string | null, Role | null, boolean] {
    let baseIdx = -1;
    let baseRole: Role | null = null;
    for (let i = 0; i < partsLow.length; i++) {
      const p = partsLow[i]!;
      if (PROGRAM_BASES.has(p)) {
        baseIdx = i;
        baseRole = ROLE_PROGRAM;
        break;
      }
      if (p === "appdata") {
        baseIdx = i;
        baseRole = ROLE_USER;
        break;
      }
      if (p === "programdata") {
        baseIdx = i;
        baseRole = ROLE_USER;
        break;
      }
    }

    const isAppdata = baseIdx >= 0 && partsLow[baseIdx] === "appdata";
    let role: Role | null = null;
    if (baseIdx >= 0) {
      let rest = partsLow.slice(baseIdx + 1);
      // AppData 需要穿过 Local/Roaming/LocalLow 才到种子
      if (isAppdata) {
        if (rest.length > 0 && APPDATA_MODES.has(rest[0]!)) rest = rest.slice(1);
        else rest = []; // AppData 根下散落文件，不构成实体
      }
      let seed = rest.length > 0 ? rest[0]! : null;
      if (seed !== null && SEED_BLACKLIST.has(seed)) seed = null;
      // 基准目录根下的散文件（如 Program Files\x.dll）不构成实体
      if (seed !== null && !isDir) {
        const seedPos = baseIdx + (isAppdata ? 2 : 1);
        if (seedPos === partsLow.length - 1) seed = null;
      }
      role = baseRole;
      let cacheIdx = -1;
      let logIdx = -1;
      for (let i = 0; i < rest.length; i++) {
        if (CACHE_MARKERS.has(rest[i]!)) cacheIdx = i;
        if (LOG_MARKERS.has(rest[i]!)) logIdx = i;
      }
      if (cacheIdx > logIdx) role = ROLE_CACHE;
      else if (logIdx > cacheIdx) role = ROLE_LOGS;
      if (seed !== null) return [seed, role, false];
    }

    // Windows\Temp 等系统临时区 → 系统临时伪实体
    if (baseIdx === -1) {
      for (let i = 0; i < partsLow.length - 1; i++) {
        if (partsLow[i] === "windows" && CACHE_MARKERS.has(partsLow[i + 1]!)) {
          return [SYSTEM_TEMP_ID, ROLE_CACHE, false];
        }
      }
    }

    // 关联扩展：路径任意段包含已知种子名 → 归入该实体（位置异常）
    for (let i = 0; i < partsLow.length; i++) {
      const p = partsLow[i]!;
      if (this.seeds.has(p)) {
        return [p, this.markerRole(partsLow, i) ?? ROLE_USER, true];
      }
    }
    for (const p of partsLow) {
      for (const s of this.seeds.keys()) {
        if (s.length >= 3 && p.includes(s)) {
          return [s, this.markerRole(partsLow, partsLow.indexOf(p)) ?? ROLE_USER, true];
        }
      }
    }

    // 无实体：纯缓存角色 → 系统临时伪实体；否则未归类
    if (role === ROLE_CACHE && baseIdx >= 0) {
      return [SYSTEM_TEMP_ID, ROLE_CACHE, false];
    }
    return [null, role, false];
  }

  private static markerRole(partsLow: string[], upTo: number): Role | null {
    const cache = partsLow.slice(0, upTo + 1).some((p) => CACHE_MARKERS.has(p));
    const logs = partsLow.slice(0, upTo + 1).some((p) => LOG_MARKERS.has(p));
    if (cache && !logs) return ROLE_CACHE;
    if (logs && !cache) return ROLE_LOGS;
    return null;
  }

  private markerRole(partsLow: string[], upTo: number): Role | null {
    return Aggregator.markerRole(partsLow, upTo);
  }

  // ------------------------------------------------------------------
  /** DFS 实体归集。parts 为显示路径段，partsLow 为小写匹配段。 */
  private walk(
    node: TreeNode,
    parts: string[],
    partsLow: string[],
    entities: Map<string, Entity>,
    anomalies: [string, number, number][]
  ): void {
    for (const [name, child] of node.children ?? []) {
      const cparts = [...parts, name];
      const cpartsLow = [...partsLow, name.toLowerCase()];
      const filePath = cparts.join("\\");

      // 缓存目录模式库命中：整棵子树归入缓存桶，不再下钻归类
      if (child.isDir && child.cacheType) {
        const hit: CacheDirHit = {
          name,
          path: filePath,
          size: child.size,
          mtime: child.mtime,
          cache_type: child.cacheType,
        };
        const sigs = this.devArtifactSignals(child, node);
        if (sigs.length > 0) hit.signals = sigs;
        this.cacheDirs.push(hit);
        continue;
      }

      if (child.isDir && child.children) {
        this.walk(child, cparts, cpartsLow, entities, anomalies);
        continue;
      }

      const size = child.size;
      if (size <= 0) continue;

      const [seed, role, anomaly] = this.classifyPath(cpartsLow, child.isDir);
      const ext = path.extname(name).toLowerCase();

      if (seed === null) {
        // 未归类：按体积门槛进入 global_anomalies 候选
        const threshold =
          cparts.length <= 2 ? this.cfg.anomalyRootMinMb : this.cfg.anomalyMinMb;
        if (size >= threshold * MB) anomalies.push([filePath, size, child.mtime]);
        this.unassignedBytes += size;
        continue;
      }

      let entity = entities.get(seed);
      if (!entity) {
        const display =
          seed === SYSTEM_TEMP_ID ? "系统临时文件" : this.seeds.get(seed) ?? seed;
        entity = new Entity(seed, display);
        entities.set(seed, entity);
      }
      if (anomaly) entity.anomaly = true;

      const targetRole = role ?? ROLE_USER;
      const loc = entity.locs[targetRole];
      loc.addFile(
        name, filePath, size, child.mtime,
        ext === ".exe" && targetRole === ROLE_PROGRAM
      );
      entity.extBytes.set(ext, (entity.extBytes.get(ext) ?? 0) + size);
      const activity = Math.max(child.mtime, child.atime);
      if (activity > entity.newestActivity) entity.newestActivity = activity;

      // 用户标签：最长前缀匹配
      const lowPath = filePath.toLowerCase();
      for (const [prefix, tag] of Object.entries(this.tagsByPrefix)) {
        if (lowPath.startsWith(prefix)) {
          entity.tags.add(tag);
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  /**
   * 开发者产物信号（面向数据盘的依赖/虚拟环境目录）：
   * - STALE_DEV_CACHE：node_modules / venv 超过 90 天未访问，可安全重建；
   * - ORPHAN_NODE_MODULES：同级无 package.json / lockfile / 源码标记，
   *   极大概率是源码已删、残留依赖目录。
   */
  private devArtifactSignals(node: TreeNode, parent: TreeNode): string[] {
    const type = node.cacheType;
    if (!type || !DEV_CACHE_TYPES.has(type)) return [];
    const sigs: string[] = [];

    // 目录 atime 会被任何遍历（scan/search_dirs）刷新，不可作为活跃依据；
    // mtime 只在内容变更（如 npm install）时更新，对目录语义正确
    const lastActive = node.mtime;
    if (lastActive > 0) {
      const days = Math.floor((this.now - lastActive) / 86400);
      if (days > DEV_STALE_DAYS) sigs.push("STALE_DEV_CACHE");
    }

    if (type === "node_modules") {
      let hasManifest = false;
      for (const name of parent.children?.keys() ?? []) {
        const low = name.toLowerCase();
        if (JS_MANIFESTS.has(low) || SOURCE_MARKERS.has(low)) {
          hasManifest = true;
          break;
        }
      }
      if (!hasManifest) sigs.push("ORPHAN_NODE_MODULES");
    }
    return sigs;
  }

  // ------------------------------------------------------------------
  private entityToDict(e: Entity): Record<string, unknown> {
    const total = e.totalBytes;
    const lastDays =
      e.newestActivity > 0 ? Math.max(0, Math.floor((this.now - e.newestActivity) / 86400)) : null;

    const locations = Object.fromEntries(
      ROLES.map((r) => [
        r,
        {
          size_mb: mb(e.locs[r].bytes),
          file_count: e.locs[r].files,
          has_exe: e.locs[r].hasExe,
        },
      ])
    );

    const topExts = [...e.extBytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

    const dict: Record<string, unknown> = {
      id: e.id,
      display: e.display,
      kind: e.kind,
      total_size_mb: mb(total),
      locations,
      signals: this.rules.evaluateSignals({
        id: e.id,
        total_size_mb: mb(total),
        last_access_days: lastDays,
        location_anomaly: e.anomaly,
        locations,
      }),
      last_access_days: lastDays,
      top_extensions: topExts.map(([ext]) => (ext === "" ? "(无扩展名)" : ext)),
      location_anomaly: e.anomaly,
      tags: [...e.tags].sort(),
    };
    // detail 数据留存在聚合器实例上（不进指纹 JSON，省 Token）
    this.entityTopFiles.set(
      e.id,
      Object.fromEntries(
        ROLES.map((r) => [
          r,
          e.locs[r].top.map((f) => ({ ...f })),
        ])
      )
    );
    return dict;
  }

  // ------------------------------------------------------------------
  /** 实体树 + 非覆盖根目录 → Treemap 层级数据（含实体 id 供高亮）。 */
  private buildTreemap(root: TreeNode, ordered: Entity[]): Record<string, unknown> {
    const children: Record<string, unknown>[] = [];
    for (const e of ordered) {
      const roleChildren = ROLES.filter((r) => e.locs[r].bytes > 0).map((r) => ({
        name: ROLE_LABELS[r],
        id: `${e.id}:${r}`,
        value: e.locs[r].bytes,
      }));
      children.push({
        name: e.display,
        id: e.id,
        value: e.totalBytes,
        children: roleChildren,
      });
    }

    const covered = new Set(["program files", "program files (x86)", "users", "programdata"]);
    const cachePaths = new Set(this.cacheDirs.map((c) => c.path.toLowerCase()));
    const restDirs = [...(root.children ?? [])]
      .filter(
        ([n, c]) =>
          !covered.has(n.toLowerCase()) &&
          c.size > 0 &&
          !cachePaths.has(`${root.name}\\${n}`.toLowerCase())
      )
      .map(([, c]) => c);
    restDirs.sort((a, b) => b.size - a.size);
    for (const d of restDirs.slice(0, this.cfg.treemapChildren)) {
      const sub = [...d.children?.values() ?? []].sort((a, b) => b.size - a.size);
      children.push({
        name: d.name,
        id: `dir:${d.name.toLowerCase()}`,
        value: d.size,
        children: sub
          .filter((s) => s.size > 0)
          .slice(0, this.cfg.treemapChildren)
          .map((s) => ({
            name: s.name,
            id: `dir:${d.name.toLowerCase()}\\${s.name.toLowerCase()}`,
            value: s.size,
          })),
      });
    }

    // 缓存目录：带 CACHE_DOMINANT:<type> 信号，不计入「未归类文件」
    for (const c of [...this.cacheDirs]
      .sort((a, b) => b.size - a.size)
      .slice(0, this.cfg.treemapChildren)) {
      children.push({
        name: `${c.name}（${c.cache_type} 缓存）`,
        id: `cache:${c.cache_type}:${c.path.toLowerCase()}`,
        value: c.size,
        signal: `CACHE_DOMINANT:${c.cache_type}`,
      });
    }

    if (this.unassignedBytes > 0) {
      children.push({ name: "未归类文件", id: "unassigned", value: this.unassignedBytes });
    } else if (this.unassignedBytes < 0) {
      // 缓存目录冲抵后不应为负；防御性归零并告警
      console.error(`[aggregator] 未归类字节出现负值（${this.unassignedBytes}），已归零`);
      this.unassignedBytes = 0;
    }
    return { name: root.name, id: "root", children };
  }
}
