"""结构化规则引擎（语义信号生成）。

设计哲学：代码中绝不出现 ``if "微信" in path`` 一类的硬编码判断；
所有信号来自 ``config/classification_rules.yaml`` 的**结构化条件树**，
由 :class:`SafeEvaluator` 用 Python 内置 operator 白名单安全评估——
不使用 ``eval()``，不执行任意代码。

条件节点文法（详见 YAML 头注释）：
    字面量   数字 / 布尔 / {"value": 字符串}
    路径引用 点号路径，如 ``locations.cache.size_mb``
    比较     {op: gt|lt|gte|lte|eq|ne, left, right}
    算术     {op: add|sub|mul|truediv, left, right, multiplier?}
    逻辑     {and: [节点...]} / {or: [节点...]} / {not: 节点}

评估失败（路径缺失、类型不匹配、除零、未知算子）一律返回 False 并记录
告警——规则引擎绝不让单个坏规则打断整体扫描分析。
"""

from __future__ import annotations

import logging
import operator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Union

import yaml

logger = logging.getLogger(__name__)

_CMP_OPS = {
    "gt": operator.gt,
    "lt": operator.lt,
    "gte": operator.ge,
    "lte": operator.le,
    "eq": operator.eq,
    "ne": operator.ne,
}

_ARITH_OPS = {
    "add": operator.add,
    "sub": operator.sub,
    "mul": operator.mul,
    "truediv": operator.truediv,
}

NodeValue = Union[int, float, bool, str, None]


@dataclass
class Rule:
    """单条信号规则。"""

    signal: str
    condition: dict
    description: str = ""


class SafeEvaluator:
    """安全的条件树评估器（无 eval，算子白名单）。

    Args:
        entity: 实体数据字典（aggregator 输出的指纹实体）。
    """

    def __init__(self, entity: dict[str, Any]):
        self.entity = entity

    # ------------------------------------------------------------------
    def get_path(self, path: str) -> Any:
        """按点号路径从实体字典取值；任一层缺失返回 None。"""
        value: Any = self.entity
        for part in path.split("."):
            if isinstance(value, dict):
                value = value.get(part)
            else:
                value = getattr(value, part, None)
            if value is None:
                return None
        return value

    def evaluate(self, node: Any) -> Any:
        """评估节点，任何错误返回 False（安全失败）。"""
        try:
            return self._eval(node)
        except Exception as e:  # noqa: BLE001 — 规则评估必须安全失败
            logger.warning("规则节点评估失败（按 False 处理）: %s: %r", e, node)
            return False

    def _eval(self, node: Any) -> Any:
        # 字面量
        if isinstance(node, bool) or isinstance(node, (int, float)):
            return node
        if node is None:
            return None
        if isinstance(node, str):
            return self.get_path(node)
        if not isinstance(node, dict):
            raise ValueError(f"无法评估的节点: {node!r}")

        # {"value": ...} 字符串字面量转义
        if "value" in node:
            return node["value"]

        # 逻辑组合
        if "and" in node:
            branches = node["and"]
            branches = branches if isinstance(branches, list) else [branches]
            if not branches:
                raise ValueError("and 分支为空")
            return all(bool(self.evaluate(b)) for b in branches)
        if "or" in node:
            branches = node["or"]
            branches = branches if isinstance(branches, list) else [branches]
            if not branches:
                raise ValueError("or 分支为空")
            return any(bool(self.evaluate(b)) for b in branches)
        if "not" in node:
            return not bool(self.evaluate(node["not"]))

        op = node.get("op")
        if op in _ARITH_OPS:
            left = self._numeric(self._eval(node.get("left")), op)
            right = self._numeric(self._eval(node.get("right")), op)
            result = _ARITH_OPS[op](left, right)
            multiplier = node.get("multiplier", 1)
            if multiplier != 1:
                result = result * multiplier
            return result
        if op in _CMP_OPS:
            left = self._eval(node.get("left"))
            right = self._eval(node.get("right"))
            if op in ("gt", "lt", "gte", "lte") and (left is None or right is None):
                return False  # 有序比较遇缺失值 → 不触发
            try:
                return bool(_CMP_OPS[op](left, right))
            except TypeError:
                return False  # str 与 int 等类型不匹配 → 不触发
        raise ValueError(f"未知算子: {op!r}")

    @staticmethod
    def _numeric(value: Any, op: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"算术节点 {op} 的操作数不是数字: {value!r}")
        return value


class RulesEngine:
    """规则集合加载与批量评估。"""

    def __init__(self, rules: Optional[list[Rule]] = None):
        self.rules: list[Rule] = rules or []

    @classmethod
    def from_yaml(cls, path: Path | str) -> "RulesEngine":
        """从 YAML 文件加载规则；文件缺失时返回空引擎（不抛异常）。"""
        p = Path(path)
        if not p.exists():
            logger.warning("规则文件不存在: %s（将无信号产出）", p)
            return cls()
        with open(p, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        rules: list[Rule] = []
        for i, raw in enumerate(data.get("rules", [])):
            try:
                rules.append(
                    Rule(
                        signal=str(raw["signal"]),
                        condition=raw["condition"],
                        description=raw.get("description", ""),
                    )
                )
            except (KeyError, TypeError) as e:
                logger.warning("第 %d 条规则格式非法，已跳过: %s", i, e)
        return cls(rules)

    def evaluate(self, entity: dict[str, Any]) -> list[str]:
        """评估实体的全部规则，返回命中的信号列表（按规则文件顺序）。"""
        ev = SafeEvaluator(entity)
        return [r.signal for r in self.rules if bool(ev.evaluate(r.condition))]

    def describe(self, signal: str) -> str:
        """返回信号的人类可读描述（供 Agent 引用）。"""
        for r in self.rules:
            if r.signal == signal:
                return r.description
        return ""
