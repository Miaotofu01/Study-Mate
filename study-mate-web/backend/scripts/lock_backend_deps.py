"""生成 / 校验 backend 的可复现依赖锁（uv universal + hash，单套方案）。

产物：
  requirements.lock.txt       ← requirements.txt（运行时）
  requirements-dev.lock.txt   ← requirements-dev.txt（测试，用运行时锁做约束，版本一致）

用 uv 做 **universal 解析**：一次产出带环境 markers 与各平台 wheel hash 的锁，Windows
本地与 Ubuntu CI 都能 `pip install --require-hashes`。锁只引用公共 PyPI 的包与 hash，
不含源码或密钥；不读也不改 backend/.venv。

用法（在 backend/ 下，用任意本机 Python 3.13 运行即可）：
    python scripts/lock_backend_deps.py            # 重新生成两个锁，并在干净临时 venv 校验
    python scripts/lock_backend_deps.py --verify   # 只校验现有锁
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import venv
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
RUNTIME_REQ = BACKEND / "requirements.txt"
DEV_REQ = BACKEND / "requirements-dev.txt"
RUNTIME_LOCK = BACKEND / "requirements.lock.txt"
DEV_LOCK = BACKEND / "requirements-dev.lock.txt"
PYTHON_VERSION = "3.13"
# 运行时锁 + 测试依赖的导入冒烟：覆盖所有带扩展/数据文件的关键包
SMOKE_IMPORTS = (
    "fastapi, uvicorn, openai, httpx, pydantic, yaml, jsonschema, "
    "fitz, docx, openpyxl, pptx, multipart, sse_starlette, pytest"
)


def _run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, text=True, cwd=BACKEND)


def _uv() -> str:
    uv = shutil.which("uv")
    if not uv:
        sys.exit("未找到 uv；本脚本只用 uv 做 universal 解析，不安装 pip-tools。")
    return uv


def _compile(uv: str, source: Path, output: Path, command: str, constraints: Path | None) -> None:
    cmd = [
        uv, "pip", "compile",
        "--universal", "--generate-hashes",
        "--python-version", PYTHON_VERSION,
        "--custom-compile-command", command,
        "--output-file", str(output),
    ]
    if constraints is not None:
        cmd += ["--constraints", str(constraints)]
    cmd.append(str(source))
    _run(cmd)


def generate() -> None:
    uv = _uv()
    version = subprocess.run(
        [uv, "--version"], check=True, text=True, capture_output=True
    ).stdout.strip()
    runtime_cmd = (
        f"uv pip compile --universal --generate-hashes --python-version {PYTHON_VERSION} "
        f"-o {RUNTIME_LOCK.name} {RUNTIME_REQ.name}"
    )
    dev_cmd = (
        f"uv pip compile --universal --generate-hashes --python-version {PYTHON_VERSION} "
        f"-c {RUNTIME_LOCK.name} -o {DEV_LOCK.name} {DEV_REQ.name}"
    )
    _compile(uv, RUNTIME_REQ, RUNTIME_LOCK, runtime_cmd, constraints=None)
    # dev 锁以 runtime 锁为约束重新解析：保证 pytest/httpx 与运行时依赖同版本，两边不打架
    _compile(uv, DEV_REQ, DEV_LOCK, dev_cmd, constraints=RUNTIME_LOCK)
    for path in (RUNTIME_LOCK, DEV_LOCK):
        text = path.read_text(encoding="utf-8")
        if "# uv:" not in text:
            path.write_text(f"# uv: {version}\n{text}", encoding="utf-8")
    print(f"\n已生成 {RUNTIME_LOCK.name} 与 {DEV_LOCK.name}（{version}）")


def _install_lock(tmp: str, name: str, lock: Path) -> Path:
    env_dir = Path(tmp) / f"venv-{name}"
    venv.EnvBuilder(with_pip=True).create(env_dir)
    py = env_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    _run([str(py), "-m", "pip", "install", "--require-hashes", "-r", str(lock)])
    _run([str(py), "-m", "pip", "check"])
    return py


def verify() -> None:
    """在两个唯一 mkdtemp 新 venv 里分别用 pip --require-hashes 装 runtime / dev 锁并冒烟。"""
    with tempfile.TemporaryDirectory(prefix="studymate-lock-verify-") as tmp:
        dev_py = _install_lock(tmp, "dev", DEV_LOCK)
        _run([str(dev_py), "-c", f"import {SMOKE_IMPORTS}; print('dev imports ok')"])
        runtime_py = _install_lock(tmp, "runtime", RUNTIME_LOCK)
        # 运行时分支必须能 import httpx：app.llm 首选 httpx，httpx2 只是兜底。
        # 若运行时锁只随 openai 装到 httpx2，生产会走 fallback，与 CI（dev 锁有 httpx）不一致。
        _run(
            [
                str(runtime_py),
                "-c",
                "import httpx, httpx2\n"
                "from app import llm\n"
                "assert llm.httpx.__name__ == 'httpx', llm.httpx.__name__\n"
                "print('runtime llm uses httpx')",
            ]
        )
    print(f"\n锁校验通过：runtime / dev 均干净 venv 安装 + pip check + import 冒烟")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="只校验现有锁，不重新生成")
    args = parser.parse_args()
    if args.verify:
        verify()
    else:
        generate()
        verify()


if __name__ == "__main__":
    main()
