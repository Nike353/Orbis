"""Frozen application entry point; modules and runtime assets ship together."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.serve import main
main()
