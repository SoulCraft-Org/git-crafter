#!/usr/bin/env python3
"""ci_pool_github.py: the GitHub REST reads and writes of the CI pool meter (tools/ci_pool.py imports it).

Every failed read raises Unreadable, never a count of zero. A list that ends short of its total_count is not whole.
Standard library only.
"""

from __future__ import annotations

import datetime as dt


class Unreadable(Exception):
    """A reading the meter cannot trust: exit 3, and never a count of zero."""


def parse_time(value) -> dt.datetime:
    """A GitHub time; ValueError when it is not one or has no zone."""
    t = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if t.tzinfo is None:
        raise ValueError(f"time without a zone: {value!r}")
    return t


def iso(t: dt.datetime) -> str:
    """The time in UTC, as GitHub writes it."""
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
