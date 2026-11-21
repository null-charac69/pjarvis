from pathlib import Path

import pytest
from app.tools.security import mask_secrets, validate_approved_website
from app.tools.workspaces import WorkspaceAccess, WorkspaceAccessError
from pydantic import AnyHttpUrl


def _access(root: Path) -> tuple[WorkspaceAccess, str]:
    root.mkdir(parents=True, exist_ok=True)
    access = WorkspaceAccess([root])
    return access, access.list_workspaces()[0].workspace_id


@pytest.mark.parametrize(
    "path",
    [
        "../outside.txt",
        "sub/../../outside.txt",
        "folder/../outside.txt",
        "%2e%2e/outside.txt",
        "C:\\secret.txt",
        "\\\\server\\share\\file.txt",
    ],
)
def test_workspace_rejects_traversal_and_absolute_paths(tmp_path: Path, path: str) -> None:
    access, workspace_id = _access(tmp_path / "approved")

    with pytest.raises(WorkspaceAccessError):
        access.resolve_path(workspace_id, path)


def test_workspace_rejects_symlink_escape(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "approved"
    outside = tmp_path / "outside.txt"
    outside.write_text("private", encoding="utf-8")
    access, workspace_id = _access(root)
    escape_path = root / "escape.txt"
    original_resolve = type(root).resolve

    def resolve_with_escape(self: Path, strict: bool = False) -> Path:
        if self == escape_path:
            return outside
        return original_resolve(self, strict=strict)

    monkeypatch.setattr(type(root), "resolve", resolve_with_escape)

    with pytest.raises(WorkspaceAccessError):
        access.resolve_path(workspace_id, "escape.txt")


def test_workspace_listing_and_write_reject_junctions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    junction = workspace / "linked-directory"
    junction.mkdir(parents=True)
    (junction / "outside.txt").write_text("outside", encoding="utf-8")
    access = WorkspaceAccess([workspace])
    workspace_id = access.list_workspaces()[0].workspace_id
    original_is_junction = Path.is_junction

    def mark_junction(path: Path) -> bool:
        return path.name == "linked-directory" or original_is_junction(path)

    monkeypatch.setattr(Path, "is_junction", mark_junction)

    assert all(item.relative_path != "linked-directory" for item in access.list_files(workspace_id))
    with pytest.raises(WorkspaceAccessError, match="workspace_access_denied"):
        access.write_text_file(workspace_id, "linked-directory/new.txt", "blocked", max_bytes=1024)


def test_workspace_hides_secret_files_and_masks_secret_values(tmp_path: Path) -> None:
    root = tmp_path / "approved"
    access, workspace_id = _access(root)
    (root / ".env").write_text("TOKEN=secret-value", encoding="utf-8")
    (root / "notes.txt").write_text("api_key=secret-value\nhello", encoding="utf-8")

    listed = access.list_files(workspace_id)
    contents = access.read_text_file(workspace_id, "notes.txt", max_bytes=100)

    assert [entry.relative_path for entry in listed] == ["notes.txt"]
    assert "secret-value" not in contents
    assert "[REDACTED]" in contents
    with pytest.raises(WorkspaceAccessError):
        access.read_text_file(workspace_id, ".env", max_bytes=100)


def test_workspace_applies_configured_file_types_and_size_limit(tmp_path: Path) -> None:
    root = tmp_path / "approved"
    root.mkdir()
    access = WorkspaceAccess([root], allowed_file_types=[".md"], max_file_bytes=8)
    workspace_id = access.list_workspaces()[0].workspace_id
    (root / "notes.md").write_text("123456789", encoding="utf-8")
    (root / "notes.txt").write_text("ok", encoding="utf-8")

    with pytest.raises(WorkspaceAccessError, match="file_too_large"):
        access.read_text_file(workspace_id, "notes.md", max_bytes=100)
    with pytest.raises(WorkspaceAccessError, match="text_file_required"):
        access.read_text_file(workspace_id, "notes.txt", max_bytes=100)
    with pytest.raises(WorkspaceAccessError, match="file_too_large"):
        access.write_text_file(workspace_id, "new.md", "123456789", max_bytes=100)


def test_workspace_hides_credentials_and_private_key_files(tmp_path: Path) -> None:
    root = tmp_path / "approved"
    access, workspace_id = _access(root)
    (root / "credentials.json").write_text("{}", encoding="utf-8")
    (root / "id_rsa").write_text("private key", encoding="utf-8")
    (root / "signing-key.pem").write_text("private key", encoding="utf-8")
    (root / "notes.txt").write_text("ordinary text", encoding="utf-8")

    entries = access.list_files(workspace_id)

    assert [entry.relative_path for entry in entries] == ["notes.txt"]
    for sensitive_path in ("credentials.json", "id_rsa", "signing-key.pem"):
        with pytest.raises(WorkspaceAccessError):
            access.resolve_path(workspace_id, sensitive_path)


def test_workspace_write_replaces_text_atomically_and_rejects_unsafe_paths(
    tmp_path: Path,
) -> None:
    root = tmp_path / "approved"
    access, workspace_id = _access(root)
    (root / "notes.txt").write_text("old", encoding="utf-8")

    written = access.write_text_file(workspace_id, "notes.txt", "new content", max_bytes=100)

    assert written == len("new content")
    assert (root / "notes.txt").read_text(encoding="utf-8") == "new content"
    with pytest.raises(WorkspaceAccessError):
        access.write_text_file(workspace_id, "../outside.txt", "blocked", max_bytes=100)
    with pytest.raises(WorkspaceAccessError):
        access.write_text_file(workspace_id, ".env", "blocked", max_bytes=100)


def test_workspace_write_rejects_symlink_escape_and_oversized_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "approved"
    outside = tmp_path / "outside"
    outside.mkdir()
    access, workspace_id = _access(root)
    link = root / "linked"
    original_is_symlink = Path.is_symlink

    def fake_is_symlink(path: Path) -> bool:
        return path == link or original_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", fake_is_symlink)
    with pytest.raises(WorkspaceAccessError):
        access.write_text_file(workspace_id, "linked/notes.txt", "blocked", max_bytes=100)
    with pytest.raises(WorkspaceAccessError):
        access.write_text_file(workspace_id, "large.txt", "too large", max_bytes=2)


def test_workspace_delete_is_single_file_and_search_redacts_matches(tmp_path: Path) -> None:
    root = tmp_path / "approved"
    access, workspace_id = _access(root)
    (root / "notes.txt").write_text("api_key=private-value\nsearchable note", encoding="utf-8")
    (root / "nested").mkdir()

    matches = access.search_text(workspace_id, "searchable")
    access.delete_file(workspace_id, "notes.txt")

    assert len(matches) == 1
    assert "private-value" not in matches[0].excerpt
    assert not (root / "notes.txt").exists()
    with pytest.raises(WorkspaceAccessError):
        access.delete_file(workspace_id, "nested")


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "http://example.com",
        "https://user:pass@example.com",
        "https://127.0.0.1",
    ],
)
def test_website_policy_rejects_unsafe_or_unapproved_urls(url: str) -> None:
    with pytest.raises(ValueError):
        validate_approved_website(url, [AnyHttpUrl("https://example.com")])


def test_website_policy_requires_exact_approved_https_origin() -> None:
    allowed = [AnyHttpUrl("https://docs.example.com")]

    assert validate_approved_website("https://docs.example.com/guide", allowed) == (
        "https://docs.example.com/guide"
    )
    with pytest.raises(ValueError):
        validate_approved_website("https://sub.docs.example.com/guide", allowed)


def test_secret_masking_handles_nested_values_and_private_keys() -> None:
    masked = mask_secrets(
        {
            "apiKey": "known-secret",
            "contents": "private file body",
            "message": "Authorization: Bearer abc123 and token=another-secret",
            "pem": "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        }
    )

    assert "known-secret" not in str(masked)
    assert "private file body" not in str(masked)
    assert "abc123" not in str(masked)
    assert "another-secret" not in str(masked)
    assert "-----BEGIN PRIVATE KEY-----" not in str(masked)
