"""Safe setup-profile configuration operations."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, cast

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import ValidationError

from app.core.runtime_config import RuntimeConfiguration, settings_values
from app.core.settings import PermissionSettings, ProviderSettings, VoiceSettings
from app.providers.llm import ProviderHealth
from app.providers.openai_compatible import OpenAICompatibleLLMProvider
from app.providers.voice import (
    AzureSpeechToTextProvider,
    FasterWhisperSpeechToTextProvider,
    VoiceProviderHealth,
)
from app.schemas.common import ApiResponse
from app.services.runtime_configuration import (
    RuntimeConfigurationConflict,
    RuntimeConfigurationStore,
)

router = APIRouter(prefix="/configuration", tags=["configuration"])

_SUPPORTED_TTS = {"browser", "unconfigured"}
_SUPPORTED_STT = {"unconfigured", "faster_whisper", "azure"}


def _store(request: Request) -> RuntimeConfigurationStore:
    store = getattr(request.app.state, "runtime_configuration_store", None)
    if store is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Runtime configuration storage is unavailable.",
        )
    return cast(RuntimeConfigurationStore, store)


def _profile(body: dict[str, Any]) -> RuntimeConfiguration:
    try:
        return RuntimeConfiguration.model_validate(body)
    except ValidationError as exception:
        errors = [
            {"path": ".".join(str(part) for part in item["loc"]), "message": item["msg"]}
            for item in exception.errors(include_input=False)
        ]
        raise HTTPException(status_code=422, detail={"errors": errors}) from exception


def _configuration_issues(profile: RuntimeConfiguration) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    if profile.stt.provider not in _SUPPORTED_STT:
        issues.append(
            {
                "path": "stt.provider",
                "message": "This STT provider does not have a runtime adapter yet.",
            }
        )
    if profile.tts.provider not in _SUPPORTED_TTS:
        issues.append(
            {
                "path": "tts.provider",
                "message": "This TTS provider does not have a runtime adapter yet.",
            }
        )
    if profile.llm.provider == "azure_openai" and profile.llm.authentication != "environment":
        issues.append(
            {
                "path": "llm.authentication",
                "message": "Azure OpenAI requires an environment-backed secret reference.",
            }
        )
    if profile.stt.provider == "faster_whisper" and profile.stt.model_path:
        if not Path(profile.stt.model_path).is_dir():
            issues.append(
                {
                    "path": "stt.modelPath",
                    "message": "The selected local model directory does not exist.",
                }
            )

    environment_references: list[tuple[str, str | None]] = []
    if profile.llm.authentication == "environment":
        environment_references.append(("llm.secretEnvVar", profile.llm.secret_env_var))
    if profile.stt.provider == "azure":
        environment_references.append(("stt.secretEnvVar", profile.stt.secret_env_var))
    if profile.search.provider == "brave":
        environment_references.append(("search.secretEnvVar", profile.search.secret_env_var))
    for path, reference in environment_references:
        if reference and not os.environ.get(reference):
            issues.append(
                {
                    "path": path,
                    "message": (
                        "The referenced environment variable is not available to "
                        "the backend process."
                    ),
                }
            )

    values = settings_values(profile, dict(os.environ))
    permissions = PermissionSettings.model_validate(values["permissions"])
    for workspace in permissions.approved_workspace_roots:
        if not workspace.is_dir():
            issues.append(
                {
                    "path": "workspace.approvedRoots",
                    "message": "Every approved workspace must be an existing directory.",
                }
            )
    return issues


def _provider_classification(provider: str, endpoint_host: str | None = None) -> str:
    if provider in {"", "unconfigured"}:
        return "unconfigured"
    if provider == "mock":
        return "mock"
    if provider in {"faster_whisper", "browser", "piper"}:
        return "local"
    if provider == "openai_compatible":
        local_hosts = {"localhost", "127.0.0.1", "::1", "[::1]"}
        return "local" if endpoint_host in local_hosts else "external"
    return "external"


@router.get("")
async def get_configuration(request: Request) -> ApiResponse[dict[str, Any]]:
    profile, revision = _store(request).read()
    return ApiResponse(
        request_id=str(getattr(request.state, "request_id", "unknown")),
        data={
            "configuration": profile.model_dump(mode="json", by_alias=True),
            "revision": revision,
            "restartRequired": bool(
                getattr(request.app.state, "configuration_restart_required", False)
            ),
        },
    )


@router.get("/status")
async def get_runtime_status(request: Request) -> ApiResponse[dict[str, Any]]:
    settings = request.app.state.settings
    providers = settings.providers
    return ApiResponse(
        request_id=str(getattr(request.state, "request_id", "unknown")),
        data={
            "restartRequired": bool(
                getattr(request.app.state, "configuration_restart_required", False)
            ),
            "providers": {
                "llm": _provider_classification(
                    providers.llm,
                    providers.llm_base_url.host if providers.llm_base_url else None,
                ),
                "stt": _provider_classification(providers.stt),
                "tts": _provider_classification(providers.tts),
                "search": _provider_classification(providers.web_search),
                "weather": _provider_classification(providers.weather),
            }
        },
    )


@router.post("/validate")
async def validate_configuration(
    request: Request, body: dict[str, Any]
) -> ApiResponse[dict[str, Any]]:
    profile = _profile(body)
    issues = _configuration_issues(profile)
    return ApiResponse(
        request_id=str(getattr(request.state, "request_id", "unknown")),
        data={"valid": not issues, "issues": issues},
    )


@router.post("/test")
async def test_provider(request: Request, body: dict[str, Any]) -> ApiResponse[dict[str, Any]]:
    component = body.get("component")
    if component not in {"llm", "stt"}:
        raise HTTPException(status_code=422, detail="Select a supported provider test target.")
    profile_data = body.get("configuration")
    if not isinstance(profile_data, dict):
        raise HTTPException(status_code=422, detail="A configuration profile is required.")
    profile = _profile(profile_data)
    issues = _configuration_issues(profile)
    if issues:
        return ApiResponse(
            request_id=str(getattr(request.state, "request_id", "unknown")),
            data={"status": "not_tested", "issues": issues},
        )

    values = settings_values(profile, dict(os.environ))
    providers = ProviderSettings.model_validate(values["providers"])
    voice = VoiceSettings.model_validate(values["voice"])
    health: ProviderHealth | VoiceProviderHealth
    if component == "llm":
        if profile.llm.provider == "unconfigured":
            health = ProviderHealth(status="unconfigured", message="No LLM provider is selected.")
        else:
            health = await OpenAICompatibleLLMProvider(providers).health_check()
    elif profile.stt.provider == "faster_whisper":
        health = await FasterWhisperSpeechToTextProvider(
            model_path=voice.stt_model_path or Path(),
            device=voice.stt_device,
            compute_type=voice.stt_compute_type,
        ).health_check()
    elif profile.stt.provider == "azure":
        speech_key = providers.azure_speech_key
        health = await AzureSpeechToTextProvider(
            profile.stt.region or "",
            speech_key.get_secret_value() if speech_key else "",
        ).health_check()
    else:
        health = VoiceProviderHealth(status="unconfigured", message="No STT provider is selected.")
    return ApiResponse(
        request_id=str(getattr(request.state, "request_id", "unknown")),
        data={"status": health.status, "message": health.message},
    )


@router.post("/save")
async def save_configuration(request: Request, body: dict[str, Any]) -> ApiResponse[dict[str, Any]]:
    profile_data = body.get("configuration")
    expected_revision = body.get("expectedRevision")
    if not isinstance(profile_data, dict) or not isinstance(expected_revision, str):
        raise HTTPException(status_code=422, detail="Configuration and revision are required.")
    profile = _profile(profile_data)
    issues = _configuration_issues(profile)
    if issues:
        return ApiResponse(
            request_id=str(getattr(request.state, "request_id", "unknown")),
            data={"saved": False, "issues": issues},
        )
    try:
        revision = _store(request).save(
            profile, expected_revision=expected_revision, actor="local-user"
        )
    except RuntimeConfigurationConflict as exception:
        raise HTTPException(
            status_code=409, detail="Configuration changed; reload before saving."
        ) from exception
    request.app.state.configuration_restart_required = True
    return ApiResponse(
        request_id=str(getattr(request.state, "request_id", "unknown")),
        data={"saved": True, "revision": revision, "restartRequired": True},
    )


@router.post("/rollback")
async def rollback_configuration(
    request: Request, body: dict[str, Any]
) -> ApiResponse[dict[str, Any]]:
    expected_revision = body.get("expectedRevision")
    if not isinstance(expected_revision, str):
        raise HTTPException(status_code=422, detail="Configuration revision is required.")
    try:
        revision = _store(request).rollback(expected_revision=expected_revision, actor="local-user")
    except RuntimeConfigurationConflict as exception:
        raise HTTPException(
            status_code=409, detail="Configuration changed; reload before rollback."
        ) from exception
    except FileNotFoundError as exception:
        raise HTTPException(status_code=409, detail=str(exception)) from exception
    request.app.state.configuration_restart_required = True
    return ApiResponse(
        request_id=str(getattr(request.state, "request_id", "unknown")),
        data={"rolledBack": True, "revision": revision, "restartRequired": True},
    )
