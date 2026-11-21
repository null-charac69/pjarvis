"""Safe, persistable non-secret setup configuration."""

from __future__ import annotations

import ipaddress
import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

_ENVIRONMENT_REFERENCE = re.compile(r"^[A-Z][A-Z0-9_]{1,120}_(?:KEY|TOKEN|SECRET|CREDENTIALS?)$")


class RuntimeConfigSection(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


def _validate_endpoint(value: str | None, *, allow_remote_http: bool = False) -> str | None:
    if value is None:
        return None
    if len(value) > 2048:
        raise ValueError("endpoint is too long")
    parsed = urlsplit(value)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("endpoint must be an absolute URL without credentials, query, or fragment")
    try:
        loopback = (
            parsed.hostname.casefold() == "localhost"
            or ipaddress.ip_address(parsed.hostname).is_loopback
        )
    except ValueError:
        loopback = False
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and (loopback or allow_remote_http)
    ):
        raise ValueError(
            "remote endpoints must use HTTPS; HTTP is allowed only for loopback endpoints"
        )
    return value.rstrip("/")


def _validate_environment_reference(value: str | None) -> str | None:
    if value is None:
        return None
    if not _ENVIRONMENT_REFERENCE.fullmatch(value):
        raise ValueError("enter an environment-variable name, not a secret value")
    return value


def _read_secret_reference(environ: dict[str, str], reference: str | None) -> str | None:
    return environ.get(reference) if reference is not None else None


class LLMRuntimeConfig(RuntimeConfigSection):
    provider: Literal[
        "unconfigured", "local_openai_compatible", "azure_openai", "other_openai_compatible"
    ] = "unconfigured"
    endpoint: str | None = None
    model: str | None = Field(default=None, max_length=200)
    api_version: str | None = Field(default=None, max_length=80)
    authentication: Literal["none", "environment"] = "none"
    secret_env_var: str | None = None
    timeout_seconds: float = Field(default=30, ge=1, le=120)
    max_output_tokens: int = Field(default=2048, ge=1, le=16384)

    @field_validator("endpoint")
    @classmethod
    def endpoint_is_safe(cls, value: str | None) -> str | None:
        return _validate_endpoint(value, allow_remote_http=True)

    @field_validator("secret_env_var")
    @classmethod
    def secret_reference_is_a_name(cls, value: str | None) -> str | None:
        return _validate_environment_reference(value)

    @model_validator(mode="after")
    def selected_provider_is_complete(self) -> LLMRuntimeConfig:
        if self.provider != "unconfigured" and (not self.endpoint or not self.model):
            raise ValueError("selected LLM provider requires an endpoint and model")
        if self.provider == "azure_openai":
            parsed = urlsplit(self.endpoint or "")
            if parsed.scheme != "https" or parsed.path not in {"", "/"} or not self.api_version:
                raise ValueError("Azure OpenAI requires an HTTPS origin and API version")
        if self.authentication == "environment" and not self.secret_env_var:
            raise ValueError("environment authentication requires a secret-reference variable name")
        if self.authentication == "none" and self.secret_env_var:
            raise ValueError("clear the secret reference when authentication is None")
        return self


class STTRuntimeConfig(RuntimeConfigSection):
    provider: Literal["unconfigured", "faster_whisper", "azure", "openai_compatible"] = (
        "unconfigured"
    )
    model_path: str | None = Field(default=None, max_length=2048)
    model: str | None = Field(default=None, max_length=200)
    device: Literal["cpu", "cuda", "auto"] = "cpu"
    compute_type: Literal["int8", "int8_float16", "float16", "float32"] = "int8"
    language: str = Field(default="en-IN", pattern=r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$")
    endpoint: str | None = None
    region: str | None = Field(default=None, max_length=80)
    secret_env_var: str | None = None
    timeout_seconds: float = Field(default=30, ge=1, le=120)

    @field_validator("endpoint")
    @classmethod
    def endpoint_is_safe(cls, value: str | None) -> str | None:
        return _validate_endpoint(value)

    @field_validator("secret_env_var")
    @classmethod
    def secret_reference_is_a_name(cls, value: str | None) -> str | None:
        return _validate_environment_reference(value)

    @field_validator("model_path")
    @classmethod
    def model_path_is_absolute(cls, value: str | None) -> str | None:
        if value is not None and (
            not value.strip() or not re.match(r"^(?:[A-Za-z]:[\\/]|/)", value)
        ):
            raise ValueError("model path must be an absolute user-approved path")
        return value

    @model_validator(mode="after")
    def selected_provider_is_complete(self) -> STTRuntimeConfig:
        if self.provider == "faster_whisper" and (not self.model or not self.model_path):
            raise ValueError("faster-whisper requires a model name and existing model directory")
        if self.provider == "azure" and (not self.region or not self.secret_env_var):
            raise ValueError("Azure Speech requires a region and secret-reference variable name")
        if self.provider == "openai_compatible" and (
            not self.endpoint or not self.model or not self.secret_env_var
        ):
            raise ValueError("remote STT requires an HTTPS endpoint, model, and secret reference")
        return self


class SearchRuntimeConfig(RuntimeConfigSection):
    provider: Literal["unconfigured", "brave"] = "unconfigured"
    secret_env_var: str | None = None
    result_limit: int = Field(default=5, ge=1, le=20)

    @field_validator("secret_env_var")
    @classmethod
    def secret_reference_is_a_name(cls, value: str | None) -> str | None:
        return _validate_environment_reference(value)

    @model_validator(mode="after")
    def brave_requires_reference(self) -> SearchRuntimeConfig:
        if self.provider == "brave" and not self.secret_env_var:
            raise ValueError("Brave Search requires a secret-reference variable name")
        return self


class WeatherRuntimeConfig(RuntimeConfigSection):
    provider: Literal["open_meteo", "unconfigured"] = "open_meteo"
    default_location: str = Field(default="", max_length=160)
    temperature_unit: Literal["celsius", "fahrenheit"] = "celsius"
    timezone: str = Field(default="UTC", max_length=64)


class TTSRuntimeConfig(RuntimeConfigSection):
    provider: Literal["browser", "piper", "azure", "unconfigured"] = "browser"
    language: str = Field(default="en-IN", pattern=r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$")
    voice: str = Field(default="", max_length=512)
    rate: float = Field(default=1, ge=0.5, le=2)
    volume: float = Field(default=1, ge=0, le=1)


class WorkspaceRuntimeConfig(RuntimeConfigSection):
    approved_roots: list[str] = Field(default_factory=list, max_length=32)
    allowed_file_types: list[str] = Field(default_factory=lambda: [".txt", ".md"], max_length=64)
    max_file_bytes: int = Field(default=262144, ge=1024, le=8_388_608)

    @field_validator("approved_roots")
    @classmethod
    def workspace_roots_are_absolute(cls, value: list[str]) -> list[str]:
        for path in value:
            if not path or not re.match(r"^(?:[A-Za-z]:[\\/]|/)", path):
                raise ValueError("workspace roots must be absolute paths selected by the user")
        return value

    @field_validator("allowed_file_types")
    @classmethod
    def file_types_are_extensions(cls, value: list[str]) -> list[str]:
        normalized = [extension.casefold() for extension in value]
        if any(not re.fullmatch(r"\.[a-z0-9]{1,12}", extension) for extension in normalized):
            raise ValueError("allowed file types must be extensions such as .txt")
        return list(dict.fromkeys(normalized))


class PermissionRuntimeConfig(RuntimeConfigSection):
    default_mode: Literal["deny", "ask_every_time"] = "ask_every_time"
    approved_websites: list[str] = Field(default_factory=list, max_length=64)
    approved_applications: dict[str, str] = Field(default_factory=dict, max_length=64)

    @field_validator("approved_websites")
    @classmethod
    def websites_are_https_origins(cls, values: list[str]) -> list[str]:
        for value in values:
            parsed = urlsplit(value)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.path not in {"", "/"}
                or parsed.query
                or parsed.fragment
                or parsed.username
                or parsed.password
            ):
                raise ValueError("approved websites must be exact credential-free HTTPS origins")
        return list(dict.fromkeys(value.rstrip("/") for value in values))

    @field_validator("approved_applications")
    @classmethod
    def applications_are_explicit_paths(cls, values: dict[str, str]) -> dict[str, str]:
        for name, path in values.items():
            if (
                not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name)
                or not path.lower().endswith(".exe")
                or not re.match(r"^(?:[A-Za-z]:[\\/]|/)", path)
            ):
                raise ValueError("applications require a stable name and absolute .exe path")
        return values


class RuntimeConfiguration(RuntimeConfigSection):
    schema_version: Literal[1] = 1
    llm: LLMRuntimeConfig = Field(default_factory=LLMRuntimeConfig)
    stt: STTRuntimeConfig = Field(default_factory=STTRuntimeConfig)
    tts: TTSRuntimeConfig = Field(default_factory=TTSRuntimeConfig)
    search: SearchRuntimeConfig = Field(default_factory=SearchRuntimeConfig)
    weather: WeatherRuntimeConfig = Field(default_factory=WeatherRuntimeConfig)
    workspace: WorkspaceRuntimeConfig = Field(default_factory=WorkspaceRuntimeConfig)
    permissions: PermissionRuntimeConfig = Field(default_factory=PermissionRuntimeConfig)
    audio_retention: Literal[False] = False


def settings_values(
    configuration: RuntimeConfiguration, environ: dict[str, str]
) -> dict[str, object]:
    """Translate safe profile values and process-scoped secret references to Settings input."""
    llm = configuration.llm
    stt = configuration.stt
    search = configuration.search
    azure_llm = llm.provider == "azure_openai"
    return {
        "providers": {
            "llm": "azure_openai"
            if azure_llm
            else "openai_compatible"
            if llm.provider in {"local_openai_compatible", "other_openai_compatible"}
            else "",
            "llm_base_url": llm.endpoint if not azure_llm else None,
            "llm_model": llm.model if not azure_llm else None,
            "llm_api_key": _read_secret_reference(environ, llm.secret_env_var)
            if llm.authentication == "environment" and not azure_llm
            else None,
            "azure_openai_endpoint": llm.endpoint if azure_llm else None,
            "azure_openai_deployment": llm.model if azure_llm else None,
            "azure_openai_api_version": llm.api_version if azure_llm else None,
            "azure_openai_api_key": _read_secret_reference(environ, llm.secret_env_var)
            if llm.authentication == "environment" and azure_llm
            else None,
            "llm_timeout_seconds": llm.timeout_seconds,
            "llm_max_tokens": llm.max_output_tokens,
            "stt": stt.provider if stt.provider in {"faster_whisper", "azure"} else "",
            "tts": configuration.tts.provider,
            "azure_speech_region": stt.region,
            "azure_speech_key": _read_secret_reference(environ, stt.secret_env_var)
            if stt.provider == "azure" and stt.secret_env_var
            else None,
            "web_search": search.provider,
            "web_search_result_limit": search.result_limit,
            "web_search_api_key": _read_secret_reference(environ, search.secret_env_var)
            if search.provider == "brave" and search.secret_env_var
            else None,
            "weather": configuration.weather.provider,
            "weather_default_location": configuration.weather.default_location,
            "weather_temperature_unit": configuration.weather.temperature_unit,
            "weather_timezone": configuration.weather.timezone,
        },
        "voice": {
            "language": stt.language,
            "audio_retention": False,
            "stt_model_path": stt.model_path if stt.provider == "faster_whisper" else None,
            "stt_device": stt.device,
            "stt_compute_type": stt.compute_type,
        },
        "workspace": {
            "allowed_file_types": configuration.workspace.allowed_file_types,
            "max_file_bytes": configuration.workspace.max_file_bytes,
        },
        "permissions": {
            "default_mode": configuration.permissions.default_mode,
            "approved_workspace_roots": configuration.workspace.approved_roots,
            "approved_website_origins": configuration.permissions.approved_websites,
            "approved_applications": configuration.permissions.approved_applications,
        },
    }
