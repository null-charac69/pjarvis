"""Select an LLM adapter from validated application settings."""

from app.core.settings import Settings
from app.providers.llm import LLMProvider, UnconfiguredLLMProvider
from app.providers.mock import MockLLMProvider
from app.providers.openai_compatible import OpenAICompatibleLLMProvider


def create_llm_provider(settings: Settings) -> LLMProvider:
    provider = settings.providers.llm
    if provider == "mock":
        return MockLLMProvider()
    if provider in {"openai_compatible", "azure_openai"}:
        return OpenAICompatibleLLMProvider(settings.providers)
    return UnconfiguredLLMProvider()
