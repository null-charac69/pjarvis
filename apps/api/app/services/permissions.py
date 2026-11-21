"""Fail-closed tool permissions and argument-bound confirmation tickets."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal, cast
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.session import finish_database_operation
from app.models.audit import PermissionGrantRecord
from app.schemas.events import (
    PermissionRequested,
    PermissionRequestedPayload,
    PermissionResolved,
    PermissionResolvedPayload,
)
from app.services.event_hub import EventHub
from app.tools.sdk import PermissionScope, RiskLevel, ToolManifest
from app.tools.security import mask_secrets


class PermissionDecision(StrEnum):
    ALLOWED = "allowed"
    CONFIRMATION_REQUIRED = "confirmation_required"
    DENIED = "denied"


class ConfirmationChoice(StrEnum):
    APPROVED_ONCE = "approved_once"
    APPROVED_SESSION = "approved_session"
    DENIED = "denied"


@dataclass(frozen=True)
class PermissionResult:
    decision: PermissionDecision
    confirmation_id: UUID | None = None


@dataclass
class ConfirmationTicket:
    confirmation_id: UUID
    tool_id: str
    risk_level: RiskLevel
    argument_hash: str
    masked_arguments: dict[str, object]
    scopes: tuple[PermissionScope, ...]
    resources: tuple[str, ...]
    masked_resources: tuple[str, ...]
    expires_at: datetime
    decision: ConfirmationChoice | None = None


def _argument_hash(arguments: dict[str, object]) -> str:
    payload = json.dumps(arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class PermissionService:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        event_hub: EventHub,
        *,
        default_mode: str = "ask_every_time",
        confirmation_ttl_seconds: int = 300,
    ) -> None:
        self._session_factory = session_factory
        self._event_hub = event_hub
        self._default_mode = default_mode
        self._confirmation_ttl = timedelta(seconds=confirmation_ttl_seconds)
        self._tickets: dict[UUID, ConfirmationTicket] = {}
        self._session_grants: set[tuple[str, str, str]] = set()

    async def evaluate(
        self,
        manifest: ToolManifest,
        arguments: dict[str, object],
        resources: tuple[str, ...],
        request_id: UUID,
        confirmation_id: UUID | None = None,
    ) -> PermissionResult:
        if manifest.risk_level == RiskLevel.BLOCKED:
            return PermissionResult(PermissionDecision.DENIED)

        if confirmation_id is not None:
            ticket = self._tickets.get(confirmation_id)
            if ticket is None or ticket.expires_at <= datetime.now(UTC):
                self._tickets.pop(confirmation_id, None)
                return PermissionResult(PermissionDecision.DENIED)
            if (
                ticket.tool_id != manifest.tool_id
                or ticket.argument_hash != _argument_hash(arguments)
                or ticket.scopes != manifest.required_scopes
                or ticket.resources != resources
            ):
                return PermissionResult(PermissionDecision.DENIED)
            if ticket.decision == ConfirmationChoice.APPROVED_ONCE:
                self._tickets.pop(confirmation_id, None)
                return PermissionResult(PermissionDecision.ALLOWED, confirmation_id)
            if ticket.decision == ConfirmationChoice.APPROVED_SESSION:
                return PermissionResult(PermissionDecision.ALLOWED, confirmation_id)
            return PermissionResult(PermissionDecision.DENIED, confirmation_id)

        if self._session_grants_cover(manifest, resources):
            return PermissionResult(PermissionDecision.ALLOWED)

        if not manifest.requires_confirmation and await self._grants_cover(manifest, resources):
            return PermissionResult(PermissionDecision.ALLOWED)

        if not manifest.required_scopes and not manifest.requires_confirmation:
            return PermissionResult(PermissionDecision.ALLOWED)

        if self._default_mode == "deny":
            return PermissionResult(PermissionDecision.DENIED)

        ticket = ConfirmationTicket(
            confirmation_id=uuid4(),
            tool_id=manifest.tool_id,
            risk_level=manifest.risk_level,
            argument_hash=_argument_hash(arguments),
            masked_arguments=mask_secrets(arguments),
            scopes=manifest.required_scopes,
            resources=resources,
            masked_resources=tuple(mask_secrets(list(resources))),
            expires_at=datetime.now(UTC) + self._confirmation_ttl,
        )
        self._tickets[ticket.confirmation_id] = ticket
        event_risk = (
            "LOW" if manifest.risk_level == RiskLevel.READ_ONLY else manifest.risk_level.value
        )
        await self._event_hub.publish(
            PermissionRequested(
                type="permission.requested",
                correlation_id=request_id,
                payload=PermissionRequestedPayload(
                    confirmation_id=ticket.confirmation_id,
                    tool_id=manifest.tool_id,
                    risk_level=cast(
                        Literal["LOW", "MEDIUM", "HIGH", "BLOCKED"],
                        event_risk,
                    ),
                ),
            )
        )
        return PermissionResult(PermissionDecision.CONFIRMATION_REQUIRED, ticket.confirmation_id)

    def get_confirmation(self, confirmation_id: UUID) -> ConfirmationTicket | None:
        ticket = self._tickets.get(confirmation_id)
        if ticket is None or ticket.expires_at <= datetime.now(UTC):
            self._tickets.pop(confirmation_id, None)
            return None
        return ticket

    async def resolve(
        self,
        confirmation_id: UUID,
        choice: ConfirmationChoice,
        request_id: UUID,
        before_resolve: Callable[[ConfirmationTicket], Awaitable[None]] | None = None,
    ) -> ConfirmationTicket:
        ticket = self._tickets.get(confirmation_id)
        if ticket is None or ticket.expires_at <= datetime.now(UTC):
            self._tickets.pop(confirmation_id, None)
            raise ValueError("confirmation_not_found_or_expired")
        if ticket.decision is not None:
            raise ValueError("confirmation_already_resolved")

        if before_resolve is not None:
            await before_resolve(ticket)
        ticket.decision = choice
        if choice == ConfirmationChoice.APPROVED_SESSION:
            await self._save_session_grants(ticket)
        await self._event_hub.publish(
            PermissionResolved(
                type="permission.resolved",
                correlation_id=request_id,
                payload=PermissionResolvedPayload(
                    confirmation_id=confirmation_id,
                    decision=choice.value,
                ),
            )
        )
        return ticket

    async def add_grant(
        self, tool_id: str, scope: PermissionScope, resource_pattern: str = "*"
    ) -> PermissionGrantRecord:
        grant = PermissionGrantRecord(
            tool_id=tool_id,
            scope=scope.value,
            resource_pattern=resource_pattern,
            created_at=datetime.now(UTC),
        )
        async with self._session_factory() as session:
            session.add(grant)
            await finish_database_operation(session.commit())
            await session.refresh(grant)
        return grant

    async def revoke_grant(self, grant_id: UUID) -> bool:
        async with self._session_factory() as session:
            grant = await session.get(PermissionGrantRecord, grant_id)
            if grant is None or grant.revoked_at is not None:
                return False
            grant.revoked_at = datetime.now(UTC)
            await finish_database_operation(session.commit())
            return True

    async def list_grants(self) -> list[PermissionGrantRecord]:
        async with self._session_factory() as session:
            rows = await session.scalars(
                select(PermissionGrantRecord)
                .where(PermissionGrantRecord.revoked_at.is_(None))
                .order_by(PermissionGrantRecord.created_at.desc())
            )
            return list(rows.all())

    async def _grants_cover(self, manifest: ToolManifest, resources: tuple[str, ...]) -> bool:
        if not manifest.required_scopes:
            return True
        async with self._session_factory() as session:
            rows = await session.scalars(
                select(PermissionGrantRecord).where(
                    PermissionGrantRecord.tool_id == manifest.tool_id,
                    PermissionGrantRecord.revoked_at.is_(None),
                )
            )
            active = rows.all()
        for scope in manifest.required_scopes:
            resource_patterns = {
                grant.resource_pattern for grant in active if grant.scope == scope.value
            }
            if not resource_patterns:
                return False
            if not resources and "*" not in resource_patterns:
                return False
            if resources and any(
                not any(pattern in {"*", resource} for pattern in resource_patterns)
                for resource in resources
            ):
                return False
        return True

    def _session_grants_cover(self, manifest: ToolManifest, resources: tuple[str, ...]) -> bool:
        scopes = tuple(scope.value for scope in manifest.required_scopes) or ("",)
        resources_to_check = resources or ("*",)
        for scope in scopes:
            for resource in resources_to_check:
                if not any(
                    (manifest.tool_id, scope, candidate) in self._session_grants
                    for candidate in {"*", resource}
                ):
                    return False
        return True

    async def _save_session_grants(self, ticket: ConfirmationTicket) -> None:
        scopes = tuple(scope.value for scope in ticket.scopes) or ("",)
        resources = ticket.resources or ("*",)
        self._session_grants.update(
            (ticket.tool_id, scope, resource) for scope in scopes for resource in resources
        )
