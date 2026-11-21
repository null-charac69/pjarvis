"""FastAPI application factory and process lifecycle."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from app.api.configuration import router as configuration_router
from app.api.router import api_router
from app.api.websocket import router as websocket_router
from app.core.browser_security import BrowserSecurityMiddleware, BrowserSessionStore
from app.core.context import request_id_context
from app.core.errors import install_exception_handlers
from app.core.logging import configure_logging
from app.core.settings import Settings, get_settings
from app.db.session import Database
from app.orchestration.engine import AssistantOrchestrator
from app.providers.factory import create_llm_provider
from app.providers.system_monitoring import SystemMonitor
from app.providers.tool_integrations import create_tool_integrations
from app.providers.voice import create_stt_provider, create_wake_detector
from app.services.audit import AuditService
from app.services.conversations import ConversationService
from app.services.event_hub import EventHub
from app.services.permissions import PermissionService
from app.services.productivity import ProductivityService
from app.services.runtime_configuration import RuntimeConfigurationStore
from app.tools.builtin import create_builtin_tools
from app.tools.registry import ToolRegistry
from app.tools.workspaces import WorkspaceAccess

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    database = Database(resolved_settings)
    browser_sessions = BrowserSessionStore(resolved_settings.deployment.session_ttl_seconds)
    event_hub = EventHub(resolved_settings.server.websocket_send_timeout_seconds)
    tool_registry = ToolRegistry(create_builtin_tools(resolved_settings))
    tool_integrations = create_tool_integrations(resolved_settings)
    system_monitor = SystemMonitor()
    workspace_access = WorkspaceAccess(
        resolved_settings.permissions.approved_workspace_roots,
        allowed_file_types=resolved_settings.workspace.allowed_file_types or None,
        max_file_bytes=resolved_settings.workspace.max_file_bytes,
    )
    llm_provider = create_llm_provider(resolved_settings)
    audit_service = AuditService(database.session_factory)
    conversation_service = ConversationService(database.session_factory)
    productivity_service = ProductivityService(database.session_factory)
    permission_service = PermissionService(
        database.session_factory,
        event_hub,
        default_mode=resolved_settings.permissions.default_mode,
    )
    orchestrator = AssistantOrchestrator(
        settings=resolved_settings,
        provider=llm_provider,
        registry=tool_registry,
        permissions=permission_service,
        audit=audit_service,
        conversations=conversation_service,
        event_hub=event_hub,
        workspaces=workspace_access,
        tool_integrations={
            **tool_integrations,
            "system_monitor": system_monitor,
            "productivity": productivity_service,
            "event_hub": event_hub,
        },
    )
    stt_provider = create_stt_provider(resolved_settings)
    wake_detector = create_wake_detector(resolved_settings)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        configure_logging(resolved_settings.log_level)
        try:
            await database.start()
            interrupted_count = await conversation_service.mark_interrupted_tasks()
            logger.info("API startup complete interrupted_tasks=%d", interrupted_count)
            yield
        finally:
            logger.info("API shutdown started")
            try:
                await orchestrator.close()
            finally:
                await database.stop()
                logger.info("API shutdown complete")

    app = FastAPI(
        title="Jarvis Local API",
        version="0.1.0",
        docs_url=None if resolved_settings.is_production else "/docs",
        redoc_url=None if resolved_settings.is_production else "/redoc",
        lifespan=lifespan,
    )
    app.state.settings = resolved_settings
    app.state.llm_provider = llm_provider
    app.state.runtime_configuration_store = (
        RuntimeConfigurationStore(resolved_settings.data_directory)
        if resolved_settings.data_dir is not None
        else None
    )
    app.state.configuration_restart_required = False
    app.state.browser_sessions = browser_sessions
    app.state.database = database
    app.state.event_hub = event_hub
    app.state.tool_registry = tool_registry
    app.state.workspaces = workspace_access
    app.state.tool_integrations = {
        **tool_integrations,
        "system_monitor": system_monitor,
        "productivity": productivity_service,
        "event_hub": event_hub,
    }
    app.state.audit_service = audit_service
    app.state.permission_service = permission_service
    app.state.conversation_service = conversation_service
    app.state.orchestrator = orchestrator
    app.state.stt_provider = stt_provider
    app.state.wake_detector = wake_detector

    @app.middleware("http")
    async def attach_request_id(request: Request, call_next: RequestResponseEndpoint) -> Response:
        supplied_id = request.headers.get("x-correlation-id", "")
        try:
            request_id = str(UUID(supplied_id)) if supplied_id else str(uuid4())
        except ValueError:
            request_id = str(uuid4())

        request.state.request_id = request_id
        token = request_id_context.set(request_id)
        try:
            response = await call_next(request)
            response.headers["X-Correlation-ID"] = request_id
            return response
        finally:
            request_id_context.reset(token)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.server.allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Correlation-ID", "X-Jarvis-Session-Token"],
        expose_headers=["X-Correlation-ID"],
    )
    app.add_middleware(
        BrowserSecurityMiddleware,
        enabled=resolved_settings.deployment.mode in {"browser", "pwa"},
        allowed_origins=resolved_settings.server.allowed_origins,
        sessions=browser_sessions,
        requests_per_minute=resolved_settings.deployment.requests_per_minute,
        max_request_bytes=resolved_settings.deployment.max_request_bytes,
        backend_host=resolved_settings.server.host,
        backend_port=resolved_settings.server.port,
    )
    install_exception_handlers(app)
    app.include_router(api_router, prefix="/api/v1")
    app.include_router(configuration_router, prefix="/api/v1")
    app.include_router(websocket_router)
    return app


app = create_app()
