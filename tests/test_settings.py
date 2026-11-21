import pytest
from app.core.runtime_config import RuntimeConfiguration
from app.core.settings import Settings
from pydantic import SecretStr, ValidationError


def test_profile_defaults_and_phase_one_environment_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "test")
    monkeypatch.setenv("JARVIS_SPEECH_LANGUAGE", "en-GB")
    monkeypatch.setenv("JARVIS_AUDIO_RETENTION", "enabled")
    settings = Settings(_env_file=None)

    assert settings.app.environment == "test"
    assert settings.providers.llm == "mock"
    assert settings.voice.language == "en-GB"
    assert settings.voice.audio_retention is True
    assert settings.permissions.default_mode == "deny"


def test_provider_secrets_are_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JARVIS_ENV", "development")
    monkeypatch.setenv("JARVIS_LLM_API_KEY", "do-not-display-this")
    settings = Settings(_env_file=None)

    assert isinstance(settings.providers.llm_api_key, SecretStr)
    assert settings.providers.llm_api_key.get_secret_value() == "do-not-display-this"
    assert "do-not-display-this" not in repr(settings)
    assert "do-not-display-this" not in settings.model_dump_json()


def test_invalid_profile_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JARVIS_ENV", "unknown")

    with pytest.raises(ValueError, match="JARVIS_ENV must be one of"):
        Settings(_env_file=None)


def test_invalid_port_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JARVIS_ENV", "development")

    with pytest.raises(ValidationError):
        Settings(_env_file=None, server={"port": 70000})


def test_blank_database_url_uses_local_sqlite(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JARVIS_ENV", "development")
    monkeypatch.setenv("JARVIS_DATABASE_URL", "")
    settings = Settings()

    assert settings.database_url is None
    assert settings.database_url_value.endswith("/data/jarvis.sqlite3")


def test_saved_runtime_profile_is_applied_but_environment_values_win(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_directory = tmp_path / "user-data"
    data_directory.mkdir()
    profile = RuntimeConfiguration.model_validate(
        {
            "llm": {
                "provider": "local_openai_compatible",
                "endpoint": "http://127.0.0.1:9000/v1",
                "model": "saved-model",
            },
            "tts": {"provider": "browser"},
            "workspace": {"allowedFileTypes": [".md"], "maxFileBytes": 8192},
        }
    )
    (data_directory / "runtime-config.json").write_text(
        profile.model_dump_json(by_alias=True), encoding="utf-8"
    )
    monkeypatch.setenv("JARVIS_ENV", "test")
    monkeypatch.setenv("JARVIS_DATA_DIR", str(data_directory))
    monkeypatch.setenv("JARVIS_LLM_MODEL", "environment-model")

    settings = Settings(_env_file=None)

    assert settings.providers.llm == "openai_compatible"
    assert settings.providers.llm_model == "environment-model"
    assert settings.providers.llm_base_url is not None
    assert str(settings.providers.llm_base_url) == "http://127.0.0.1:9000/v1"
    assert settings.providers.tts == "browser"
    assert settings.workspace.allowed_file_types == [".md"]
    assert settings.workspace.max_file_bytes == 8192


def test_production_profile_is_safe_and_does_not_select_providers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "production")

    settings = Settings(_env_file=None)

    assert settings.app.developer_mode is False
    assert settings.app.mock_when_unconfigured is False
    assert settings.providers.llm == ""
    assert settings.providers.stt == ""
    assert settings.providers.tts == ""
    assert settings.providers.web_search == "unconfigured"
    assert settings.providers.weather == "unconfigured"
    assert settings.server.host == "localhost"


def test_production_ignores_dotenv_mock_but_rejects_process_mock(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.core.settings as settings_module

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text("JARVIS_LLM_PROVIDER=mock\n", encoding="utf-8")
    monkeypatch.setattr(settings_module, "ENV_FILE", dotenv_path)
    for variable in (
        "JARVIS_LLM_PROVIDER",
        "JARVIS_STT_PROVIDER",
        "JARVIS_TTS_PROVIDER",
        "JARVIS_WAKE_PROVIDER",
        "JARVIS_WEB_SEARCH_PROVIDER",
    ):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setenv("JARVIS_ENV", "production")
    monkeypatch.setenv("JARVIS_APP__ENVIRONMENT", "production")
    monkeypatch.setenv("JARVIS_DEPLOYMENT_MODE", "browser")
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path / "user-data"))
    monkeypatch.setenv("JARVIS_SERVER__HOST", "127.0.0.1")
    monkeypatch.setenv("JARVIS_ALLOWED_ORIGINS", "http://127.0.0.1:5173")

    settings = Settings(_env_file=None)
    assert settings.providers.llm == ""

    monkeypatch.setenv("JARVIS_LLM_PROVIDER", "mock")
    with pytest.raises(ValidationError, match="Production cannot select mock providers"):
        Settings(_env_file=None)


@pytest.mark.parametrize(
    ("setting_group", "override"),
    [
        ("app", {"developer_mode": True}),
        ("app", {"mock_when_unconfigured": True}),
        ("providers", {"llm": "mock"}),
        ("providers", {"web_search": "mock"}),
        ("server", {"host": "0.0.0.0"}),
        ("server", {"allowed_origins": ["*"]}),
        ("voice", {"audio_retention": True}),
        ("permissions", {"workspace_sandbox": False}),
    ],
)
def test_production_rejects_unsafe_overrides(
    monkeypatch: pytest.MonkeyPatch,
    setting_group: str,
    override: dict[str, object],
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "production")
    values: dict[str, object] = {
        "app": {
            "environment": "production",
            "developer_mode": False,
            "mock_when_unconfigured": False,
        },
        "providers": {
            "llm": "",
            "stt": "",
            "tts": "",
            "wake_word": "",
            "web_search": "unconfigured",
            "weather": "unconfigured",
        },
        "server": {"host": "localhost", "allowed_origins": ["null"]},
        "voice": {"audio_retention": False},
        "permissions": {"workspace_sandbox": True, "default_mode": "ask_every_time"},
    }
    group_values = values[setting_group]
    assert isinstance(group_values, dict)
    group_values.update(override)

    with pytest.raises(ValidationError):
        Settings(_env_file=None, **values)


def test_selected_live_providers_require_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JARVIS_ENV", "test")

    with pytest.raises(ValidationError, match="Brave Search requires"):
        Settings(_env_file=None, providers={"web_search": "brave"})

    with pytest.raises(ValidationError, match="Azure Speech requires"):
        Settings(_env_file=None, providers={"stt": "azure"})


def test_browser_deployment_uses_exact_loopback_origins_and_user_data_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "development")
    data_dir = tmp_path / "jarvis-user-data"
    settings = Settings(
        _env_file=None,
        deployment={"mode": "browser"},
        server={
            "host": "127.0.0.1",
            "allowed_origins": ["http://127.0.0.1:5173"],
        },
        data_dir=data_dir,
    )

    assert settings.deployment.mode == "browser"
    assert settings.server.host == "127.0.0.1"
    assert settings.data_directory == data_dir.resolve()
    assert settings.database_url_value.endswith("/jarvis-user-data/jarvis.sqlite3")


@pytest.mark.parametrize(
    ("server", "match"),
    [
        ({"host": "localhost", "allowed_origins": ["http://127.0.0.1:5173"]}, "127.0.0.1"),
        ({"host": "127.0.0.1", "allowed_origins": ["*"]}, "Wildcard"),
        ({"host": "127.0.0.1", "allowed_origins": ["null"]}, "explicit allowed origins"),
        (
            {"host": "127.0.0.1", "allowed_origins": ["http://127.0.0.1:5173/path"]},
            "exact credential-free origins",
        ),
    ],
)
def test_browser_deployment_rejects_unsafe_bind_or_origin(
    monkeypatch: pytest.MonkeyPatch,
    server: dict[str, object],
    match: str,
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "development")

    with pytest.raises(ValidationError, match=match):
        Settings(_env_file=None, deployment={"mode": "browser"}, server=server)


def test_production_browser_requires_an_explicit_data_directory(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("JARVIS_ENV", "production")
    common = {
        "app": {
            "environment": "production",
            "developer_mode": False,
            "mock_when_unconfigured": False,
        },
        "providers": {
            "llm": "",
            "stt": "",
            "tts": "",
            "wake_word": "",
            "web_search": "unconfigured",
            "weather": "unconfigured",
        },
        "deployment": {"mode": "browser"},
        "server": {"host": "127.0.0.1", "allowed_origins": ["http://127.0.0.1:5173"]},
        "permissions": {"workspace_sandbox": True, "default_mode": "ask_every_time"},
    }

    with pytest.raises(ValidationError, match="JARVIS_DATA_DIR"):
        Settings(_env_file=None, **common)

    settings = Settings(_env_file=None, data_dir=tmp_path, **common)
    assert settings.data_directory == tmp_path.resolve()
