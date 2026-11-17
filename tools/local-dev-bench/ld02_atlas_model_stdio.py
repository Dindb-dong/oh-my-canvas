"""Expose the registered LD02 Atlas operations over MCP stdio."""

import sys

from ld03_model_stdio import main
from llama_canary import LD02_ATLAS_TOOLS


if __name__ == "__main__":
    main(*sys.argv[1:], server_name="bench_ld02_atlas", tools=LD02_ATLAS_TOOLS)
