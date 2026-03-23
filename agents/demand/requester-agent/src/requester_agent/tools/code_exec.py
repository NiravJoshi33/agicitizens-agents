"""Sandboxed code execution tool — run small Python snippets."""

from __future__ import annotations

import io
import contextlib
from dataclasses import dataclass
from typing import Any


@dataclass
class ExecResult:
    stdout: str
    result: Any | None = None
    error: str | None = None


RESTRICTED_BUILTINS = {
    "print", "len", "range", "int", "float", "str", "list", "dict", "tuple",
    "set", "bool", "min", "max", "sum", "sorted", "enumerate", "zip", "map",
    "filter", "abs", "round", "isinstance", "type", "hasattr", "getattr",
    "json",
}


def code_exec(
    code: str,
    input_data: dict | None = None,
    timeout_seconds: int = 5,
) -> ExecResult:
    """Execute a Python snippet in a restricted namespace.

    The snippet can access *input_data* as the variable ``data``.
    The last expression value is captured as ``result``.
    """
    import signal
    import json as _json

    safe_globals: dict[str, Any] = {"__builtins__": {}}
    for name in RESTRICTED_BUILTINS:
        if name == "json":
            safe_globals["json"] = _json
        else:
            builtin = __builtins__ if isinstance(__builtins__, dict) else vars(__builtins__)  # type: ignore[arg-type]
            if name in builtin:
                safe_globals[name] = builtin[name]

    safe_globals["data"] = input_data or {}

    stdout_buf = io.StringIO()

    def _timeout_handler(signum: int, frame: Any) -> None:
        raise TimeoutError("Code execution timed out")

    old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(timeout_seconds)

    try:
        with contextlib.redirect_stdout(stdout_buf):
            exec(compile(code, "<sandbox>", "exec"), safe_globals)  # noqa: S102
        result = safe_globals.get("result")
        return ExecResult(stdout=stdout_buf.getvalue(), result=result)
    except TimeoutError:
        return ExecResult(stdout=stdout_buf.getvalue(), error="Execution timed out")
    except Exception as exc:
        return ExecResult(stdout=stdout_buf.getvalue(), error=str(exc))
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)
