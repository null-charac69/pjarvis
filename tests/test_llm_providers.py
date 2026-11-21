import json

import httpx
import pytest
from app.core.settings import ProviderSettings, Settings
from app.orchestration.models import UserCommand
from app.providers.factory import create_llm_provider
from app.providers.llm import ProviderError, UnconfiguredLLMProvider
from app.providers.mock import MockLLMProvider
from app.providers.openai_compatible import OpenAICompatibleLLMProvider
from pydantic import SecretStr, ValidationError


@pytest.mark.asyncio
async def test_mock_provider_classifies_and_summarizes_deterministically() -> None:
    provider = MockLLMProvider()
    proposal = await provider.create_plan(UserCommand(transcript="What time is it?"), [])

    assert proposal.intent.kind == "single_tool"
    assert proposal.steps[0].tool_call is not None
    assert proposal.steps[0].tool_call.tool_id == "system.datetime"
    assert await provider.create_response(UserCommand(transcript="time"), proposal, []) == (
        "Completed 0 tool step(s)."
    )


@pytest.mark.asyncio
async def test_openai_compatible_provider_uses_config_and_structured_json() -> None:
    captured: list[httpx.Request] = []
    proposal_json = {
        "intent": {
            "kind": "direct_response",
            "summary": "Answer conversationally.",
            "confidence": 1,
            "requires_tools": False,
        },
        "steps": [],
        "response_text": "Hello.",
    }

    def respond(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(proposal_json)}}]},
        )

    settings = ProviderSettings(
        llm="openai_compatible",
        llm_base_url="https://llm.operator.invalid/v1",
        llm_model="operator-selected-model",
        llm_api_key=SecretStr("provider-secret-value"),
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = OpenAICompatibleLLMProvider(settings, client=client)
        proposal = await provider.create_plan(UserCommand(transcript="Hello"), [])

    assert proposal.response_text == "Hello."
    request = captured[0]
    assert str(request.url) == "https://llm.operator.invalid/v1/chat/completions"
    assert request.headers["Authorization"] == "Bearer provider-secret-value"
    body = json.loads(request.content)
    assert body["model"] == "operator-selected-model"
    assert body["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_provider_health_and_failures_do_not_expose_credentials() -> None:
    def unavailable(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="Authorization: Bearer provider-secret-value")

    settings = ProviderSettings(
        llm="openai_compatible",
        llm_base_url="https://llm.operator.invalid/v1",
        llm_model="configured-model",
        llm_api_key=SecretStr("provider-secret-value"),
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(unavailable)) as client:
        provider = OpenAICompatibleLLMProvider(settings, client=client)
        health = await provider.health_check()
        with pytest.raises(ProviderError) as error:
            await provider.create_plan(UserCommand(transcript="hello"), [])

    assert health.status == "unavailable"
    assert error.value.error_code == "provider_unavailable"
    assert "provider-secret-value" not in str(error.value)


def test_llm_configuration_requires_operator_values_and_factory_handles_unconfigured() -> None:
    with pytest.raises(ValidationError, match="operator-supplied base URL and model"):
        ProviderSettings(llm="openai_compatible")

    settings = Settings(_env_file=None, providers={"llm": ""})
    provider = create_llm_provider(settings)

    assert isinstance(provider, UnconfiguredLLMProvider)
    assert provider.health_check is not None
