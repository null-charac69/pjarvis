from __future__ import annotations

from uuid import UUID, uuid4

from app.providers.voice import Transcription, VoiceProviderError, VoiceProviderHealth


class FakeSpeechToTextProvider:
    def __init__(self) -> None:
        self.audio: bytes | None = None

    async def health_check(self) -> VoiceProviderHealth:
        return VoiceProviderHealth(status="healthy", message="Ready.")

    async def transcribe(self, audio: bytes, content_type: str, language: str) -> Transcription:
        self.audio = audio
        return Transcription(text="Check system health", language=language, provider="test")


class FakeWakeWordDetector:
    async def health_check(self) -> VoiceProviderHealth:
        return VoiceProviderHealth(status="healthy", message="Ready.")

    async def detect(self, pcm_audio: bytes) -> bool:
        return True


class FailingSpeechToTextProvider(FakeSpeechToTextProvider):
    async def transcribe(self, audio: bytes, content_type: str, language: str) -> Transcription:
        raise VoiceProviderError("stt_failed")


class CapturingEventHub:
    def __init__(self) -> None:
        self.events = []

    async def publish(self, event) -> None:
        self.events.append(event)


def test_voice_health_is_unconfigured_without_an_explicit_local_model(client) -> None:
    response = client.get("/api/v1/voice/health")

    assert response.status_code == 200
    assert response.json()["data"]["stt"]["status"] == "unconfigured"
    assert "wakeWord" in response.json()["data"]
    assert "wake_word" not in response.json()["data"]


def test_voice_health_emits_events_only_when_provider_status_changes(api_app, client) -> None:
    api_app.state.stt_provider = FakeSpeechToTextProvider()
    api_app.state.wake_detector = FakeWakeWordDetector()
    event_hub = CapturingEventHub()
    api_app.state.event_hub = event_hub

    assert client.get("/api/v1/voice/health").status_code == 200
    assert client.get("/api/v1/voice/health").status_code == 200

    assert [event.type for event in event_hub.events] == [
        "voice.provider.health.changed",
        "voice.provider.health.changed",
    ]
    assert {event.payload.provider for event in event_hub.events} == {"stt", "wake_word"}


def test_transcription_rejects_unsupported_audio_without_calling_provider(api_app, client) -> None:
    provider = FakeSpeechToTextProvider()
    api_app.state.stt_provider = provider

    response = client.post(
        "/api/v1/voice/transcriptions",
        params={"session_id": str(uuid4())},
        content=b"not audio",
        headers={"Content-Type": "application/octet-stream"},
    )

    assert response.status_code == 415
    assert provider.audio is None


def test_transcription_is_bounded_and_emits_only_transcript_metadata(api_app, client) -> None:
    provider = FakeSpeechToTextProvider()
    event_hub = CapturingEventHub()
    api_app.state.stt_provider = provider
    api_app.state.event_hub = event_hub
    session_id = uuid4()
    audio = b"opaque-audio-bytes"

    response = client.post(
        "/api/v1/voice/transcriptions",
        params={"session_id": str(session_id), "final": "false", "sequence": 3},
        content=audio,
        headers={"Content-Type": "audio/webm"},
    )

    assert response.status_code == 200
    assert provider.audio == audio
    assert response.json()["data"] == {
        "sessionId": str(session_id),
        "text": "Check system health",
        "language": "en-IN",
        "provider": "test",
    }
    event = event_hub.events[0]
    assert event.type == "voice.transcript.partial"
    assert event.correlation_id == session_id
    assert event.payload.text == "Check system health"
    assert event.payload.sequence == 3
    assert "audio" not in event.model_dump_json().lower()


def test_final_transcription_event_uses_voice_session_id(api_app, client) -> None:
    api_app.state.stt_provider = FakeSpeechToTextProvider()
    event_hub = CapturingEventHub()
    api_app.state.event_hub = event_hub
    session_id = uuid4()

    response = client.post(
        "/api/v1/voice/transcriptions",
        params={"session_id": str(session_id)},
        content=b"opaque-audio-bytes",
        headers={"Content-Type": "audio/webm"},
    )

    assert response.status_code == 200
    event = event_hub.events[0]
    assert event.type == "voice.transcript.final"
    assert event.payload.command_id == UUID(response.json()["data"]["sessionId"])
    assert event.payload.text == "Check system health"


def test_transcription_rejects_empty_audio(client) -> None:
    response = client.post(
        "/api/v1/voice/transcriptions",
        params={"session_id": str(uuid4())},
        content=b"",
        headers={"Content-Type": "audio/webm"},
    )

    assert response.status_code == 422


def test_provider_transcription_failure_emits_safe_typed_failure_event(api_app, client) -> None:
    api_app.state.stt_provider = FailingSpeechToTextProvider()
    event_hub = CapturingEventHub()
    api_app.state.event_hub = event_hub
    session_id = uuid4()

    response = client.post(
        "/api/v1/voice/transcriptions",
        params={"session_id": str(session_id)},
        content=b"opaque-audio-bytes",
        headers={"Content-Type": "audio/webm"},
    )

    assert response.status_code == 503
    assert event_hub.events[0].type == "voice.transcription.failed"
    assert event_hub.events[0].payload.session_id == session_id
    assert event_hub.events[0].payload.error_code == "stt_failed"


def test_transcription_rejects_oversized_audio(client) -> None:
    response = client.post(
        "/api/v1/voice/transcriptions",
        params={"session_id": str(uuid4())},
        content=b"x" * (12 * 1024 * 1024 + 1),
        headers={"Content-Type": "audio/webm"},
    )

    assert response.status_code == 413


def test_wake_detection_requires_complete_local_pcm_frames(client) -> None:
    response = client.post(
        "/api/v1/voice/wakeword",
        params={"session_id": str(uuid4())},
        content=b"\x00\x00",
        headers={"Content-Type": "application/octet-stream"},
    )

    assert response.status_code == 422


def test_wake_detection_emits_event_only_on_provider_detection(api_app, client) -> None:
    api_app.state.wake_detector = FakeWakeWordDetector()
    event_hub = CapturingEventHub()
    api_app.state.event_hub = event_hub
    session_id = uuid4()

    response = client.post(
        "/api/v1/voice/wakeword",
        params={"session_id": str(session_id)},
        content=b"\x00" * 2560,
        headers={"Content-Type": "application/octet-stream"},
    )

    assert response.status_code == 200
    assert response.json()["data"]["detected"] is True
    assert event_hub.events[0].type == "voice.wakeword.detected"
    assert event_hub.events[0].payload.phrase == "Jarvis"
