import pytest
from app.core.runtime_config import RuntimeConfiguration, settings_values
from app.core.settings import ProviderSettings
from pydantic import ValidationError


def test_llm_configuration_allows_loopback_http_and_variable_references() -> None:
    configuration = RuntimeConfiguration.model_validate(
        {
            "llm": {
                "provider": "local_openai_compatible",
                "endpoint": "http://127.0.0.1:8000/v1",
                "model": "qwen-test",
                "authentication": "environment",
                "secretEnvVar": "JARVIS_TEST_LLM_SECRET",
            }
        }
    )

    serialized = configuration.model_dump_json()
    assert "JARVIS_TEST_LLM_SECRET" in serialized
    assert "sensitive-test-value" not in serialized
    values = settings_values(configuration, {"JARVIS_TEST_LLM_SECRET": "sensitive-test-value"})
    assert values["providers"]["llm_api_key"] == "sensitive-test-value"


def test_remote_llm_endpoint_allows_http() -> None:
    configuration = RuntimeConfiguration.model_validate(
        {
            "llm": {
                "provider": "other_openai_compatible",
                "endpoint": "http://api.example.test/v1",
                "model": "hosted-model",
                "authentication": "environment",
                "secretEnvVar": "JARVIS_TEST_LLM_SECRET",
            }
        }
    )
    providers = ProviderSettings.model_validate(
        settings_values(configuration, {"JARVIS_TEST_LLM_SECRET": "test-only-value"})[
            "providers"
        ]
    )

    assert configuration.llm.endpoint == "http://api.example.test/v1"
    assert providers.llm_base_url is not None
    assert str(providers.llm_base_url) == "http://api.example.test/v1"


def test_remote_stt_endpoint_still_requires_https() -> None:
    with pytest.raises(ValidationError):
        RuntimeConfiguration.model_validate(
            {
                "stt": {
                    "provider": "openai_compatible",
                    "endpoint": "http://speech.example.test/v1",
                    "model": "hosted-model",
                    "secretEnvVar": "JARVIS_TEST_STT_SECRET",
                }
            }
        )


def test_azure_llm_endpoint_still_requires_https() -> None:
    with pytest.raises(ValidationError):
        RuntimeConfiguration.model_validate(
            {
                "llm": {
                    "provider": "azure_openai",
                    "endpoint": "http://azure.example.test",
                    "model": "hosted-model",
                    "apiVersion": "2024-01-01",
                    "authentication": "environment",
                    "secretEnvVar": "JARVIS_TEST_LLM_SECRET",
                }
            }
        )


def test_secret_values_cannot_be_submitted_as_secret_references() -> None:
    with pytest.raises(ValidationError) as error:
        RuntimeConfiguration.model_validate(
            {
                "search": {
                    "provider": "brave",
                    "secretEnvVar": "BSA_test_secret_value",
                }
            }
        )

    assert "BSA_test_secret_value" not in str(error.value.errors(include_input=False))


def test_browser_runtime_profile_never_enables_audio_retention() -> None:
    with pytest.raises(ValidationError):
        RuntimeConfiguration.model_validate({"audioRetention": True})
