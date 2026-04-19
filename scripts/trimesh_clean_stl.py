#!/usr/bin/env python3
import argparse
import os
import sys
import traceback

import numpy as np
import trimesh


def parse_args():
    parser = argparse.ArgumentParser(description="Lightweight STL cleanup with trimesh (+ optional pymeshfix).")
    parser.add_argument("--input", required=True, help="Input STL path")
    parser.add_argument("--output", required=True, help="Output STL path")
    return parser.parse_args()


def load_mesh(path: str) -> trimesh.Trimesh:
    loaded = trimesh.load(path, force="mesh", process=False)
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise RuntimeError(f"No mesh geometry found in STL: {path}")
        loaded = trimesh.util.concatenate(meshes)

    if not isinstance(loaded, trimesh.Trimesh):
        raise RuntimeError(f"Loaded geometry is not a mesh: {type(loaded)}")
    return loaded


def basic_cleanup(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    mesh.remove_degenerate_faces()
    mesh.remove_duplicate_faces()
    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices(digits_vertex=6)

    trimesh.repair.fix_normals(mesh, multibody=True)
    trimesh.repair.fix_inversion(mesh, multibody=True)
    trimesh.repair.fill_holes(mesh)
    return mesh


def try_meshfix(mesh: trimesh.Trimesh):
    try:
        import pymeshfix  # type: ignore
    except Exception:
        return mesh, False

    fixer = pymeshfix.MeshFix(mesh.vertices, mesh.faces)
    fixer.repair(verbose=False, joincomp=True, remove_smallest_components=False)
    fixed = trimesh.Trimesh(vertices=fixer.v, faces=fixer.f, process=False)
    fixed.remove_unreferenced_vertices()
    trimesh.repair.fix_normals(fixed, multibody=True)
    return fixed, True


def fallback_watertight(mesh: trimesh.Trimesh):
    # Last-resort: voxel wrap then marching-cubes to get closed surface.
    # This intentionally prioritizes watertightness over preserving tiny details.
    max_extent = float(np.max(mesh.extents)) if mesh.extents is not None else 1.0
    pitch = max(max_extent / 180.0, 0.08)
    vox = mesh.voxelized(pitch=pitch).fill()
    wrapped = vox.marching_cubes
    wrapped.remove_unreferenced_vertices()
    trimesh.repair.fix_normals(wrapped, multibody=True)
    return wrapped


def main():
    args = parse_args()
    in_path = os.path.abspath(args.input)
    out_path = os.path.abspath(args.output)

    if not os.path.exists(in_path):
        raise FileNotFoundError(f"Input STL missing: {in_path}")

    mesh = load_mesh(in_path)
    mesh = basic_cleanup(mesh)

    meshfix_used = False
    if not mesh.is_watertight:
        mesh, meshfix_used = try_meshfix(mesh)
        mesh = basic_cleanup(mesh)

    if not mesh.is_watertight:
        mesh = fallback_watertight(mesh)
        mesh = basic_cleanup(mesh)

    if not mesh.is_watertight:
        print("[trimesh-clean] warning: mesh is still not fully watertight after cleanup", file=sys.stderr)

    blob = trimesh.exchange.stl.export_stl(mesh)
    with open(out_path, "wb") as f:
        f.write(blob)

    print(
        f"[trimesh-clean] wrote {out_path} | watertight={mesh.is_watertight} | "
        f"vertices={len(mesh.vertices)} faces={len(mesh.faces)} meshfix={meshfix_used}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[trimesh-clean] failed: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)

