"""Real local host resource metrics."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psutil


class SystemMonitor:
    def sample(self) -> dict[str, Any]:
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage(str(Path.home()))
        return {
            "sampled_at": datetime.now(UTC),
            "cpu_percent": psutil.cpu_percent(interval=0.1),
            "memory_total_bytes": memory.total,
            "memory_available_bytes": memory.available,
            "memory_percent": memory.percent,
            "disk_total_bytes": disk.total,
            "disk_free_bytes": disk.free,
            "disk_percent": disk.percent,
        }
