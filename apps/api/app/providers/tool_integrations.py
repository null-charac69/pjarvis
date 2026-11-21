"""Configured web providers and bounded, allowlisted page retrieval."""

from __future__ import annotations

import asyncio
import http.client
import ipaddress
import socket
import ssl
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
from pydantic import AnyHttpUrl

from app.core.settings import Settings
from app.tools.security import validate_approved_website

_MAX_PAGE_BYTES = 262_144
_MAX_PAGE_CHARS = 12_000
_MAX_REDIRECTS = 3
_REDIRECT_CODES = {301, 302, 303, 307, 308}


class ToolProviderError(Exception):
    """A provider failure safe to map to a structured tool error."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class BraveSearchProvider:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def configured(self) -> bool:
        return (
            self._settings.providers.web_search == "brave"
            and self._settings.providers.web_search_api_key is not None
        )

    async def search(self, query: str) -> dict[str, Any]:
        if not self.configured:
            raise ToolProviderError("provider_unconfigured")
        api_key = self._settings.providers.web_search_api_key
        if api_key is None:
            raise ToolProviderError("provider_unconfigured")
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                response = await client.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    params={
                        "q": query,
                        "count": self._settings.providers.web_search_result_limit,
                    },
                    headers={"X-Subscription-Token": api_key.get_secret_value()},
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exception:
            raise ToolProviderError("provider_failed") from exception

        results = payload.get("web", {}).get("results", [])
        return {
            "query": query,
            "provider": "brave",
            "results": [
                {
                    "title": str(item.get("title", ""))[:300],
                    "url": str(item.get("url", ""))[:2048],
                    "snippet": str(item.get("description", ""))[:1200],
                    "citation": str(item.get("url", ""))[:2048],
                }
                for item in results[: self._settings.providers.web_search_result_limit]
                if isinstance(item, dict) and item.get("url")
            ],
        }


class OpenMeteoWeatherProvider:
    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings

    async def current(self, location: str) -> dict[str, Any]:
        provider_settings = self._settings.providers if self._settings else None
        selected_location = location.strip() or (
            provider_settings.weather_default_location.strip() if provider_settings else ""
        )
        if not selected_location:
            raise ToolProviderError("location_required")
        timezone = provider_settings.weather_timezone if provider_settings else "auto"
        temperature_unit = (
            provider_settings.weather_temperature_unit if provider_settings else "celsius"
        )
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                geocoding = await client.get(
                    "https://geocoding-api.open-meteo.com/v1/search",
                    params={
                        "name": selected_location,
                        "count": 1,
                        "language": "en",
                        "format": "json",
                    },
                )
                geocoding.raise_for_status()
                places = geocoding.json().get("results", [])
                if not places:
                    raise ToolProviderError("location_not_found")
                place = places[0]
                forecast = await client.get(
                    "https://api.open-meteo.com/v1/forecast",
                    params={
                        "latitude": place["latitude"],
                        "longitude": place["longitude"],
                        "current": (
                            "temperature_2m,relative_humidity_2m,apparent_temperature,"
                            "weather_code,wind_speed_10m"
                        ),
                        "timezone": timezone,
                        "temperature_unit": temperature_unit,
                    },
                )
                forecast.raise_for_status()
                payload = forecast.json()
        except ToolProviderError:
            raise
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exception:
            raise ToolProviderError("provider_failed") from exception

        current = payload.get("current")
        if not isinstance(current, dict):
            raise ToolProviderError("provider_failed")
        location_parts = [place.get("name"), place.get("admin1"), place.get("country")]
        return {
            "location": ", ".join(dict.fromkeys(part for part in location_parts if part)),
            "timezone": payload.get("timezone", "UTC"),
            "observed_at": current.get("time"),
            "temperature": current.get("temperature_2m"),
            "temperature_unit": payload.get("current_units", {}).get("temperature_2m", ""),
            "apparent_temperature": current.get("apparent_temperature"),
            "humidity_percent": current.get("relative_humidity_2m"),
            "weather_code": current.get("weather_code"),
            "wind_speed": current.get("wind_speed_10m"),
            "wind_speed_unit": payload.get("current_units", {}).get("wind_speed_10m", ""),
            "provider": "open_meteo",
            "citation": "https://open-meteo.com/",
        }


class _PageTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self._in_title = False
        self._suppressed_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "title":
            self._in_title = True
        if tag.lower() in {"script", "style", "noscript", "svg"}:
            self._suppressed_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False
        if tag.lower() in {"script", "style", "noscript", "svg"}:
            self._suppressed_depth = max(0, self._suppressed_depth - 1)

    def handle_data(self, data: str) -> None:
        value = " ".join(data.split())
        if not value:
            return
        if self._in_title:
            self.title_parts.append(value)
        if self._suppressed_depth == 0:
            self.text_parts.append(value)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, address: str, timeout: float) -> None:
        self._ssl_context = ssl.create_default_context()
        super().__init__(host, port=port, timeout=timeout, context=self._ssl_context)
        self._address = address

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._ssl_context.wrap_socket(sock, server_hostname=self.host)


def _public_addresses(hostname: str, port: int) -> list[str]:
    try:
        records = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        addresses: list[str] = []
        for record in records:
            address = record[4][0]
            if isinstance(address, str) and address not in addresses:
                addresses.append(address)
        if not addresses or any(
            not ipaddress.ip_address(address).is_global for address in addresses
        ):
            raise ToolProviderError("unsafe_destination")
        return addresses
    except ToolProviderError:
        raise
    except (OSError, ValueError) as exception:
        raise ToolProviderError("host_resolution_failed") from exception


def _fetch_page_sync(url: str, approved_origins: list[AnyHttpUrl]) -> dict[str, Any]:
    current_url = url
    for redirect_count in range(_MAX_REDIRECTS + 1):
        try:
            current_url = validate_approved_website(current_url, approved_origins)
        except ValueError as exception:
            raise ToolProviderError("website_not_approved") from exception
        parts = urlsplit(current_url)
        hostname = parts.hostname
        if not hostname:
            raise ToolProviderError("invalid_url")
        port = parts.port or 443
        addresses = _public_addresses(hostname, port)
        connection: _PinnedHTTPSConnection | None = None
        try:
            connection = _PinnedHTTPSConnection(hostname, port, addresses[0], timeout=6.0)
            request_target = parts.path or "/"
            if parts.query:
                request_target = f"{request_target}?{parts.query}"
            connection.request(
                "GET",
                request_target,
                headers={
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Encoding": "identity",
                    "Connection": "close",
                    "User-Agent": "JarvisAssistant/1.0",
                },
            )
            response = connection.getresponse()
            if response.status in _REDIRECT_CODES:
                location = response.getheader("Location")
                if not location or redirect_count == _MAX_REDIRECTS:
                    raise ToolProviderError("redirect_limit_exceeded")
                current_url = urljoin(current_url, location)
                continue
            if response.status < 200 or response.status >= 300:
                raise ToolProviderError("provider_failed")
            content_type = response.getheader("Content-Type", "").split(";", 1)[0].lower()
            if content_type not in {"text/html", "application/xhtml+xml"}:
                raise ToolProviderError("unsupported_content_type")
            content_length = response.getheader("Content-Length")
            if content_length and int(content_length) > _MAX_PAGE_BYTES:
                raise ToolProviderError("page_too_large")
            body = response.read(_MAX_PAGE_BYTES + 1)
            if len(body) > _MAX_PAGE_BYTES:
                raise ToolProviderError("page_too_large")
            parser = _PageTextParser()
            parser.feed(body.decode("utf-8", errors="replace"))
            return {
                "url": current_url,
                "title": " ".join(parser.title_parts)[:300],
                "text": " ".join(parser.text_parts)[:_MAX_PAGE_CHARS],
                "content_type": content_type,
                "citation": current_url,
                "fetched_at": datetime.now(UTC).isoformat(),
            }
        except ToolProviderError:
            raise
        except (OSError, http.client.HTTPException, ValueError) as exception:
            raise ToolProviderError("provider_failed") from exception
        finally:
            if connection is not None:
                connection.close()
    raise ToolProviderError("redirect_limit_exceeded")


class SafePageFetcher:
    def __init__(self, approved_origins: list[AnyHttpUrl]) -> None:
        self._approved_origins = approved_origins

    @property
    def configured(self) -> bool:
        return bool(self._approved_origins)

    async def fetch(self, url: str) -> dict[str, Any]:
        if not self.configured:
            raise ToolProviderError("provider_unconfigured")
        return await asyncio.to_thread(_fetch_page_sync, url, self._approved_origins)


def create_tool_integrations(settings: Settings) -> dict[str, Any]:
    return {
        "web_search": BraveSearchProvider(settings),
        "weather": OpenMeteoWeatherProvider(settings),
        "web_fetch": SafePageFetcher(settings.permissions.approved_website_origins),
    }
