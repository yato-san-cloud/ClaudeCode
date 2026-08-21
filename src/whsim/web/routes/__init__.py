"""Concern-grouped APIRouter modules for the whsim web API.

Each module exposes a ``router`` (``fastapi.APIRouter``) with byte-identical
path prefixes; ``whsim.web.app`` assembles them via ``include_router``. Shared
helpers live in ``._common`` (imported by the routers, never the other way
around, so there is no import cycle through ``app``)."""
