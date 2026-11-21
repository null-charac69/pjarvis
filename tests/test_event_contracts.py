from uuid import uuid4

import pytest
from app.schemas.events import EVENT_ADAPTER, AssistantStateChanged
from pydantic import ValidationError


def test_event_envelope_uses_documented_wire_names() -> None:
    event = EVENT_ADAPTER.validate_python(
        {
            "type": "assistant.state.changed",
            "correlationId": str(uuid4()),
            "payload": {"state": "Sleeping"},
        }
    )

    assert isinstance(event, AssistantStateChanged)
    wire_event = event.model_dump(mode="json", by_alias=True)
    assert wire_event["schemaVersion"] == 1
    assert "eventId" in wire_event
    assert "occurredAt" in wire_event
    assert "correlationId" in wire_event


def test_event_payload_rejects_invalid_state_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        EVENT_ADAPTER.validate_python(
            {
                "type": "assistant.state.changed",
                "correlationId": str(uuid4()),
                "payload": {"state": "Pretending to execute", "secret": "not allowed"},
            }
        )


def test_phase_six_voice_event_variants_validate_with_camel_case_payloads() -> None:
    session_id = str(uuid4())
    playback_id = str(uuid4())
    events = [
        ("voice.recording.started", {"sessionId": session_id}),
        ("voice.recording.stopped", {"sessionId": session_id, "reason": "no_speech"}),
        ("voice.audio.level", {"level": 0.25, "durationMs": 1200}),
        ("voice.speech.started", {"sessionId": session_id}),
        ("voice.speech.ended", {"sessionId": session_id, "durationMs": 900}),
        (
            "voice.transcription.failed",
            {"sessionId": session_id, "errorCode": "transcription_failed"},
        ),
        ("audio.playback.progress", {"playbackId": playback_id, "progress": 0.5, "elapsedMs": 450}),
        ("audio.playback.completed", {"playbackId": playback_id}),
        ("voice.provider.health.changed", {"provider": "vad", "status": "healthy"}),
    ]

    for event_type, payload in events:
        event = EVENT_ADAPTER.validate_python(
            {"type": event_type, "correlationId": session_id, "payload": payload}
        )
        assert event.type == event_type


def test_voice_audio_level_rejects_out_of_range_values() -> None:
    with pytest.raises(ValidationError):
        EVENT_ADAPTER.validate_python(
            {
                "type": "voice.audio.level",
                "correlationId": str(uuid4()),
                "payload": {"level": 1.1, "durationMs": 20},
            }
        )
