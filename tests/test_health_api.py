from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError


def test_readiness_reports_database_and_api(client: TestClient) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["data"]["status"] == "healthy"
    assert [check["name"] for check in body["data"]["checks"]] == ["api", "database"]
    assert body["requestId"] == response.headers["x-correlation-id"]
    UUID(body["requestId"])


def test_liveness_does_not_depend_on_database(client: TestClient) -> None:
    async def unavailable() -> bool:
        raise SQLAlchemyError("private database detail")

    client.app.state.database.ping = unavailable
    response = client.get("/api/v1/health/live")

    assert response.status_code == 200
    assert response.json()["data"]["checks"] == [{"name": "api", "status": "healthy"}]


def test_readiness_error_is_sanitized(client: TestClient) -> None:
    async def unavailable() -> bool:
        raise SQLAlchemyError("private database detail")

    client.app.state.database.ping = unavailable
    response = client.get("/api/v1/health/ready")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "request_failed"
    assert "private database detail" not in response.text


def test_invalid_correlation_header_is_replaced(client: TestClient) -> None:
    response = client.get("/api/v1/health/live", headers={"X-Correlation-ID": "not-a-uuid"})

    assert response.status_code == 200
    assert response.headers["x-correlation-id"] != "not-a-uuid"
    UUID(response.headers["x-correlation-id"])


def test_unknown_route_uses_common_error_envelope(client: TestClient) -> None:
    response = client.get("/api/v1/unknown")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert response.json()["error"]["message"] == "The requested resource was not found."
