import os
import shutil

import pytest

from wts.storage import StorageUnavailable, check_audio_dir


def test_missing_mount_raises(tmp_path):
    with pytest.raises(StorageUnavailable):
        check_audio_dir(tmp_path / "Volumes" / "media" / "wts" / "audio", 2.0)


def test_creates_folder_when_parent_exists(tmp_path):
    check_audio_dir(tmp_path / "audio", 0.0)
    assert (tmp_path / "audio").is_dir()
    assert not (tmp_path / "audio" / ".wts-write-test").exists()


def test_low_free_space_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(shutil, "disk_usage", lambda p: shutil._ntuple_diskusage(10, 9, 1 * 2**30))
    with pytest.raises(StorageUnavailable, match="free"):
        check_audio_dir(tmp_path, 2.0)


@pytest.mark.skipif(os.geteuid() == 0, reason="root can write to read-only folders")
def test_read_only_folder_raises(tmp_path):
    ro = tmp_path / "ro"
    ro.mkdir()
    ro.chmod(0o500)
    try:
        with pytest.raises(StorageUnavailable, match="writable"):
            check_audio_dir(ro, 0.0)
    finally:
        ro.chmod(0o700)
