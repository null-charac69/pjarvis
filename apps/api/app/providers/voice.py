"""Optional local speech-to-text adapter with no automatic model downloads."""

from __future__ import annotations

import asyncio
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict

from app.core.settings import Settings

AUDIO_SUFFIXES = {
    "audio/webm": ".webm",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".mp4",
}


class VoiceProviderError(Exception):
    """A safe, stable voice-provider failure."""

    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


class VoiceProviderHealth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["healthy", "degraded", "unavailable", "unconfigured"]
    message: str


class Transcription(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    language: str
    provider: str


class SpeechToTextProvider(Protocol):
    async def health_check(self) -> VoiceProviderHealth: ...

    async def transcribe(self, audio: bytes, content_type: str, language: str) -> Transcription: ...


class WakeWordDetector(Protocol):
    async def health_check(self) -> VoiceProviderHealth: ...

    async def detect(self, pcm_audio: bytes) -> bool: ...


class UnconfiguredSpeechToTextProvider:
    async def health_check(self) -> VoiceProviderHealth:
        return VoiceProviderHealth(
            status="unconfigured",
            message="Select faster_whisper and configure an existing local model path.",
        )

    async def transcribe(self, audio: bytes, content_type: str, language: str) -> Transcription:
        raise VoiceProviderError("stt_unconfigured")


class UnconfiguredWakeWordDetector:
    async def health_check(self) -> VoiceProviderHealth:
        return VoiceProviderHealth(
            status="unconfigured",
            message="Select openwakeword and configure an existing local model file.",
        )

    async def detect(self, pcm_audio: bytes) -> bool:
        raise VoiceProviderError("wake_unconfigured")


class FasterWhisperSpeechToTextProvider:
    def __init__(
        self,
        model_path: Path,
        device: str,
        compute_type: str,
        model_loader: Callable[..., Any] | None = None,
    ) -> None:
        self._model_path = model_path
        self._device = device
        self._compute_type = compute_type
        self._model_loader = model_loader
        self._model: Any = None
        self._load_lock = asyncio.Lock()

    async def health_check(self) -> VoiceProviderHealth:
        if not self._model_path.is_dir():
            return VoiceProviderHealth(
                status="unconfigured",
                message="The configured local speech model directory is unavailable.",
            )
        try:
            await self._load_model()
        except VoiceProviderError:
            return VoiceProviderHealth(
                status="unavailable",
                message="The local speech provider could not be loaded.",
            )
        return VoiceProviderHealth(status="healthy", message="Local speech recognition is ready.")

    async def transcribe(self, audio: bytes, content_type: str, language: str) -> Transcription:
        model = await self._load_model()
        suffix = AUDIO_SUFFIXES[content_type]
        path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                prefix="jarvis-audio-", suffix=suffix, delete=False
            ) as file:
                file.write(audio)
                path = file.name
            segments, _ = await asyncio.to_thread(
                model.transcribe, path, language=language.split("-")[0]
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            if not text:
                raise VoiceProviderError("transcript_empty")
            return Transcription(text=text, language=language, provider="faster_whisper")
        except VoiceProviderError:
            raise
        except Exception as exception:
            raise VoiceProviderError("stt_failed") from exception
        finally:
            if path is not None:
                await asyncio.to_thread(Path(path).unlink, missing_ok=True)

    async def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        async with self._load_lock:
            if self._model is not None:
                return self._model
            if not self._model_path.is_dir():
                raise VoiceProviderError("stt_model_unavailable")
            try:
                loader = self._model_loader
                if loader is None:
                    from faster_whisper import WhisperModel

                    loader = WhisperModel
                self._model = await asyncio.to_thread(
                    loader,
                    str(self._model_path),
                    device=self._device,
                    compute_type=self._compute_type,
                    local_files_only=True,
                )
            except Exception as exception:
                raise VoiceProviderError("stt_provider_unavailable") from exception
            return self._model


class AzureSpeechToTextProvider:
    def __init__(self, region: str, subscription_key: str) -> None:
        self._region = region
        self._subscription_key = subscription_key

    async def health_check(self) -> VoiceProviderHealth:
        try:
            import azure.cognitiveservices.speech  # noqa: F401
        except ImportError:
            return VoiceProviderHealth(
                status="unavailable",
                message="The optional Azure Speech SDK is not installed.",
            )
        return VoiceProviderHealth(
            status="degraded",
            message="Azure Speech is configured; credentials are checked on the first request.",
        )

    async def transcribe(self, audio: bytes, content_type: str, language: str) -> Transcription:
        if content_type != "audio/wav":
            raise VoiceProviderError("stt_unsupported_audio_format")
        suffix = AUDIO_SUFFIXES[content_type]
        path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                prefix="jarvis-audio-", suffix=suffix, delete=False
            ) as file:
                path = file.name
                file.write(audio)
            text = await asyncio.to_thread(self._recognize_file, path, language)
            if not text:
                raise VoiceProviderError("transcript_empty")
            return Transcription(text=text, language=language, provider="azure")
        except VoiceProviderError:
            raise
        except Exception as exception:
            raise VoiceProviderError("stt_failed") from exception
        finally:
            if path is not None:
                await asyncio.to_thread(Path(path).unlink, missing_ok=True)

    def _recognize_file(self, path: str, language: str) -> str:
        import azure.cognitiveservices.speech as speechsdk

        speech_config = speechsdk.SpeechConfig(
            subscription=self._subscription_key,
            region=self._region,
        )
        speech_config.speech_recognition_language = language
        audio_config = speechsdk.audio.AudioConfig(filename=path)
        recognizer = speechsdk.SpeechRecognizer(
            speech_config=speech_config,
            audio_config=audio_config,
        )
        result = recognizer.recognize_once_async().get()
        if result.reason == speechsdk.ResultReason.NoMatch:
            return ""
        if result.reason != speechsdk.ResultReason.RecognizedSpeech:
            raise VoiceProviderError("stt_failed")
        text = result.text
        if not isinstance(text, str):
            raise VoiceProviderError("stt_failed")
        return text.strip()


class OpenWakeWordDetector:
    def __init__(
        self,
        model_path: Path,
        threshold: float,
        model_loader: Callable[..., Any] | None = None,
    ) -> None:
        self._model_path = model_path
        self._threshold = threshold
        self._model_loader = model_loader
        self._model: Any = None
        self._load_lock = asyncio.Lock()
        self._predict_lock = asyncio.Lock()

    async def health_check(self) -> VoiceProviderHealth:
        if not self._model_path.is_file():
            return VoiceProviderHealth(
                status="unconfigured",
                message="The configured local wake-word model file is unavailable.",
            )
        try:
            await self._load_model()
        except VoiceProviderError:
            return VoiceProviderHealth(
                status="unavailable",
                message="The local wake-word provider could not be loaded.",
            )
        return VoiceProviderHealth(status="healthy", message="Local wake-word detection is ready.")

    async def detect(self, pcm_audio: bytes) -> bool:
        if not pcm_audio or len(pcm_audio) % 2560 != 0:
            raise VoiceProviderError("wake_audio_invalid")
        model = await self._load_model()
        async with self._predict_lock:
            try:
                return await asyncio.to_thread(self._predict, model, pcm_audio)
            except Exception as exception:
                raise VoiceProviderError("wake_detection_failed") from exception

    async def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        async with self._load_lock:
            if self._model is not None:
                return self._model
            if not self._model_path.is_file():
                raise VoiceProviderError("wake_model_unavailable")
            try:
                loader = self._model_loader
                if loader is None:
                    from openwakeword.model import Model

                    loader = Model
                self._model = await asyncio.to_thread(
                    loader,
                    wakeword_models=[str(self._model_path)],
                    inference_framework="onnx",
                )
            except Exception as exception:
                raise VoiceProviderError("wake_provider_unavailable") from exception
            return self._model

    def _predict(self, model: Any, pcm_audio: bytes) -> bool:
        import numpy as np

        scores = model.predict(np.frombuffer(pcm_audio, dtype=np.int16))
        return any(float(score) >= self._threshold for score in scores.values())


def create_stt_provider(settings: Settings) -> SpeechToTextProvider:
    if settings.providers.stt == "faster_whisper" and settings.voice.stt_model_path is not None:
        return FasterWhisperSpeechToTextProvider(
            model_path=settings.voice.stt_model_path,
            device=settings.voice.stt_device,
            compute_type=settings.voice.stt_compute_type,
        )
    if settings.providers.stt == "azure":
        key = settings.providers.azure_speech_key
        region = settings.providers.azure_speech_region
        if key is not None and region:
            return AzureSpeechToTextProvider(region, key.get_secret_value())
    return UnconfiguredSpeechToTextProvider()


def create_wake_detector(settings: Settings) -> WakeWordDetector:
    if (
        settings.providers.wake_word == "openwakeword"
        and settings.voice.wake_model_path is not None
    ):
        return OpenWakeWordDetector(
            model_path=settings.voice.wake_model_path,
            threshold=settings.voice.wake_threshold,
        )
    return UnconfiguredWakeWordDetector()
