#!/usr/bin/env python3
import argparse
import os
import traceback

import trimesh

from export_color_3mf import build_parts, load_scene, orient_and_scale_parts


def parse_args():
    parser = argparse.ArgumentParser(description="Forge3D scene JSON -> STL export")
    parser.add_argument("--scene", required=True, help="Path to scene JSON")
    parser.add_argument("--output", required=True, help="Output STL path")
    parser.add_argument("--asset-root", required=True, help="Root assets folder")
    return parser.parse_args()


def main():
    args = parse_args()
    scene = load_scene(args.scene)
    parts = build_parts(args.asset_root, scene)
    orient_and_scale_parts(parts)

    meshes = [part.mesh for part in parts]
    merged = meshes[0].copy() if len(meshes) == 1 else trimesh.util.concatenate(meshes)
    merged.remove_unreferenced_vertices()

    stl_blob = trimesh.exchange.stl.export_stl(merged)
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "wb") as out_file:
        out_file.write(stl_blob)

    print(f"[scene-stl] wrote {args.output} with {len(parts)} parts")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[scene-stl] failed: {exc}")
        traceback.print_exc()
        raise
