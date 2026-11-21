"""Root router for implemented version-one API slices."""

from fastapi import APIRouter

from app.api.assistant import router as assistant_router
from app.api.browser_session import router as browser_session_router
from app.api.health import router as health_router
from app.api.tools import router as tools_router
from app.api.voice import router as voice_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(browser_session_router)
api_router.include_router(assistant_router)
api_router.include_router(tools_router)
api_router.include_router(voice_router)
