from collections.abc import Iterator

import pytest
from app.core.settings import Settings
from app.main import create_app
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr


@pytest.fixture
def api_app(tmp_path, monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setenv("JARVIS_ENV", "test")
    settings = Settings(
        _env_file=None,
        database_url=SecretStr(f"sqlite+aiosqlite:///{(tmp_path / 'test.sqlite3').as_posix()}"),
    )
    return create_app(settings)


@pytest.fixture
def client(api_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(api_app) as test_client:
        yield test_client
