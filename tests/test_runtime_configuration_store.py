import json

import pytest
from app.core.runtime_config import RuntimeConfiguration
from app.services.runtime_configuration import (
    RuntimeConfigurationConflict,
    RuntimeConfigurationStore,
)


def test_store_saves_atomically_and_rolls_back_last_profile(tmp_path) -> None:
    store = RuntimeConfigurationStore(tmp_path)
    original, original_revision = store.read()
    updated = original.model_copy(
        update={"weather": original.weather.model_copy(update={"default_location": "Pune"})}
    )

    saved_revision = store.save(updated, expected_revision=original_revision, actor="test")
    saved_profile, current_revision = store.read()
    assert saved_profile.weather.default_location == "Pune"
    assert current_revision == saved_revision

    rolled_back_revision = store.rollback(expected_revision=current_revision, actor="test")
    restored, actual_revision = store.read()
    assert restored == original
    assert actual_revision == rolled_back_revision
    assert not (tmp_path / "runtime-config.rollback.json").exists()


def test_store_rejects_stale_revision(tmp_path) -> None:
    store = RuntimeConfigurationStore(tmp_path)
    profile, revision = store.read()
    store.save(
        profile.model_copy(
            update={
                "weather": profile.weather.model_copy(
                    update={"default_location": "Delhi"}
                )
            }
        ),
        expected_revision=revision,
        actor="test",
    )

    with pytest.raises(RuntimeConfigurationConflict):
        store.save(RuntimeConfiguration(), expected_revision=revision, actor="test")


def test_audit_metadata_does_not_include_secret_references_or_values(tmp_path) -> None:
    store = RuntimeConfigurationStore(tmp_path)
    profile, revision = store.read()
    updated = profile.model_copy(
        update={
            "search": profile.search.model_copy(
                update={"provider": "brave", "secret_env_var": "JARVIS_TEST_SEARCH_TOKEN"}
            )
        }
    )

    store.save(updated, expected_revision=revision, actor="test")
    audit = (tmp_path / "configuration-audit.jsonl").read_text(encoding="utf-8")
    record = json.loads(audit)
    assert record["sections"] == ["search"]
    assert record["providerKinds"]["search"] == "brave"
    assert "JARVIS_TEST_SEARCH_TOKEN" not in audit
    assert "credential-value" not in audit
