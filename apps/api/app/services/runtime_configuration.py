"""Atomic persistence for the non-secret setup profile."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.core.runtime_config import RuntimeConfiguration


class RuntimeConfigurationConflict(Exception):
    """The saved profile changed since the caller last read it."""


class RuntimeConfigurationStore:
    def __init__(self, data_directory: Path) -> None:
        self._directory = data_directory.expanduser().resolve()
        self._profile_path = self._directory / "runtime-config.json"
        self._rollback_path = self._directory / "runtime-config.rollback.json"
        self._audit_path = self._directory / "configuration-audit.jsonl"
        self._lock = threading.RLock()

    def read(self) -> tuple[RuntimeConfiguration, str]:
        with self._lock:
            if not self._profile_path.exists():
                profile = RuntimeConfiguration()
                return profile, self._revision(profile.model_dump(mode="json", by_alias=True))
            profile = RuntimeConfiguration.model_validate_json(
                self._profile_path.read_text(encoding="utf-8")
            )
            return profile, self._revision(profile.model_dump(mode="json", by_alias=True))

    def save(
        self,
        profile: RuntimeConfiguration,
        *,
        expected_revision: str,
        actor: str,
    ) -> str:
        with self._lock:
            current, revision = self.read()
            if expected_revision != revision:
                raise RuntimeConfigurationConflict
            rollback = {
                "exists": self._profile_path.exists(),
                "configuration": current.model_dump(mode="json", by_alias=True),
            }
            self._atomic_write(self._rollback_path, json.dumps(rollback, sort_keys=True))
            serialized = json.dumps(
                profile.model_dump(mode="json", by_alias=True), sort_keys=True, indent=2
            )
            self._atomic_write(self._profile_path, serialized)
            next_revision = self._revision(profile.model_dump(mode="json", by_alias=True))
            self._write_audit(
                action="save",
                actor=actor,
                revision=next_revision,
                sections=self._changed_sections(current, profile),
                profile=profile,
            )
            return next_revision

    def rollback(self, *, expected_revision: str, actor: str) -> str:
        with self._lock:
            current, revision = self.read()
            if expected_revision != revision:
                raise RuntimeConfigurationConflict
            if not self._rollback_path.is_file():
                raise FileNotFoundError("No saved configuration change is available to roll back.")
            snapshot = json.loads(self._rollback_path.read_text(encoding="utf-8"))
            previous = RuntimeConfiguration.model_validate(snapshot["configuration"])
            if snapshot["exists"]:
                serialized = json.dumps(
                    previous.model_dump(mode="json", by_alias=True), sort_keys=True, indent=2
                )
                self._atomic_write(self._profile_path, serialized)
            else:
                self._profile_path.unlink(missing_ok=True)
            self._rollback_path.unlink(missing_ok=True)
            restored, next_revision = self.read()
            self._write_audit(
                action="rollback",
                actor=actor,
                revision=next_revision,
                sections=self._changed_sections(current, restored),
                profile=restored,
            )
            return next_revision

    def _write_audit(
        self,
        *,
        action: str,
        actor: str,
        revision: str,
        sections: list[str],
        profile: RuntimeConfiguration,
    ) -> None:
        record = {
            "timestamp": datetime.now(UTC).isoformat(),
            "action": action,
            "actor": actor,
            "revision": revision,
            "sections": sections,
            "providerKinds": {
                "llm": profile.llm.provider,
                "stt": profile.stt.provider,
                "tts": profile.tts.provider,
                "search": profile.search.provider,
                "weather": profile.weather.provider,
            },
        }
        self._directory.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self._audit_path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf-8") as audit_file:
            audit_file.write(json.dumps(record, sort_keys=True) + "\n")

    @staticmethod
    def _changed_sections(before: RuntimeConfiguration, after: RuntimeConfiguration) -> list[str]:
        before_data = before.model_dump(mode="json", by_alias=True)
        after_data = after.model_dump(mode="json", by_alias=True)
        return sorted(key for key in before_data if before_data[key] != after_data[key])

    @staticmethod
    def _revision(data: dict[str, Any]) -> str:
        content = json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(content).hexdigest()

    def _atomic_write(self, path: Path, content: str) -> None:
        self._directory.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_path = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=self._directory
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as temporary_file:
                temporary_file.write(content)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary_path, path)
        except Exception:
            Path(temporary_path).unlink(missing_ok=True)
            raise
