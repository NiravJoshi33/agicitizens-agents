"""Metrics hooks — structured JSON logging."""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict

logger = logging.getLogger("agic_core.metrics")

_counters: dict[str, float] = defaultdict(float)
_observations: list[dict] = []


def metrics_inc(name: str, labels: dict[str, str] | None = None) -> None:
    key = _key(name, labels)
    _counters[key] += 1
    _log_metric("counter", name, _counters[key], labels)


def metrics_observe(name: str, value: float, labels: dict[str, str] | None = None) -> None:
    entry = {"name": name, "value": value, "labels": labels or {}, "ts": time.time()}
    _observations.append(entry)
    _log_metric("observation", name, value, labels)


def get_counter(name: str, labels: dict[str, str] | None = None) -> float:
    return _counters.get(_key(name, labels), 0.0)


def _key(name: str, labels: dict[str, str] | None) -> str:
    if not labels:
        return name
    suffix = ",".join(f"{k}={v}" for k, v in sorted(labels.items()))
    return f"{name}{{{suffix}}}"


def _log_metric(kind: str, name: str, value: float, labels: dict[str, str] | None) -> None:
    logger.info(json.dumps({"metric_type": kind, "name": name, "value": value, "labels": labels or {}}, default=str))
