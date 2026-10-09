"""Compatibility reads for settings written by earlier application versions."""
import os


def env_setting(name, default=None):
    return os.environ.get("ORBIS_" + name, os.environ.get("LITBENCH_" + name, default))
