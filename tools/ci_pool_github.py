#!/usr/bin/env python3
"""ci_pool_github.py: the GitHub REST reads and writes of the CI pool meter (tools/ci_pool.py imports it).

Every failed read raises Unreadable, never a count of zero. A list that ends short of its total_count is not whole.
Standard library only.
"""

from __future__ import annotations

import datetime as dt
import json
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"


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


class Api:
    """The GitHub REST reads and writes the meter makes. The self-test passes fakes with the same methods."""

    def __init__(self, token: str):
        if not token:
            raise Unreadable("no GH_TOKEN: the meter needs the CI pool App's installation token")
        self.token, self.calls = token, 0

    def request(self, method: str, path: str, params: dict | None = None, body: dict | None = None):
        """One call; its JSON. A failed read is Unreadable; a write to a missing path is FileNotFoundError."""
        url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "git-crafter-ci-pool"})
        self.calls += 1
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            if method != "GET" and err.code == 404:
                raise FileNotFoundError(path) from None
            raise Unreadable(f"{method} {path}: HTTP {err.code}") from None
        except Exception as err:  # noqa: BLE001 - any failed read is unknown, never zero
            raise Unreadable(f"{method} {path}: {type(err).__name__}") from None

    def get(self, path: str, params: dict | None = None):
        """One GET; its JSON."""
        return self.request("GET", path, params)


def items_of(doc, key: str, path: str) -> list:
    """The list under key (or doc itself when key is empty); Unreadable when it is not a list."""
    items = doc.get(key) if isinstance(doc, dict) and key else doc
    if not isinstance(items, list):
        raise Unreadable(f"GET {path}: no {key or 'item'} list")
    return items
