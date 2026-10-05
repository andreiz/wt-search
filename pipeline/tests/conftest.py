import pytest


@pytest.fixture
def wts_home(tmp_path, monkeypatch):
    home = tmp_path / "wts-home"
    home.mkdir()
    monkeypatch.setenv("WTS_HOME", str(home))
    return home
