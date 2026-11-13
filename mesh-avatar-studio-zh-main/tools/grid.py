# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10.4"]
# ///
"""Draw a readable grid labelled in original source-image coordinates."""

import argparse
import sys
from pathlib import Path

from agent_common import grid_image, project_image, region_arg, save_image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("--region", type=region_arg)
    parser.add_argument("--step", type=int, default=50)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        result, _ = grid_image(project_image(args.project), args.region, args.step)
        save_image(result, args.out)
        print(f"Grid written: {args.out}; all labels are source pixels.")
    except (OSError, ValueError) as error:
        print(f"grid: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
