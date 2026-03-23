"""JSON validation & OpenAPI action validation via Pydantic."""

from __future__ import annotations

import logging
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


def validate_payload(model: type[T], data: Any) -> tuple[T | None, str | None]:
    """Validate data against a Pydantic model.

    Returns (instance, None) on success, (None, error_detail) on failure.
    """
    try:
        return model.model_validate(data), None
    except ValidationError as exc:
        detail = exc.json()
        logger.warning("Validation failed for %s: %s", model.__name__, detail)
        return None, detail


class OpenAPIValidator:
    """Validates HttpAction instances against a parsed OpenAPI spec."""

    def __init__(self, spec: dict[str, Any]) -> None:
        self._spec = spec
        self._operations = self._index_operations()

    def _index_operations(self) -> dict[str, dict[str, Any]]:
        """Build a lookup of (METHOD, path_template) -> operation."""
        ops: dict[str, dict[str, Any]] = {}
        paths = self._spec.get("paths", {})
        for path_template, methods in paths.items():
            for method, operation in methods.items():
                if method.upper() in ("GET", "POST", "PUT", "DELETE", "PATCH"):
                    key = f"{method.upper()} {path_template}"
                    ops[key] = {
                        "path": path_template,
                        "method": method.upper(),
                        **operation,
                    }
        return ops

    def validate_action(self, method: str, path: str) -> tuple[bool, str]:
        """Check that method + path matches a defined operation.

        Returns (True, "") on match, (False, reason) otherwise.
        """
        # Try exact match first
        key = f"{method.upper()} {path}"
        if key in self._operations:
            return True, ""

        # Try matching with path params (e.g. /tasks/{taskId})
        for op_key, op in self._operations.items():
            op_method, op_path = op_key.split(" ", 1)
            if op_method != method.upper():
                continue
            if self._path_matches(op_path, path):
                return True, ""

        return False, f"No operation found for {method.upper()} {path}"

    def get_operations_for_tag(self, tag: str) -> list[dict[str, Any]]:
        """Return all operations matching a given tag."""
        return [
            op
            for op in self._operations.values()
            if tag in op.get("tags", [])
        ]

    def get_all_operations(self) -> list[dict[str, Any]]:
        return list(self._operations.values())

    @staticmethod
    def _path_matches(template: str, actual: str) -> bool:
        """Check if an actual path matches an OpenAPI path template."""
        t_parts = template.strip("/").split("/")
        a_parts = actual.strip("/").split("/")
        if len(t_parts) != len(a_parts):
            return False
        return all(
            tp.startswith("{") or tp == ap for tp, ap in zip(t_parts, a_parts)
        )
