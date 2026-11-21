"""Bounded local voice transcription endpoints."""

from __future__ import annotations

from typing import Literal, cast
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.providers.voice import (
    SpeechToTextProvider,
    Transcription,
    VoiceProviderError,
    VoiceProviderHealth,
    WakeWordDetector,
)
from app.schemas.common import ApiResponse
from app.schemas.events import (
    FinalTranscriptPayload,
    PartialTranscriptPayload,
    VoiceProviderHealthChanged,
    VoiceProviderHealthChangedPayload,
    VoiceTranscriptFinal,
    VoiceTranscriptionFailed,
    VoiceTranscriptionFailedPayload,
    VoiceTranscriptPartial,
    VoiceWakewordDetected,
    WakeWordPayload,
)
from app.services.event_hub import EventHub

MAX_AUDIO_BYTES = 12 * 1024 * 1024
MAX_WAKE_AUDIO_BYTES = 64 * 1024
ALLOWED_CONTENT_TYPES = {"audio/webm", "audio/wav", "audio/ogg", "audio/mp4"}

router = APIRouter(prefix="/voice", tags=["voice"])


class TranscriptionResponse(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        populate_by_name=True,
    )

    session_id: UUID
    text: str
    language: str
    provider: str


class VoiceHealth(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        populate_by_name=True,
    )

    stt: VoiceProviderHealth
    wake_word: VoiceProviderHealth


class WakeDetectionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detected: bool


def _provider(request: Request) -> SpeechToTextProvider:
    return cast(SpeechToTextProvider, request.app.state.stt_provider)


def _wake_detector(request: Request) -> WakeWordDetector:
    return cast(WakeWordDetector, request.app.state.wake_detector)


def _request_id(request: Request) -> str:
    return str(getattr(request.state, "request_id", "unknown"))


async def _read_bounded_audio(request: Request) -> bytes:
    content_type = request.headers.get("content-type", "").split(";", maxsplit=1)[0].strip().lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported audio format.")
    try:
        content_length = int(request.headers.get("content-length", "0"))
    except ValueError as exception:
        raise HTTPException(status_code=400, detail="Invalid audio content length.") from exception
    if content_length > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio exceeds the size limit.")

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Audio exceeds the size limit.")
        chunks.append(chunk)
    if total == 0:
        raise HTTPException(status_code=422, detail="Audio is empty.")
    return b"".join(chunks)


@router.get("/health", response_model=ApiResponse[VoiceHealth])
async def voice_health(request: Request) -> ApiResponse[VoiceHealth]:
    stt_health = await _provider(request).health_check()
    wake_health = await _wake_detector(request).health_check()
    health_by_provider: dict[Literal["stt", "wake_word"], VoiceProviderHealth] = {
        "stt": stt_health,
        "wake_word": wake_health,
    }
    previous_health = getattr(request.app.state, "voice_health_snapshot", {})
    event_hub = cast(EventHub, request.app.state.event_hub)
    for provider, health in health_by_provider.items():
        if previous_health.get(provider) != health.status:
            await event_hub.publish(
                VoiceProviderHealthChanged(
                    type="voice.provider.health.changed",
                    correlation_id=(
                        UUID(_request_id(request))
                        if _request_id(request) != "unknown"
                        else UUID(int=0)
                    ),
                    payload=VoiceProviderHealthChangedPayload(
                        provider=provider,
                        status=health.status,
                    ),
                )
            )
    request.app.state.voice_health_snapshot = {
        provider: health.status for provider, health in health_by_provider.items()
    }
    return ApiResponse(
        request_id=_request_id(request),
        data=VoiceHealth(stt=stt_health, wake_word=wake_health),
    )


@router.post("/wakeword", response_model=ApiResponse[WakeDetectionResponse])
async def detect_wakeword(request: Request, session_id: UUID) -> ApiResponse[WakeDetectionResponse]:
    content_type = request.headers.get("content-type", "").split(";", maxsplit=1)[0].strip().lower()
    if content_type != "application/octet-stream":
        raise HTTPException(status_code=415, detail="Wake audio must be 16 kHz mono PCM.")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_WAKE_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Wake audio exceeds the size limit.")
        chunks.append(chunk)
    pcm_audio = b"".join(chunks)
    if not pcm_audio or len(pcm_audio) % 2560 != 0:
        raise HTTPException(
            status_code=422,
            detail="Wake audio must contain complete 80 ms PCM frames.",
        )
    try:
        detected = await _wake_detector(request).detect(pcm_audio)
    except VoiceProviderError as exception:
        raise HTTPException(status_code=503, detail=exception.error_code) from exception
    if detected:
        await cast(EventHub, request.app.state.event_hub).publish(
            VoiceWakewordDetected(
                type="voice.wakeword.detected",
                correlation_id=session_id,
                payload=WakeWordPayload(phrase=request.app.state.settings.voice.wake_phrase),
            )
        )
    return ApiResponse(
        request_id=_request_id(request),
        data=WakeDetectionResponse(detected=detected),
    )


@router.post("/transcriptions", response_model=ApiResponse[TranscriptionResponse])
async def transcribe_audio(
    request: Request,
    session_id: UUID,
    final: bool = Query(default=True),
    sequence: int = Query(default=0, ge=0),
) -> ApiResponse[TranscriptionResponse]:
    audio = await _read_bounded_audio(request)
    content_type = request.headers.get("content-type", "").split(";", maxsplit=1)[0].strip().lower()
    language = request.app.state.settings.voice.language
    try:
        result: Transcription = await _provider(request).transcribe(audio, content_type, language)
    except VoiceProviderError as exception:
        await cast(EventHub, request.app.state.event_hub).publish(
            VoiceTranscriptionFailed(
                type="voice.transcription.failed",
                correlation_id=session_id,
                payload=VoiceTranscriptionFailedPayload(
                    session_id=session_id,
                    error_code=exception.error_code,
                ),
            )
        )
        error_status = {
            "transcript_empty": status.HTTP_422_UNPROCESSABLE_CONTENT,
            "stt_unsupported_audio_format": status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        }.get(exception.error_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        raise HTTPException(status_code=error_status, detail=exception.error_code) from exception

    event_hub = cast(EventHub, request.app.state.event_hub)
    if final:
        await event_hub.publish(
            VoiceTranscriptFinal(
                type="voice.transcript.final",
                correlation_id=session_id,
                payload=FinalTranscriptPayload(
                    command_id=session_id, text=result.text, language=result.language
                ),
            )
        )
    else:
        await event_hub.publish(
            VoiceTranscriptPartial(
                type="voice.transcript.partial",
                correlation_id=session_id,
                payload=PartialTranscriptPayload(text=result.text, sequence=sequence),
            )
        )
    return ApiResponse(
        request_id=_request_id(request),
        data=TranscriptionResponse(
            session_id=session_id,
            text=result.text,
            language=result.language,
            provider=result.provider,
        ),
    )
