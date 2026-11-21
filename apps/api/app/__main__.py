"""Run the local API with Uvicorn when invoked as a module."""

import uvicorn

from app.core.settings import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.server.host,
        port=settings.server.port,
        ws_max_size=2048,
    )


if __name__ == "__main__":
    main()
