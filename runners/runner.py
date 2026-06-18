#!/usr/bin/env python3
"""zorb action runner — Python.

Usage:
    runner.py <action-file> <input-file> <result-file>

Protocol mirrors runner.cjs. We keep the context attribute names in camelCase
(setSecret / setEnv / taskName) so workflow authors see the same surface across
languages — Python users will recognise the convention from popular dual-language
SDKs (boto3, GitHub Actions toolkit, etc.).
"""
import importlib.util
import json
import os
import sys
import traceback


def main():
    argv = sys.argv
    if len(argv) != 4:
        sys.stderr.write(
            "runner.py: expected <action-file> <input-file> <result-file>\n",
        )
        sys.exit(2)

    action_file, input_file, result_file = argv[1], argv[2], argv[3]

    try:
        with open(input_file, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as err:
        sys.stderr.write(
            f"runner.py: failed to read input file {input_file}: {err}\n",
        )
        sys.exit(2)

    inputs = payload.get("inputs", {}) or {}
    ctx_info = payload.get("context", {}) or {}

    secrets = []
    env_buf = []

    class _Log:
        def debug(self, msg): sys.stderr.write(f"[debug] {_stringify(msg)}\n")
        def info(self, msg):  sys.stderr.write(f"{_stringify(msg)}\n")
        def warn(self, msg):  sys.stderr.write(f"[warn] {_stringify(msg)}\n")
        def error(self, msg): sys.stderr.write(f"[error] {_stringify(msg)}\n")

    class _Context:
        def __init__(self):
            self.cwd = ctx_info.get("cwd")
            self.taskName = ctx_info.get("taskName")
            self.stepId = ctx_info.get("stepId")
            self.log = _Log()

        def setSecret(self, name, value):
            _assert_str("setSecret", "name", name, non_empty=True)
            _assert_str("setSecret", "value", value, non_empty=False)
            secrets.append({"name": name, "value": value})

        def setEnv(self, name, value):
            _assert_str("setEnv", "name", name, non_empty=True)
            _assert_str("setEnv", "value", value, non_empty=False)
            env_buf.append({"name": name, "value": value})

    ctx = _Context()

    try:
        action_fn = _load_action(action_file)
    except Exception:
        sys.stderr.write("failed to load action:\n")
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)

    try:
        result = action_fn(inputs, ctx)
    except Exception:
        sys.stderr.write(f"action {os.path.basename(action_file)} raised:\n")
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)

    outputs = result if isinstance(result, dict) else {}

    try:
        with open(result_file, "w", encoding="utf-8") as f:
            json.dump({"outputs": outputs, "secrets": secrets, "env": env_buf}, f)
    except Exception as err:
        sys.stderr.write(
            f"runner.py: failed to write result file {result_file}: {err}\n",
        )
        sys.exit(2)


def _load_action(file):
    spec = importlib.util.spec_from_file_location("zorb_action", file)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import action file: {file}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fn = getattr(module, "action", None)
    if not callable(fn):
        raise RuntimeError(f"action file must define an 'action' function: {file}")
    return fn


def _assert_str(fn, arg, value, non_empty):
    if not isinstance(value, str):
        raise TypeError(f"{fn}({arg}): must be a string, got {type(value).__name__}")
    if non_empty and value == "":
        raise TypeError(f"{fn}({arg}): must be a non-empty string")


def _stringify(v):
    if isinstance(v, str):
        return v
    try:
        return json.dumps(v)
    except Exception:
        return str(v)


if __name__ == "__main__":
    main()
