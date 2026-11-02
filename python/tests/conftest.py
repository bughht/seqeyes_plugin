# SeqEyes Python — Test Configuration

import json

import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "slow: marks tests as slow (deselect with '-m \"not slow\"')"
    )


def _injected(html: str) -> dict:
    """The values the renderer injects ahead of the page's own script."""
    start = html.index('<script>window._SEQEYES_HOST="python";')
    script = html[start:html.index("</script>", start)]
    values = {}
    for name in ("_SEQEYES_PRELOAD", "_SEQEYES_OPTIONS"):
        prefix = f"window.{name}="
        values[name], _ = json.JSONDecoder().raw_decode(script, script.index(prefix) + len(prefix))
    return values


@pytest.fixture
def injected():
    return _injected
