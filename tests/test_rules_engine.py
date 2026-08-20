"""rules_engine.py 安全评估器与规则加载测试。"""

import pytest

from disk_sense.config import RULES_FILE
from disk_sense.rules_engine import RulesEngine, SafeEvaluator

E = {  # 一个典型实体的最小数据形状（aggregator 输出）
    "id": "wechat",
    "total_size_mb": 4250,
    "last_access_days": 45,
    "location_anomaly": False,
    "locations": {
        "program_base": {"size_mb": 120, "file_count": 180, "has_exe": True},
        "user_data": {"size_mb": 1800, "file_count": 3200, "has_exe": False},
        "cache": {"size_mb": 2330, "file_count": 450, "has_exe": False},
        "logs": {"size_mb": 10, "file_count": 5, "has_exe": False},
    },
}


def _entity(**over) -> dict:
    """复制模板实体并按角色覆写 size/has_exe。"""
    e = {
        "id": "x",
        "total_size_mb": 0,
        "last_access_days": 1,
        "location_anomaly": False,
        "locations": {
            "program_base": {"size_mb": 0, "file_count": 0, "has_exe": False},
            "user_data": {"size_mb": 0, "file_count": 0, "has_exe": False},
            "cache": {"size_mb": 0, "file_count": 0, "has_exe": False},
            "logs": {"size_mb": 0, "file_count": 0, "has_exe": False},
        },
    }
    for role, val in over.items():
        if role in e["locations"]:
            e["locations"][role] = {"size_mb": val, "file_count": 1, "has_exe": False}
        else:
            e[role] = val
    e["total_size_mb"] = sum(v["size_mb"] for v in e["locations"].values())
    return e


class TestSafeEvaluator:
    def ev(self, node, entity=E):
        return SafeEvaluator(entity).evaluate(node)

    # ---- 比较 ----
    def test_gt_true_false(self):
        assert self.ev({"op": "gt", "left": "total_size_mb", "right": 1000}) is True
        assert self.ev({"op": "gt", "left": "total_size_mb", "right": 99999}) is False

    def test_gte_lte_lt(self):
        assert self.ev({"op": "gte", "left": "total_size_mb", "right": 4250}) is True
        assert self.ev({"op": "lte", "left": "total_size_mb", "right": 4250}) is True
        assert self.ev({"op": "lt", "left": "total_size_mb", "right": 4250}) is False

    def test_eq_bool(self):
        assert self.ev({"op": "eq", "left": "location_anomaly", "right": True}) is False
        assert self.ev({"op": "eq", "left": "locations.cache.has_exe", "right": False}) is True

    def test_ne(self):
        assert self.ev({"op": "ne", "left": "id", "right": {"value": "qq"}}) is True

    def test_missing_path_ordered_cmp_false(self):
        assert self.ev({"op": "gt", "left": "no.such.path", "right": 1}) is False

    def test_type_mismatch_safe(self):
        assert self.ev({"op": "gt", "left": "id", "right": 5}) is False  # str vs int

    # ---- 算术 ----
    def test_nested_arithmetic(self):
        # (pb + ud) * 1.5 = (120 + 1800) * 1.5 = 2880
        node = {
            "op": "mul",
            "left": {
                "op": "add",
                "left": "locations.program_base.size_mb",
                "right": "locations.user_data.size_mb",
            },
            "right": 1.5,
        }
        assert self.ev(node) == pytest.approx(2880)
        # cache 2330 < 2880 → 不触发
        assert self.ev({"op": "gt", "left": "locations.cache.size_mb", "right": node}) is False

    def test_multiplier(self):
        assert self.ev({"op": "add", "left": 10, "right": 20, "multiplier": 2}) == pytest.approx(60)

    def test_div_by_zero_safe(self):
        assert self.ev({"op": "truediv", "left": 10, "right": 0}) is False

    def test_arith_on_non_numeric_fails_closed(self):
        assert self.ev({"op": "add", "left": "id", "right": 1}) is False

    # ---- 逻辑 ----
    def test_and_list(self):
        node = {
            "and": [
                {"op": "gt", "left": "total_size_mb", "right": 1000},
                {"op": "gt", "left": "last_access_days", "right": 10},
            ]
        }
        assert self.ev(node) is True
        node["and"][1] = {"op": "gt", "left": "last_access_days", "right": 9999}
        assert self.ev(node) is False

    def test_and_single_dict_form(self):
        assert self.ev({"and": {"op": "gt", "left": "total_size_mb", "right": 1}}) is True

    def test_or(self):
        node = {"or": [
            {"op": "gt", "left": "total_size_mb", "right": 99999},
            {"op": "gt", "left": "total_size_mb", "right": 1},
        ]}
        assert self.ev(node) is True

    def test_not(self):
        assert self.ev({"not": {"op": "gt", "left": "total_size_mb", "right": 1}}) is False

    # ---- 字面量转义与安全兜底 ----
    def test_value_literal(self):
        node = {"op": "eq", "left": {"value": "total_size_mb"}, "right": {"value": "total_size_mb"}}
        assert self.ev(node) is True

    def test_unknown_op_fails_closed(self):
        assert self.ev({"op": "eval", "left": "__import__", "right": 0}) is False

    def test_garbage_node_fails_closed(self):
        assert self.ev({"nonsense": True}) is False
        assert self.ev([1, 2, 3]) is False


class TestRulesEngine:
    def test_load_repo_rules(self):
        eng = RulesEngine.from_yaml(RULES_FILE)
        assert len(eng.rules) >= 8
        signals = [r.signal for r in eng.rules]
        assert len(set(signals)) == len(signals)  # 信号不重复
        assert eng.describe("CACHE_DOMINANT")

    def test_missing_file_empty_engine(self, tmp_path):
        eng = RulesEngine.from_yaml(tmp_path / "nope.yaml")
        assert eng.rules == []
        assert eng.evaluate(E) == []

    def test_cache_dominant_and_large_entity(self):
        """方案书 §7.3 微信式的缓存膨胀场景。"""
        eng = RulesEngine.from_yaml(RULES_FILE)
        e = _entity(program_base=120, user_data=1800, cache=5000, logs=10)
        hits = eng.evaluate(e)
        assert "CACHE_DOMINANT" in hits  # 5000 > (120+1800)*1.5 = 2880
        assert "LARGE_ENTITY" not in hits  # 总量 6930 < 10240
        huge = _entity(program_base=9000, cache=2000)
        assert "LARGE_ENTITY" in eng.evaluate(huge)

    def test_exe_missing_and_orphan(self):
        eng = RulesEngine.from_yaml(RULES_FILE)
        # EXE_MISSING：安装目录 >10MB 却无 exe
        assert "EXE_MISSING" in eng.evaluate(_entity(program_base=30, user_data=770))
        # ORPHAN_USER_DATA：完全无安装目录（pb=0）但用户数据 >300MB
        assert "ORPHAN_USER_DATA" in eng.evaluate(_entity(user_data=770))

    def test_exe_present_no_exe_missing(self):
        eng = RulesEngine.from_yaml(RULES_FILE)
        e = _entity(program_base=30, user_data=770)
        e["locations"]["program_base"]["has_exe"] = True
        assert "EXE_MISSING" not in eng.evaluate(e)

    def test_ancient_stale_anomaly(self):
        eng = RulesEngine.from_yaml(RULES_FILE)
        e = _entity(program_base=3000, user_data=1500, cache=400, logs=100)
        e["last_access_days"] = 200
        e["location_anomaly"] = True
        hits = eng.evaluate(e)
        assert "ANCIENT_DATA" in hits
        assert "STALE_CACHE" in hits
        assert "LOCATION_ANOMALY" in hits

    def test_log_heavy(self):
        eng = RulesEngine.from_yaml(RULES_FILE)
        assert "LOG_HEAVY" in eng.evaluate(_entity(logs=600))

    def test_healthy_entity_no_signals(self):
        eng = RulesEngine.from_yaml(RULES_FILE)
        e = _entity(program_base=2000, user_data=100)
        e["locations"]["program_base"]["has_exe"] = True
        assert eng.evaluate(e) == []
