#!/usr/bin/env python3
"""Build the immutable, deterministic Linux distribution; never publish it.

Run npm ci --ignore-scripts --no-audit --no-fund first.
Only src/, production node_modules/, and explicit package/document files enter
the archive. No journals, keys, tests, private fixtures, or environment files do.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tarfile


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def archive_members(root: Path, dev_roots: set[str]) -> list[Path]:
    entries = []
    for relative in ("package.json", "package-lock.json", "README.md", "LICENSE", "src", "node_modules"):
        path = root / relative
        if not path.exists():
            raise SystemExit(f"Missing required release input: {relative}")
        entries.append(path)
        if path.is_dir():
            for directory, dirs, files in os.walk(path, followlinks=False):
                dirs[:] = sorted(d for d in dirs if d not in {".cache", ".bin"}
                                 and (Path(directory) / d).relative_to(root).as_posix() not in dev_roots)
                for name in sorted(dirs + files):
                    candidate = Path(directory) / name
                    if candidate.relative_to(root).as_posix() == "node_modules/.package-lock.json":
                        continue
                    entries.append(candidate)
    unique = sorted(set(entries), key=lambda p: p.relative_to(root).as_posix())
    for path in unique:
        mode = path.lstat().st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
            raise SystemExit(f"Unsupported release input type: {path.relative_to(root)}")
        if path.is_symlink():
            try:
                path.resolve(strict=True).relative_to(root)
            except (ValueError, FileNotFoundError):
                raise SystemExit(f"Release symlink leaves the project or is broken: {path.relative_to(root)}")
        if path.name in {".env", "nosana_key.json"} or path.name.endswith(".key.json"):
            raise SystemExit(f"Refusing credential-like release input: {path.relative_to(root)}")
    return unique


def normalize(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    info.pax_headers = {}
    if info.isdir():
        info.mode = 0o755
    elif info.issym():
        info.mode = 0o777
    else:
        info.mode = 0o755 if info.mode & 0o111 else 0o644
    return info


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--write-launcher", action="store_true", help="Update the tracked launcher after candidate freeze")
    args = parser.parse_args()
    root = args.root.resolve()
    output = (args.output or root / "dist").resolve()
    package = json.loads((root / "package.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    version = package["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise SystemExit("Release version is not a supported semantic version")
    if lock.get("packages", {}).get("", {}).get("dependencies") != package.get("dependencies"):
        raise SystemExit("package-lock.json does not match package.json dependencies")
    if not (root / "src/cli.mjs").is_file():
        raise SystemExit("Missing src/cli.mjs")
    for relative, locked in lock.get("packages", {}).items():
        if not relative or locked.get("dev"):
            continue
        installed_path = root / relative / "package.json"
        if locked.get("optional") and not installed_path.exists():
            continue
        installed = json.loads(installed_path.read_text())
        if installed["version"] != locked["version"]:
            raise SystemExit(f"Installed version does not match lock: {relative}")
    dev_roots = {relative for relative, locked in lock.get("packages", {}).items() if locked.get("dev")}
    members = archive_members(root, dev_roots)
    output.mkdir(parents=True, exist_ok=True)
    archive_name = f"nosana-job-finish-{version}.tar.gz"
    archive = output / archive_name
    with archive.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as tar:
                top = normalize(tarfile.TarInfo("nosana-job-finish"))
                top.type = tarfile.DIRTYPE
                top.mode = 0o755
                tar.addfile(top)
                for path in members:
                    name = "nosana-job-finish/" + path.relative_to(root).as_posix()
                    tar.add(path, arcname=name, recursive=False, filter=normalize)
    digest = sha256(archive)
    template = (root / "tools/launcher-template.sh").read_text()
    launcher_text = template.replace("@TOOL_VERSION@", version).replace("@TOOL_SHA256@", digest).replace("@TOOL_FILE@", archive_name)
    if re.search(r"@TOOL_[A-Z0-9_]+@", launcher_text):
        raise SystemExit("Unresolved launcher template variable")
    launcher = output / "nosana-job-finish.sh"
    launcher.write_text(launcher_text)
    launcher.chmod(0o755)
    if args.write_launcher:
        tracked_launcher = root / "nosana-job-finish.sh"
        tracked_launcher.write_text(launcher_text)
        tracked_launcher.chmod(0o755)
    manifest = {
        "name": package["name"], "version": version,
        "archive": {"file": archive_name, "bytes": archive.stat().st_size, "sha256": digest},
        "launcher": {"file": launcher.name, "sha256": sha256(launcher)},
        "packageLockSha256": sha256(root / "package-lock.json"),
        "sourceSha256": {p.relative_to(root).as_posix(): sha256(p) for p in members
                         if p.is_file() and not p.is_symlink() and p.relative_to(root).parts[0] != "node_modules"},
        "nodeRuntime": {"version": "24.22.2", "checksumSource": "https://nodejs.org/dist/v24.22.2/SHASUMS256.txt",
                        "linux-x64.tar.gz": "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9",
                        "linux-arm64.tar.gz": "95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2"},
    }
    (output / "BUILD-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "SHA256SUMS").write_text(f"{digest}  {archive_name}\n{sha256(launcher)}  {launcher.name}\n")
    print(json.dumps(manifest["archive"]))


if __name__ == "__main__":
    main()
