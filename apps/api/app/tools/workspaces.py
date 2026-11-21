"""Canonical workspace resolution with traversal and symlink-escape defense."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import cast

from app.tools.security import mask_secrets

_SENSITIVE_COMPONENT = re.compile(
    r"(?i)(^\.env(?:\..*)?$|^\.git$|^\.ssh$|^\.aws$|^\.gnupg$|"
    r"^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])|.*\.(?:key|pem|p12|pfx)$|"
    r"(^|[._-])(secret|credentials?|token|password|private(?:[_-]?key)?)([._-]|$))"
)
_TEXT_SUFFIXES = {
    ".c",
    ".cfg",
    ".conf",
    ".cpp",
    ".css",
    ".csv",
    ".go",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".py",
    ".rs",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}


class WorkspaceAccessError(Exception):
    def __init__(self, code: str = "workspace_access_denied") -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ApprovedWorkspace:
    workspace_id: str
    display_name: str
    root: Path


@dataclass(frozen=True)
class WorkspaceEntry:
    relative_path: str
    entry_type: str
    size_bytes: int | None


@dataclass(frozen=True)
class WorkspaceMatch:
    relative_path: str
    excerpt: str


class WorkspaceAccess:
    def __init__(
        self,
        configured_roots: list[Path],
        *,
        allowed_file_types: list[str] | None = None,
        max_file_bytes: int = 262_144,
    ) -> None:
        workspaces: dict[str, ApprovedWorkspace] = {}
        for configured_root in configured_roots:
            try:
                root = configured_root.expanduser().resolve(strict=True)
            except OSError:
                continue
            if not root.is_dir():
                continue
            workspace_id = hashlib.sha256(str(root).casefold().encode("utf-8")).hexdigest()[:16]
            workspaces[workspace_id] = ApprovedWorkspace(
                workspace_id=workspace_id,
                display_name=root.name or "workspace",
                root=root,
            )
        self._workspaces = workspaces
        self._allowed_file_types = (
            {extension.casefold() for extension in allowed_file_types}
            if allowed_file_types
            else _TEXT_SUFFIXES
        )
        self._max_file_bytes = max_file_bytes

    @staticmethod
    def _is_link_or_junction(path: Path) -> bool:
        return path.is_symlink() or path.is_junction()

    def list_workspaces(self) -> tuple[ApprovedWorkspace, ...]:
        return tuple(self._workspaces[key] for key in sorted(self._workspaces))

    def get_workspace(self, workspace_id: str) -> ApprovedWorkspace:
        workspace = self._workspaces.get(workspace_id)
        if workspace is None:
            raise WorkspaceAccessError()
        return workspace

    def resolve_path(self, workspace_id: str, relative_path: str) -> Path:
        workspace = self.get_workspace(workspace_id)
        if not relative_path or len(relative_path) > 4096 or "\x00" in relative_path:
            raise WorkspaceAccessError("invalid_workspace_path")

        normalized = relative_path.replace("\\", "/")
        posix_path = PurePosixPath(normalized)
        windows_path = PureWindowsPath(relative_path)
        if posix_path.is_absolute() or windows_path.is_absolute() or windows_path.drive:
            raise WorkspaceAccessError("invalid_workspace_path")
        if any(part == ".." for part in posix_path.parts):
            raise WorkspaceAccessError("invalid_workspace_path")

        candidate = workspace.root.joinpath(*posix_path.parts)
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as exception:
            raise WorkspaceAccessError("workspace_item_unavailable") from exception
        if not resolved.is_relative_to(workspace.root):
            raise WorkspaceAccessError("workspace_access_denied")
        if any(
            _SENSITIVE_COMPONENT.search(part) for part in resolved.relative_to(workspace.root).parts
        ):
            raise WorkspaceAccessError("sensitive_file_denied")
        return resolved

    def list_files(
        self,
        workspace_id: str,
        relative_path: str = ".",
        max_depth: int = 0,
        max_entries: int = 200,
    ) -> list[WorkspaceEntry]:
        root = self.get_workspace(workspace_id).root
        directory = root if relative_path == "." else self.resolve_path(workspace_id, relative_path)
        if not directory.is_dir() or not 0 <= max_depth <= 3:
            raise WorkspaceAccessError("invalid_workspace_path")

        entries: list[WorkspaceEntry] = []
        pending: list[tuple[Path, int]] = [(directory, 0)]
        while pending and len(entries) < max_entries:
            current, depth = pending.pop()
            try:
                children = sorted(os.scandir(current), key=lambda item: item.name.casefold())
            except OSError as exception:
                raise WorkspaceAccessError("workspace_item_unavailable") from exception
            directories: list[tuple[Path, int]] = []
            for child in children:
                child_path = Path(child.path)
                if self._is_link_or_junction(child_path) or child.name.startswith("."):
                    continue
                if _SENSITIVE_COMPONENT.search(child.name):
                    continue
                child_path = Path(child.path)
                relative = child_path.relative_to(root).as_posix()
                if child.is_dir(follow_symlinks=False):
                    entries.append(WorkspaceEntry(relative, "directory", None))
                    if depth < max_depth:
                        directories.append((child_path, depth + 1))
                elif child.is_file(follow_symlinks=False):
                    try:
                        size = child.stat(follow_symlinks=False).st_size
                    except OSError:
                        size = None
                    entries.append(WorkspaceEntry(relative, "file", size))
                if len(entries) >= max_entries:
                    break
            pending.extend(reversed(directories))
        return entries[:max_entries]

    def read_text_file(self, workspace_id: str, relative_path: str, max_bytes: int) -> str:
        path = self.resolve_path(workspace_id, relative_path)
        if not path.is_file() or path.suffix.lower() not in self._allowed_file_types:
            raise WorkspaceAccessError("text_file_required")
        try:
            if path.stat().st_size > min(max_bytes, self._max_file_bytes):
                raise WorkspaceAccessError("file_too_large")
            contents = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exception:
            raise WorkspaceAccessError("unsupported_text_encoding") from exception
        except OSError as exception:
            raise WorkspaceAccessError("workspace_item_unavailable") from exception
        return cast(str, mask_secrets(contents))

    def write_text_file(
        self, workspace_id: str, relative_path: str, contents: str, max_bytes: int
    ) -> int:
        path = self._resolve_write_path(workspace_id, relative_path)
        if path.suffix.lower() not in self._allowed_file_types:
            raise WorkspaceAccessError("text_file_required")
        encoded = contents.encode("utf-8")
        if len(encoded) > min(max_bytes, self._max_file_bytes):
            raise WorkspaceAccessError("file_too_large")
        if path.exists() and not path.is_file():
            raise WorkspaceAccessError("file_operation_not_supported")

        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=path.parent, prefix=".jarvis-", suffix=".tmp", delete=False
            ) as temporary_file:
                temporary_path = temporary_file.name
                temporary_file.write(encoded)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary_path, path)
        except OSError as exception:
            raise WorkspaceAccessError("workspace_item_unavailable") from exception
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)
        return len(encoded)

    def delete_file(self, workspace_id: str, relative_path: str) -> None:
        path = self._resolve_write_path(workspace_id, relative_path)
        try:
            if not path.is_file():
                raise WorkspaceAccessError("file_operation_not_supported")
            if not self._is_link_or_junction(path):
                path.unlink()
        except OSError as exception:
            raise WorkspaceAccessError("workspace_item_unavailable") from exception

    def search_text(
        self,
        workspace_id: str,
        query: str,
        *,
        max_files: int = 100,
        max_file_bytes: int = 32_768,
        max_matches: int = 20,
    ) -> list[WorkspaceMatch]:
        if not query.strip() or len(query) > 200:
            raise WorkspaceAccessError("invalid_search_query")
        matches: list[WorkspaceMatch] = []
        entries = self.list_files(workspace_id, max_depth=3, max_entries=max_files)
        for entry in entries:
            if (
                entry.entry_type != "file"
                or Path(entry.relative_path).suffix.lower() not in self._allowed_file_types
            ):
                continue
            try:
                contents = self.read_text_file(
                    workspace_id,
                    entry.relative_path,
                    max_bytes=min(max_file_bytes, self._max_file_bytes),
                )
            except WorkspaceAccessError as exception:
                if exception.code in {"file_too_large", "text_file_required"}:
                    continue
                raise
            matching_line = next(
                (
                    line.strip()
                    for line in contents.splitlines()
                    if query.casefold() in line.casefold()
                ),
                None,
            )
            if matching_line is not None:
                matches.append(
                    WorkspaceMatch(
                        relative_path=entry.relative_path,
                        excerpt=matching_line[:500],
                    )
                )
                if len(matches) >= max_matches:
                    break
        return matches

    def _resolve_write_path(self, workspace_id: str, relative_path: str) -> Path:
        workspace = self.get_workspace(workspace_id)
        if not relative_path or len(relative_path) > 4096 or "\x00" in relative_path:
            raise WorkspaceAccessError("invalid_workspace_path")
        normalized = relative_path.replace("\\", "/")
        posix_path = PurePosixPath(normalized)
        windows_path = PureWindowsPath(relative_path)
        if (
            posix_path.is_absolute()
            or windows_path.is_absolute()
            or windows_path.drive
            or any(part in {".", ".."} for part in posix_path.parts)
        ):
            raise WorkspaceAccessError("invalid_workspace_path")
        if any(_SENSITIVE_COMPONENT.search(part) for part in posix_path.parts):
            raise WorkspaceAccessError("sensitive_file_denied")

        candidate = workspace.root.joinpath(*posix_path.parts)
        try:
            current = workspace.root
            for part in posix_path.parts:
                current = current / part
                if self._is_link_or_junction(current):
                    raise WorkspaceAccessError("workspace_access_denied")
            resolved = candidate.resolve(strict=False)
            parent = resolved.parent.resolve(strict=True)
        except WorkspaceAccessError:
            raise
        except OSError as exception:
            raise WorkspaceAccessError("workspace_item_unavailable") from exception
        if not resolved.is_relative_to(workspace.root) or not parent.is_relative_to(workspace.root):
            raise WorkspaceAccessError("workspace_access_denied")
        if not parent.is_dir():
            raise WorkspaceAccessError("invalid_workspace_path")
        return resolved
