from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from app.providers.voice import (
    AzureSpeechToTextProvider,
    FasterWhisperSpeechToTextProvider,
    OpenWakeWordDetector,
    VoiceProviderError,
)


class FakeWhisperModel:
    def __init__(self) -> None:
        self.audio_path: str | None = None

    def transcribe(self, audio_path: str, language: str) -> tuple[list[object], object]:
        self.audio_path = audio_path
        assert Path(audio_path).read_bytes() == b"test-audio"
        assert language == "en"
        return [SimpleNamespace(text=" recognized words ")], object()


@pytest.mark.asyncio
async def test_faster_whisper_uses_local_model_and_cleans_temporary_audio(tmp_path) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    model = FakeWhisperModel()
    loader_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def load_model(*args: object, **kwargs: object) -> FakeWhisperModel:
        loader_calls.append((args, kwargs))
        return model

    provider = FasterWhisperSpeechToTextProvider(model_path, "cpu", "int8", model_loader=load_model)
    result = await provider.transcribe(b"test-audio", "audio/webm", "en-IN")

    assert result.text == "recognized words"
    assert result.provider == "faster_whisper"
    assert loader_calls[0][1]["local_files_only"] is True
    assert model.audio_path is not None
    assert not await asyncio.to_thread(Path(model.audio_path).exists)


@pytest.mark.asyncio
async def test_faster_whisper_does_not_load_or_download_missing_model(tmp_path) -> None:
    loader_called = False

    def load_model(*args: object, **kwargs: object) -> FakeWhisperModel:
        nonlocal loader_called
        loader_called = True
        return FakeWhisperModel()

    provider = FasterWhisperSpeechToTextProvider(
        tmp_path / "missing", "cpu", "int8", model_loader=load_model
    )

    with pytest.raises(VoiceProviderError, match="stt_model_unavailable"):
        await provider.transcribe(b"test-audio", "audio/webm", "en-IN")
    assert loader_called is False


@pytest.mark.asyncio
async def test_openwakeword_uses_only_configured_model_file(tmp_path, monkeypatch) -> None:
    model_path = tmp_path / "jarvis.onnx"
    model_path.write_bytes(b"model")
    loader_calls: list[dict[str, object]] = []

    class FakeWakeModel:
        def predict(self, samples: bytes) -> dict[str, float]:
            assert samples == b"\x00" * 2560
            return {"jarvis": 0.9}

    def load_model(**kwargs: object) -> FakeWakeModel:
        loader_calls.append(kwargs)
        return FakeWakeModel()

    class FakeNumpy:
        int16 = "int16"

        @staticmethod
        def frombuffer(audio: bytes, dtype: str) -> bytes:
            assert dtype == "int16"
            return audio

    monkeypatch.setitem(__import__("sys").modules, "numpy", FakeNumpy)
    detector = OpenWakeWordDetector(model_path, 0.65, model_loader=load_model)

    assert await detector.detect(b"\x00" * 2560) is True
    assert loader_calls == [{"wakeword_models": [str(model_path)], "inference_framework": "onnx"}]


@pytest.mark.asyncio
async def test_openwakeword_rejects_missing_model_without_loading(tmp_path) -> None:
    loader_called = False

    def load_model(**kwargs: object) -> FakeWhisperModel:
        nonlocal loader_called
        loader_called = True
        return FakeWhisperModel()

    detector = OpenWakeWordDetector(tmp_path / "missing.onnx", 0.65, model_loader=load_model)

    with pytest.raises(VoiceProviderError, match="wake_model_unavailable"):
        await detector.detect(b"\x00" * 2560)
    assert loader_called is False


@pytest.mark.asyncio
async def test_azure_stt_rejects_non_wav_without_loading_sdk() -> None:
    provider = AzureSpeechToTextProvider("test-region", "test-key")

    with pytest.raises(VoiceProviderError, match="stt_unsupported_audio_format"):
        await provider.transcribe(b"webm", "audio/webm", "en-IN")


@pytest.mark.asyncio
async def test_azure_stt_processes_wav_and_cleans_temporary_audio(tmp_path, monkeypatch) -> None:
    provider = AzureSpeechToTextProvider("test-region", "test-key")
    observed: dict[str, str] = {}

    def recognize(path: str, language: str) -> str:
        observed["path"] = path
        observed["language"] = language
        assert Path(path).read_bytes() == b"wav-data"
        return "recognized locally in test"

    monkeypatch.setattr(provider, "_recognize_file", recognize)
    result = await provider.transcribe(b"wav-data", "audio/wav", "en-IN")

    assert result.text == "recognized locally in test"
    assert result.language == "en-IN"
    assert observed["language"] == "en-IN"
    assert not await asyncio.to_thread(Path(observed["path"]).exists)
