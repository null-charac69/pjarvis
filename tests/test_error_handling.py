from app.core.errors import install_exception_handlers
from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_validation_error_does_not_echo_rejected_input() -> None:
    test_app = FastAPI()
    install_exception_handlers(test_app)

    @test_app.get("/resource")
    def read_resource(value: int) -> dict[str, int]:
        return {"value": value}

    with TestClient(test_app) as client:
        response = client.get("/resource", params={"value": "sensitive-user-input"})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
    assert "sensitive-user-input" not in response.text
