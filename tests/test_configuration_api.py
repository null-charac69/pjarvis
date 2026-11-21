from app.core.runtime_config import RuntimeConfiguration
from app.core.settings import ProviderSettings, Settings
from app.main import create_app
from fastapi.testclient import TestClient
from pydantic import SecretStr


def test_configuration_api_validates_saves_and_rolls_back(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("JARVIS_ENV", "test")
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "user-data",
        database_url=SecretStr(f"sqlite+aiosqlite:///{(tmp_path / 'api.sqlite3').as_posix()}"),
    )
    client = TestClient(create_app(settings))
    with client:
        initial = client.get("/api/v1/configuration").json()["data"]
        configuration = RuntimeConfiguration().model_dump(mode="json", by_alias=True)
        configuration["weather"]["defaultLocation"] = "Pune"

        validation = client.post("/api/v1/configuration/validate", json=configuration)
        assert validation.status_code == 200
        assert validation.json()["data"]["valid"] is True

        saved = client.post(
            "/api/v1/configuration/save",
            json={"configuration": configuration, "expectedRevision": initial["revision"]},
        )
        assert saved.status_code == 200
        assert saved.json()["data"]["restartRequired"] is True

        current = client.get("/api/v1/configuration").json()["data"]
        assert current["configuration"]["weather"]["defaultLocation"] == "Pune"
        assert current["restartRequired"] is True

        rollback = client.post(
            "/api/v1/configuration/rollback",
            json={"expectedRevision": current["revision"]},
        )
        assert rollback.status_code == 200
        restored = client.get("/api/v1/configuration").json()["data"]
        assert restored["configuration"]["weather"]["defaultLocation"] == ""

    client.close()


def test_configuration_validation_response_never_echoes_invalid_secret_value(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "test")
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "user-data",
        database_url=SecretStr(f"sqlite+aiosqlite:///{(tmp_path / 'api.sqlite3').as_posix()}"),
    )
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/v1/configuration/validate",
            json={"search": {"provider": "brave", "secretEnvVar": "actual-plaintext-secret"}},
        )

    assert response.status_code == 422
    assert "actual-plaintext-secret" not in response.text


def test_runtime_status_classifies_effective_providers_without_exposing_configuration(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "test")
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "user-data",
        database_url=SecretStr(f"sqlite+aiosqlite:///{(tmp_path / 'api.sqlite3').as_posix()}"),
        providers=ProviderSettings(
            llm="openai_compatible",
            llm_base_url="http://127.0.0.1:12345/v1",
            llm_model="private-model-name",
            llm_api_key=SecretStr("private-api-key"),
            stt="azure",
            azure_speech_region="private-region",
            azure_speech_key=SecretStr("private-speech-key"),
        ),
    )
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/v1/configuration/status")

    assert response.status_code == 200
    assert response.json()["data"] == {
        "restartRequired": False,
        "providers": {
            "llm": "local",
            "stt": "external",
            "tts": "mock",
            "search": "unconfigured",
            "weather": "external",
        }
    }
    assert "private-model-name" not in response.text
    assert "private-api-key" not in response.text
    assert "private-speech-key" not in response.text
    assert "127.0.0.1" not in response.text


def test_saved_provider_profile_requires_restart_before_runtime_status_changes(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "test")
    data_directory = tmp_path / "user-data"
    monkeypatch.setenv("JARVIS_DATA_DIR", str(data_directory))
    database_url = SecretStr(f"sqlite+aiosqlite:///{(tmp_path / 'api.sqlite3').as_posix()}")
    settings = Settings(_env_file=None, data_dir=data_directory, database_url=database_url)

    with TestClient(create_app(settings)) as client:
        initial = client.get("/api/v1/configuration").json()["data"]
        configuration = RuntimeConfiguration().model_dump(mode="json", by_alias=True)
        configuration["llm"].update({
            "provider": "local_openai_compatible",
            "endpoint": "http://127.0.0.1:11434/v1",
            "model": "test-model",
        })
        saved = client.post(
            "/api/v1/configuration/save",
            json={"configuration": configuration, "expectedRevision": initial["revision"]},
        )
        assert saved.status_code == 200
        assert saved.json()["data"]["restartRequired"] is True
        running_status = client.get("/api/v1/configuration/status").json()["data"]
        assert running_status["providers"]["llm"] == "mock"
        assert running_status["restartRequired"] is True

    restarted_settings = Settings(
        _env_file=None,
        data_dir=data_directory,
        database_url=database_url,
    )
    with TestClient(create_app(restarted_settings)) as client:
        status_response = client.get("/api/v1/configuration/status")

    assert status_response.json()["data"]["providers"]["llm"] == "local"
    assert status_response.json()["data"]["restartRequired"] is False
