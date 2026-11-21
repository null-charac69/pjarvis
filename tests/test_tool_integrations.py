from __future__ import annotations

import socket
from typing import Any

import pytest
from app.core.settings import ProviderSettings, Settings
from app.providers import tool_integrations
from app.providers.tool_integrations import (
    BraveSearchProvider,
    OpenMeteoWeatherProvider,
    SafePageFetcher,
    ToolProviderError,
    _fetch_page_sync,
    _public_addresses,
)
from pydantic import AnyHttpUrl, SecretStr


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class FakeAsyncClient:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, dict[str, Any]]] = []

    async def __aenter__(self) -> FakeAsyncClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def get(self, url: str, **kwargs: Any) -> FakeResponse:
        self.requests.append((url, kwargs))
        return self.responses.pop(0)


def _settings() -> Settings:
    return Settings(
        _env_file=None,
        providers=ProviderSettings(
            web_search="brave",
            web_search_api_key=SecretStr("test-search-secret"),
        ),
    )


@pytest.mark.asyncio
async def test_brave_search_maps_citations_and_keeps_key_out_of_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client = FakeAsyncClient(
        [
            FakeResponse(
                {
                    "web": {
                        "results": [
                            {
                                "title": "Result",
                                "url": "https://docs.example/",
                                "description": "Summary",
                            }
                        ]
                    }
                }
            )
        ]
    )

    def factory(**_: Any) -> FakeAsyncClient:
        return fake_client

    monkeypatch.setattr(tool_integrations.httpx, "AsyncClient", factory)

    result = await BraveSearchProvider(_settings()).search("query")

    assert result["provider"] == "brave"
    assert result["results"][0]["citation"] == "https://docs.example/"
    assert "test-search-secret" not in str(result)
    assert fake_client.requests[0][1]["headers"]["X-Subscription-Token"] == "test-search-secret"


@pytest.mark.asyncio
async def test_open_meteo_resolves_location_and_returns_source_citation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client = FakeAsyncClient(
        [
            FakeResponse(
                {
                    "results": [
                        {
                            "name": "Pune",
                            "admin1": "Maharashtra",
                            "country": "India",
                            "latitude": 18.5,
                            "longitude": 73.8,
                        }
                    ]
                }
            ),
            FakeResponse(
                {
                    "timezone": "Asia/Kolkata",
                    "current": {
                        "time": "2025-01-01T12:00",
                        "temperature_2m": 25.0,
                        "apparent_temperature": 26.0,
                        "relative_humidity_2m": 50,
                        "weather_code": 1,
                        "wind_speed_10m": 8.0,
                    },
                    "current_units": {"temperature_2m": "°C", "wind_speed_10m": "km/h"},
                }
            ),
        ]
    )
    monkeypatch.setattr(tool_integrations.httpx, "AsyncClient", lambda **_: fake_client)

    result = await OpenMeteoWeatherProvider().current("Pune")

    assert result["location"] == "Pune, Maharashtra, India"
    assert result["temperature"] == 25.0
    assert result["citation"] == "https://open-meteo.com/"
    assert len(fake_client.requests) == 2


@pytest.mark.asyncio
async def test_open_meteo_uses_saved_defaults_when_tool_location_is_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client = FakeAsyncClient(
        [
            FakeResponse(
                {
                    "results": [
                        {
                            "name": "Pune",
                            "latitude": 18.5,
                            "longitude": 73.8,
                        }
                    ]
                }
            ),
            FakeResponse(
                {
                    "timezone": "Asia/Kolkata",
                    "current": {"time": "2025-01-01T12:00"},
                    "current_units": {},
                }
            ),
        ]
    )
    settings = Settings(
        _env_file=None,
        providers={
            "weather_default_location": "Pune",
            "weather_temperature_unit": "fahrenheit",
            "weather_timezone": "Asia/Kolkata",
        },
    )
    monkeypatch.setattr(tool_integrations.httpx, "AsyncClient", lambda **_: fake_client)

    await OpenMeteoWeatherProvider(settings).current("")

    assert fake_client.requests[0][1]["params"]["name"] == "Pune"
    assert fake_client.requests[1][1]["params"]["temperature_unit"] == "fahrenheit"
    assert fake_client.requests[1][1]["params"]["timezone"] == "Asia/Kolkata"


def test_public_dns_rejects_private_and_mixed_answer_sets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        tool_integrations.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))],
    )
    assert _public_addresses("public.example", 443) == ["8.8.8.8"]

    monkeypatch.setattr(
        tool_integrations.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
        ],
    )
    with pytest.raises(ToolProviderError, match="unsafe_destination"):
        _public_addresses("mixed.example", 443)


def test_safe_fetch_strips_active_html_and_returns_traceable_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        status = 200

        def getheader(self, name: str, default: str | None = None) -> str | None:
            return {"Content-Type": "text/html; charset=utf-8", "Content-Length": "100"}.get(
                name, default
            )

        def read(self, _size: int) -> bytes:
            return b"<title>Guide</title><p>Useful text</p><script>do not return</script>"

    class Connection:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        def request(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def getresponse(self) -> Response:
            return Response()

        def close(self) -> None:
            return None

    monkeypatch.setattr(tool_integrations, "_public_addresses", lambda *_: ["8.8.8.8"])
    monkeypatch.setattr(tool_integrations, "_PinnedHTTPSConnection", Connection)

    output = _fetch_page_sync("https://docs.example/guide", [AnyHttpUrl("https://docs.example")])

    assert output["title"] == "Guide"
    assert "Useful text" in output["text"]
    assert "do not return" not in output["text"]
    assert output["citation"] == "https://docs.example/guide"


def test_safe_fetch_rechecks_redirects_and_enforces_page_size(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class RedirectResponse:
        status = 302

        def getheader(self, name: str, default: str | None = None) -> str | None:
            return "http://127.0.0.1/private" if name == "Location" else None

    class RedirectConnection:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        def request(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def getresponse(self) -> RedirectResponse:
            return RedirectResponse()

        def close(self) -> None:
            return None

    monkeypatch.setattr(tool_integrations, "_public_addresses", lambda *_: ["8.8.8.8"])
    monkeypatch.setattr(tool_integrations, "_PinnedHTTPSConnection", RedirectConnection)
    with pytest.raises(ToolProviderError, match="website_not_approved"):
        _fetch_page_sync("https://docs.example/guide", [AnyHttpUrl("https://docs.example")])

    class OversizedResponse:
        status = 200

        def getheader(self, name: str, default: str | None = None) -> str | None:
            if name == "Content-Length":
                return str(tool_integrations._MAX_PAGE_BYTES + 1)
            if name == "Content-Type":
                return "text/html"
            return default

        def read(self, _size: int) -> bytes:
            raise AssertionError("oversized body must not be read")

    class OversizedConnection(RedirectConnection):
        def getresponse(self) -> OversizedResponse:
            return OversizedResponse()

    monkeypatch.setattr(tool_integrations, "_PinnedHTTPSConnection", OversizedConnection)
    with pytest.raises(ToolProviderError, match="page_too_large"):
        _fetch_page_sync("https://docs.example/guide", [AnyHttpUrl("https://docs.example")])


@pytest.mark.asyncio
async def test_fetcher_without_approved_origins_is_explicitly_unconfigured() -> None:
    fetcher = SafePageFetcher([])

    with pytest.raises(ToolProviderError, match="provider_unconfigured"):
        await fetcher.fetch("https://docs.example/")
