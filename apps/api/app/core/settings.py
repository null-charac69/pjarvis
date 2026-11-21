"""Validated application settings with environment-over-profile precedence."""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from dotenv import dotenv_values
from pydantic import (
    AnyHttpUrl,
    BaseModel,
    Field,
    SecretStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict
from pydantic_settings.sources import TomlConfigSettingsSource

from app.core.runtime_config import RuntimeConfiguration, settings_values

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CONFIG_DIRECTORY = REPOSITORY_ROOT / "config"
ENV_FILE = REPOSITORY_ROOT / ".env"
_PROFILES = {"development", "test", "production"}


class AppSettings(BaseModel):
    environment: Literal["development", "test", "production"]
    developer_mode: bool = False
    mock_when_unconfigured: bool = False


class ProviderSettings(BaseModel):
    llm: Literal["", "mock", "openai_compatible", "azure_openai"] = "mock"
    stt: Literal["", "mock", "faster_whisper", "azure"] = "mock"
    tts: Literal["", "mock", "piper", "azure", "browser"] = "mock"
    wake_word: Literal["", "openwakeword", "push_to_talk", "mock"] = "push_to_talk"
    web_search: Literal["mock", "unconfigured", "brave"] = "unconfigured"
    web_search_result_limit: int = Field(default=5, ge=1, le=20)
    web_search_api_key: SecretStr | None = None
    weather: Literal["open_meteo", "unconfigured"] = "open_meteo"
    weather_default_location: str = Field(default="", max_length=160)
    weather_temperature_unit: Literal["celsius", "fahrenheit"] = "celsius"
    weather_timezone: str = Field(default="UTC", max_length=64)
    llm_base_url: AnyHttpUrl | None = None
    llm_model: str | None = None
    llm_api_key: SecretStr | None = None
    azure_openai_endpoint: AnyHttpUrl | None = None
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str | None = None
    azure_openai_api_key: SecretStr | None = None
    azure_speech_region: str | None = None
    azure_speech_key: SecretStr | None = None
    llm_timeout_seconds: float = Field(default=30.0, gt=0, le=120)
    llm_max_tokens: int = Field(default=2048, ge=1, le=16384)

    @model_validator(mode="after")
    def selected_llm_configuration_is_complete(self) -> ProviderSettings:
        if self.llm == "openai_compatible":
            if self.llm_base_url is None or not self.llm_model:
                raise ValueError(
                    "OpenAI-compatible LLM requires an operator-supplied base URL and model"
                )
            if (
                self.llm_base_url.username is not None
                or self.llm_base_url.password is not None
                or self.llm_base_url.query is not None
                or self.llm_base_url.fragment is not None
            ):
                raise ValueError("LLM base URL cannot contain credentials, query, or fragment")
        if self.llm == "azure_openai":
            if (
                self.azure_openai_endpoint is None
                or not self.azure_openai_deployment
                or not self.azure_openai_api_version
                or self.azure_openai_api_key is None
            ):
                raise ValueError(
                    "Azure OpenAI requires endpoint, deployment, API version, and API key settings"
                )
            if (
                self.azure_openai_endpoint.scheme != "https"
                or self.azure_openai_endpoint.username is not None
                or self.azure_openai_endpoint.password is not None
                or self.azure_openai_endpoint.path not in {"", "/"}
                or self.azure_openai_endpoint.query is not None
                or self.azure_openai_endpoint.fragment is not None
            ):
                raise ValueError("Azure OpenAI endpoint must be a credential-free HTTPS origin")
        return self

    @field_validator(
        "llm_base_url",
        "llm_model",
        "llm_api_key",
        "web_search_api_key",
        "azure_openai_endpoint",
        "azure_openai_deployment",
        "azure_openai_api_version",
        "azure_openai_api_key",
        "azure_speech_region",
        "azure_speech_key",
        mode="before",
    )
    @classmethod
    def empty_optional_values_are_unset(cls, value: Any) -> Any:
        return None if value == "" else value


class VoiceSettings(BaseModel):
    language: str = "en-IN"
    audio_retention: bool = False
    stt_model_path: Path | None = None
    stt_device: Literal["cpu", "cuda", "auto"] = "cpu"
    stt_compute_type: str = "int8"
    wake_model_path: Path | None = None
    wake_phrase: str = "Jarvis"
    wake_threshold: float = Field(default=0.65, ge=0, le=1)


class WorkspaceSettings(BaseModel):
    allowed_file_types: list[str] = Field(default_factory=list)
    max_file_bytes: int = Field(default=262_144, ge=1024, le=8_388_608)


class PermissionSettings(BaseModel):
    default_mode: Literal["deny", "ask_every_time"] = "ask_every_time"
    workspace_sandbox: bool = True
    approved_workspace_roots: list[Path] = Field(default_factory=list)
    approved_website_origins: list[AnyHttpUrl] = Field(default_factory=list)
    approved_applications: dict[str, Path] = Field(default_factory=dict)

    @field_validator("approved_applications")
    @classmethod
    def applications_are_explicit_executables(
        cls, applications: dict[str, Path]
    ) -> dict[str, Path]:
        for application_id, path in applications.items():
            if (
                not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", application_id)
                or not path.is_absolute()
                or path.suffix.lower() != ".exe"
            ):
                raise ValueError(
                    "Approved applications require a stable ID and an absolute .exe path"
                )
        return applications

    @field_validator("approved_website_origins")
    @classmethod
    def website_origins_must_be_https_origins(cls, origins: list[AnyHttpUrl]) -> list[AnyHttpUrl]:
        for origin in origins:
            if (
                origin.scheme != "https"
                or origin.username is not None
                or origin.password is not None
                or origin.path not in {"", "/"}
                or origin.query is not None
                or origin.fragment is not None
            ):
                raise ValueError(
                    "Approved website entries must be HTTPS origins without credentials"
                )
        return origins


class StorageSettings(BaseModel):
    engine: Literal["sqlite", "postgresql"] = "sqlite"


class DeploymentSettings(BaseModel):
    mode: Literal["browser", "pwa", "electron"] = "electron"
    session_ttl_seconds: int = Field(default=14_400, ge=300, le=43_200)
    requests_per_minute: int = Field(default=120, ge=10, le=600)
    max_request_bytes: int = Field(default=12 * 1024 * 1024, ge=1024, le=16 * 1024 * 1024)


class OrchestrationSettings(BaseModel):
    max_plan_steps: int = Field(default=8, ge=1, le=16)
    provider_max_retries: int = Field(default=1, ge=0, le=3)
    command_timeout_seconds: float = Field(default=120.0, gt=0, le=600)


class ServerSettings(BaseModel):
    host: str = "localhost"
    port: int = Field(default=8765, ge=1, le=65535)
    allowed_origins: list[str] = Field(default_factory=lambda: ["null"])
    websocket_send_timeout_seconds: float = Field(default=2.0, gt=0, le=30)

    @field_validator("allowed_origins")
    @classmethod
    def origins_cannot_be_wildcards(cls, origins: list[str]) -> list[str]:
        if any("*" in origin for origin in origins):
            raise ValueError("Wildcard origins are not supported")
        return origins


class LegacyEnvironmentSource(PydanticBaseSettingsSource):
    """Map Phase 1 flat variable names onto the structured settings models."""

    _PROVIDER_SELECTION_VARIABLES = {
        "JARVIS_LLM_PROVIDER",
        "JARVIS_STT_PROVIDER",
        "JARVIS_TTS_PROVIDER",
        "JARVIS_WAKE_PROVIDER",
        "JARVIS_WEB_SEARCH_PROVIDER",
    }

    _VARIABLE_PATHS = {
        "JARVIS_ENV": "app.environment",
        "JARVIS_DEPLOYMENT_MODE": "deployment.mode",
        "JARVIS_DATA_DIR": "data_dir",
        "JARVIS_DEVELOPER_MODE": "app.developer_mode",
        "JARVIS_LLM_PROVIDER": "providers.llm",
        "JARVIS_STT_PROVIDER": "providers.stt",
        "JARVIS_STT_MODEL_PATH": "voice.stt_model_path",
        "JARVIS_STT_DEVICE": "voice.stt_device",
        "JARVIS_STT_COMPUTE_TYPE": "voice.stt_compute_type",
        "JARVIS_WAKE_MODEL_PATH": "voice.wake_model_path",
        "JARVIS_WAKE_PHRASE": "voice.wake_phrase",
        "JARVIS_WAKE_THRESHOLD": "voice.wake_threshold",
        "JARVIS_TTS_PROVIDER": "providers.tts",
        "JARVIS_WAKE_PROVIDER": "providers.wake_word",
        "JARVIS_WEB_SEARCH_PROVIDER": "providers.web_search",
        "JARVIS_WEB_SEARCH_API_KEY": "providers.web_search_api_key",
        "JARVIS_WEATHER_PROVIDER": "providers.weather",
        "JARVIS_LLM_BASE_URL": "providers.llm_base_url",
        "JARVIS_LLM_MODEL": "providers.llm_model",
        "JARVIS_LLM_API_KEY": "providers.llm_api_key",
        "JARVIS_AZURE_OPENAI_ENDPOINT": "providers.azure_openai_endpoint",
        "JARVIS_AZURE_OPENAI_DEPLOYMENT": "providers.azure_openai_deployment",
        "JARVIS_AZURE_OPENAI_API_VERSION": "providers.azure_openai_api_version",
        "JARVIS_AZURE_OPENAI_API_KEY": "providers.azure_openai_api_key",
        "JARVIS_AZURE_SPEECH_REGION": "providers.azure_speech_region",
        "JARVIS_AZURE_SPEECH_KEY": "providers.azure_speech_key",
        "JARVIS_SPEECH_LANGUAGE": "voice.language",
        "JARVIS_AUDIO_RETENTION": "voice.audio_retention",
        "JARVIS_ALLOWED_ORIGINS": "server.allowed_origins",
        "JARVIS_DATABASE_URL": "database_url",
        "JARVIS_LOG_LEVEL": "log_level",
    }

    def get_field_value(self, field: Any, field_name: str) -> tuple[Any, str, bool]:
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        dotenv = {
            key.upper(): value
            for key, value in dotenv_values(ENV_FILE).items()
            if value is not None
        }
        process_environment = {key.upper(): value for key, value in os.environ.items()}
        values = {**dotenv, **process_environment}
        environment = values.get("JARVIS_APP__ENVIRONMENT", values.get("JARVIS_ENV", ""))
        production = str(environment).strip().lower() == "production"
        result: dict[str, Any] = {}

        for variable, path in self._VARIABLE_PATHS.items():
            if variable not in values:
                continue
            value: Any = values[variable]
            if (
                production
                and variable in self._PROVIDER_SELECTION_VARIABLES
                and variable not in process_environment
                and isinstance(value, str)
                and value.strip().lower() == "mock"
            ):
                continue
            if path == "voice.audio_retention":
                normalized = str(value).strip().lower()
                if normalized not in {"enabled", "disabled", "true", "false", "1", "0"}:
                    raise ValueError("JARVIS_AUDIO_RETENTION must be enabled or disabled")
                value = normalized in {"enabled", "true", "1"}
            elif path == "server.allowed_origins":
                value = [origin.strip() for origin in str(value).split(",") if origin.strip()]
            elif isinstance(value, str) and value.strip() == "":
                value = None
            target = result
            parts = path.split(".")
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = value

        return result


class RuntimeConfigurationSource(PydanticBaseSettingsSource):
    """Read saved setup settings without allowing them to override environment values."""

    def get_field_value(self, field: Any, field_name: str) -> tuple[Any, str, bool]:
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        data_directory = os.environ.get("JARVIS_DATA_DIR", "").strip()
        if not data_directory:
            return {}
        profile_path = Path(data_directory).expanduser() / "runtime-config.json"
        if not profile_path.is_file():
            return {}
        try:
            raw_profile = json.loads(profile_path.read_text(encoding="utf-8"))
            profile = RuntimeConfiguration.model_validate(raw_profile)
        except (OSError, json.JSONDecodeError, ValidationError) as exception:
            raise ValueError(
                "Saved runtime configuration is invalid; use the setup rollback action."
            ) from exception
        return settings_values(profile, dict(os.environ))


def _selected_profile() -> Path:
    dotenv_environment = dotenv_values(ENV_FILE).get("JARVIS_ENV")
    environment = os.environ.get("JARVIS_ENV", dotenv_environment or "development").strip().lower()
    if environment not in _PROFILES:
        choices = ", ".join(sorted(_PROFILES))
        raise ValueError(f"JARVIS_ENV must be one of: {choices}")
    return CONFIG_DIRECTORY / f"{environment}.toml"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="JARVIS_",
        env_nested_delimiter="__",
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        validate_default=True,
    )

    app: AppSettings = Field(default_factory=lambda: AppSettings(environment="development"))
    providers: ProviderSettings = Field(default_factory=ProviderSettings)
    voice: VoiceSettings = Field(default_factory=VoiceSettings)
    workspace: WorkspaceSettings = Field(default_factory=WorkspaceSettings)
    permissions: PermissionSettings = Field(default_factory=PermissionSettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    deployment: DeploymentSettings = Field(default_factory=DeploymentSettings)
    orchestration: OrchestrationSettings = Field(default_factory=OrchestrationSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)
    data_dir: Path | None = None
    database_url: SecretStr | None = None
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"

    @model_validator(mode="after")
    def selected_providers_are_configured(self) -> Settings:
        if self.providers.web_search == "brave" and self.providers.web_search_api_key is None:
            raise ValueError("Brave Search requires JARVIS_WEB_SEARCH_API_KEY")
        if self.providers.stt == "azure" and (
            self.providers.azure_speech_key is None or not self.providers.azure_speech_region
        ):
            raise ValueError("Azure Speech requires its region and subscription key settings")
        if self.providers.stt == "faster_whisper" and self.voice.stt_model_path is None:
            raise ValueError("faster-whisper requires an existing JARVIS_STT_MODEL_PATH")
        if self.providers.wake_word == "openwakeword" and self.voice.wake_model_path is None:
            raise ValueError("openWakeWord requires an existing JARVIS_WAKE_MODEL_PATH")

        if self.deployment.mode in {"browser", "pwa"}:
            if self.server.host != "127.0.0.1":
                raise ValueError("Browser deployments must bind the API to 127.0.0.1")
            if not self.server.allowed_origins or "null" in self.server.allowed_origins:
                raise ValueError("Browser deployments require explicit allowed origins")
            for origin in self.server.allowed_origins:
                parsed_origin = urlsplit(origin)
                if (
                    parsed_origin.scheme not in {"http", "https"}
                    or not parsed_origin.netloc
                    or parsed_origin.username is not None
                    or parsed_origin.password is not None
                    or parsed_origin.path not in {"", "/"}
                    or parsed_origin.query
                    or parsed_origin.fragment
                ):
                    raise ValueError(
                        "Browser allowed origins must be exact credential-free origins"
                    )
            if self.is_production and self.data_dir is None:
                raise ValueError("Production browser deployments require JARVIS_DATA_DIR")

        if not self.is_production:
            return self

        if self.app.developer_mode or self.app.mock_when_unconfigured:
            raise ValueError("Production cannot enable developer mode or automatic mock fallback")
        if any(
            provider == "mock"
            for provider in (
                self.providers.llm,
                self.providers.stt,
                self.providers.tts,
                self.providers.wake_word,
                self.providers.web_search,
            )
        ):
            raise ValueError("Production cannot select mock providers")
        if self.server.host.casefold() not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Production API bind must be loopback-only")
        if self.voice.audio_retention:
            raise ValueError("Production audio retention is not supported")
        if not self.permissions.workspace_sandbox:
            raise ValueError("Production requires workspace sandboxing")
        return self

    @field_validator("database_url", mode="before")
    @classmethod
    def empty_database_url_is_unset(cls, value: Any) -> Any:
        return None if value == "" else value

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            LegacyEnvironmentSource(settings_cls),
            RuntimeConfigurationSource(settings_cls),
            TomlConfigSettingsSource(settings_cls, toml_file=_selected_profile()),
            file_secret_settings,
        )

    @property
    def database_url_value(self) -> str:
        if self.database_url is not None:
            return self.database_url.get_secret_value()
        if self.storage.engine == "postgresql":
            raise ValueError("JARVIS_DATABASE_URL is required when storage.engine is postgresql")
        database_path = self.data_directory / "jarvis.sqlite3"
        return f"sqlite+aiosqlite:///{database_path.as_posix()}"

    @property
    def data_directory(self) -> Path:
        if self.data_dir is not None:
            return self.data_dir.expanduser().resolve()
        if self.is_production and self.deployment.mode in {"browser", "pwa"}:
            raise ValueError("JARVIS_DATA_DIR is required for production browser deployments")
        return REPOSITORY_ROOT / "data"

    @property
    def is_production(self) -> bool:
        return self.app.environment == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
