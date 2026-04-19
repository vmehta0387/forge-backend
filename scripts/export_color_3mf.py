#!/usr/bin/env python3
import argparse
import json
import math
import os
import traceback
import zipfile
from collections import OrderedDict
from dataclasses import dataclass
from typing import Dict, List, Tuple
from xml.etree import ElementTree as ET

import numpy as np
import trimesh
from trimesh.transformations import rotation_matrix


BASE_TILE_URL = os.path.join("terrain", "Base Tiles_v1.stl")
OBJECT_URLS = {
    "apartment": os.path.join("objects", "Apartment.stl"),
    "arena": os.path.join("objects", "Arena.stl"),
    "bank": os.path.join("objects", "bank.stl"),
    "university": os.path.join("objects", "University.stl"),
}

TILE_COLORS = {
    "grass": "#7FB56AFF",
    "water": "#5CA7D7FF",
    "desert": "#D9A865FF",
}

OBJECT_COLORS = {
    "apartment": "#F4F1E8FF",
    "arena": "#EDE6DEFF",
    "bank": "#EFE8DEFF",
    "university": "#F5EFE5FF",
}

BASE_TILE_TARGET_RADIUS = 16.0
OBJECT_SCALE_MIN = 0.5
OBJECT_SCALE_MAX = 1.0
DEFAULT_OBJECT_PLACE_SCALE = 0.78
MIN_PRINT_WIDTH_MM = 35.0
MAX_PRINT_WIDTH_MM = 180.0
OBJECT_EMBED_DEPTH = 0.04

CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
MAT_NS = "http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
XML_NS = "http://www.w3.org/XML/1998/namespace"


@dataclass
class PreparedBase:
    mesh: trimesh.Trimesh
    hex_radius: float
    top_y: float
    pointy: bool


@dataclass
class PreparedObject:
    mesh: trimesh.Trimesh
    max_scale: float


@dataclass
class ScenePart:
    mesh: trimesh.Trimesh
    color: str
    name: str


def parse_args():
    parser = argparse.ArgumentParser(description="Forge3D color 3MF export")
    parser.add_argument("--scene", required=True, help="Path to scene JSON")
    parser.add_argument("--output", required=True, help="Output 3MF path")
    parser.add_argument("--asset-root", required=True, help="Root assets folder")
    return parser.parse_args()


def load_scene(scene_path: str) -> dict:
    with open(scene_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        raise RuntimeError("Scene payload must be an object.")
    return payload


def load_mesh(path: str) -> trimesh.Trimesh:
    loaded = trimesh.load(path, force="mesh", process=False)
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise RuntimeError(f"No mesh geometry in {path}")
        loaded = trimesh.util.concatenate(meshes)
    if not isinstance(loaded, trimesh.Trimesh):
        raise RuntimeError(f"Unsupported mesh type loaded from {path}: {type(loaded)}")
    return loaded.copy()


def center_bottom(mesh: trimesh.Trimesh):
    bounds = mesh.bounds
    min_xyz, max_xyz = bounds
    center = (min_xyz + max_xyz) * 0.5
    translation = np.array([-center[0], -min_xyz[1], -center[2]], dtype=np.float64)
    mesh.apply_translation(translation)


def clamp(value: float, min_v: float, max_v: float) -> float:
    return max(min_v, min(max_v, value))


def axial_to_world(q: int, r: int, radius: float, pointy: bool) -> np.ndarray:
    if pointy:
        x = radius * math.sqrt(3) * (q + r / 2)
        z = radius * 1.5 * r
    else:
        x = radius * 1.5 * q
        z = radius * math.sqrt(3) * (r + q / 2)
    return np.array([x, 0.0, z], dtype=np.float64)


def prepare_base(asset_root: str) -> PreparedBase:
    base_path = os.path.join(asset_root, BASE_TILE_URL)
    if not os.path.exists(base_path):
        raise RuntimeError(f"Missing base STL: {base_path}")

    mesh = load_mesh(base_path)
    mesh.apply_transform(rotation_matrix(-math.pi / 2, [1, 0, 0]))
    center_bottom(mesh)

    extents = mesh.extents
    raw_radius = max(extents[0], extents[2]) / 2.0
    normalize_scale = BASE_TILE_TARGET_RADIUS / max(raw_radius, 1e-6)
    mesh.apply_scale(normalize_scale)

    extents = mesh.extents
    pointy = bool(extents[2] >= extents[0])
    hex_radius = extents[2] / 2.0 if pointy else extents[0] / 2.0
    top_y = float(mesh.bounds[1][1])

    return PreparedBase(mesh=mesh, hex_radius=hex_radius, top_y=top_y, pointy=pointy)


def prepare_object_templates(asset_root: str, hex_radius: float) -> Dict[str, PreparedObject]:
    templates: Dict[str, PreparedObject] = {}

    for asset, rel_path in OBJECT_URLS.items():
        stl_path = os.path.join(asset_root, rel_path)
        if not os.path.exists(stl_path):
            continue

        mesh = load_mesh(stl_path)
        mesh.apply_transform(rotation_matrix(-math.pi / 2, [1, 0, 0]))
        center_bottom(mesh)

        extents = mesh.extents
        footprint = max(extents[0], extents[2], 1e-6)
        height = max(extents[1], 1e-6)
        target_footprint = hex_radius * 1.08
        target_height = hex_radius * 1.25
        normalized_scale = min(target_footprint / footprint, target_height / height)
        mesh.apply_scale(normalized_scale)

        normalized_extents = mesh.extents
        normalized_footprint = max(normalized_extents[0], normalized_extents[2], 1e-6)
        max_allowed = hex_radius * 1.26
        dynamic_max_scale = max(
            OBJECT_SCALE_MIN, min(OBJECT_SCALE_MAX, max_allowed / normalized_footprint)
        )

        templates[asset] = PreparedObject(mesh=mesh, max_scale=dynamic_max_scale)

    return templates


def normalize_scene(scene: dict) -> Tuple[List[dict], List[dict]]:
    tiles_in = scene.get("tiles", [])
    objects_in = scene.get("objects", [])
    if not isinstance(tiles_in, list):
        tiles_in = []
    if not isinstance(objects_in, list):
        objects_in = []

    tiles: List[dict] = []
    for tile in tiles_in:
        try:
            q = int(tile.get("q", 0))
            r = int(tile.get("r", 0))
            biome = str(tile.get("biome", "grass")).lower()
        except Exception:
            continue
        tiles.append({"q": q, "r": r, "biome": biome})

    objects: List[dict] = []
    for obj in objects_in:
        try:
            asset = str(obj.get("asset", "")).lower()
            q = int(obj.get("q", 0))
            r = int(obj.get("r", 0))
            rotation_y = float(obj.get("rotationY", 0.0))
            scale = float(obj.get("scale", DEFAULT_OBJECT_PLACE_SCALE))
            local_offset_x = float(obj.get("localOffsetX", 0.0))
            local_offset_z = float(obj.get("localOffsetZ", 0.0))
        except Exception:
            continue
        objects.append(
            {
                "asset": asset,
                "q": q,
                "r": r,
                "rotationY": rotation_y,
                "scale": scale,
                "localOffsetX": local_offset_x,
                "localOffsetZ": local_offset_z,
            }
        )

    return tiles, objects


def build_parts(asset_root: str, scene: dict) -> List[ScenePart]:
    tiles, objects = normalize_scene(scene)
    if not tiles:
        raise RuntimeError("Scene has no tiles to export.")

    prepared_base = prepare_base(asset_root)
    templates = prepare_object_templates(asset_root, prepared_base.hex_radius)
    parts: List[ScenePart] = []

    for tile in tiles:
        mesh = prepared_base.mesh.copy()
        world = axial_to_world(tile["q"], tile["r"], prepared_base.hex_radius, prepared_base.pointy)
        mesh.apply_translation(world)
        color = TILE_COLORS.get(tile["biome"], TILE_COLORS["grass"])
        parts.append(ScenePart(mesh=mesh, color=color, name=f"tile_{tile['q']}_{tile['r']}"))

    for obj in objects:
        prepared = templates.get(obj["asset"])
        if prepared is None:
            continue

        mesh = prepared.mesh.copy()
        obj_scale = clamp(obj["scale"], OBJECT_SCALE_MIN, prepared.max_scale)
        mesh.apply_scale(obj_scale)
        mesh.apply_transform(rotation_matrix(obj["rotationY"], [0, 1, 0]))

        cell = axial_to_world(obj["q"], obj["r"], prepared_base.hex_radius, prepared_base.pointy)
        tx = cell[0] + obj["localOffsetX"]
        ty = prepared_base.top_y - OBJECT_EMBED_DEPTH
        tz = cell[2] + obj["localOffsetZ"]
        mesh.apply_translation(np.array([tx, ty, tz], dtype=np.float64))

        color = OBJECT_COLORS.get(obj["asset"], "#F2F2F2FF")
        parts.append(ScenePart(mesh=mesh, color=color, name=f"obj_{obj['asset']}"))

    if not parts:
        raise RuntimeError("No mesh data found for 3MF export.")
    return parts


def orient_and_scale_parts(parts: List[ScenePart]):
    for part in parts:
        part.mesh.apply_transform(rotation_matrix(math.pi / 2, [1, 0, 0]))

    all_vertices = np.concatenate([part.mesh.vertices for part in parts], axis=0)
    min_bounds = all_vertices.min(axis=0)
    max_bounds = all_vertices.max(axis=0)
    size = max_bounds - min_bounds
    max_xy = max(float(size[0]), float(size[1]), 1e-6)

    export_scale = 1.0
    if max_xy < MIN_PRINT_WIDTH_MM:
        export_scale = MIN_PRINT_WIDTH_MM / max_xy
    elif max_xy > MAX_PRINT_WIDTH_MM:
        export_scale = MAX_PRINT_WIDTH_MM / max_xy

    if abs(export_scale - 1.0) > 1e-6:
        for part in parts:
            part.mesh.apply_scale(export_scale)

    all_vertices = np.concatenate([part.mesh.vertices for part in parts], axis=0)
    min_bounds = all_vertices.min(axis=0)
    z_shift = -float(min_bounds[2])
    if abs(z_shift) > 1e-8:
        for part in parts:
            part.mesh.apply_translation(np.array([0.0, 0.0, z_shift], dtype=np.float64))


def fmt(v: float) -> str:
    return f"{float(v):.6f}"


def build_3mf_xml(parts: List[ScenePart]) -> bytes:
    ET.register_namespace("", CORE_NS)
    ET.register_namespace("m", MAT_NS)

    color_map: "OrderedDict[str, int]" = OrderedDict()
    for part in parts:
        if part.color not in color_map:
            color_map[part.color] = len(color_map)

    root = ET.Element(
        f"{{{CORE_NS}}}model",
        attrib={
            "unit": "millimeter",
            f"{{{XML_NS}}}lang": "en-US",
        },
    )
    resources = ET.SubElement(root, f"{{{CORE_NS}}}resources")

    basematerials = ET.SubElement(resources, f"{{{MAT_NS}}}basematerials", attrib={"id": "1"})
    for idx, color in enumerate(color_map.keys()):
        ET.SubElement(
            basematerials,
            f"{{{MAT_NS}}}base",
            attrib={
                "name": f"Color {idx + 1}",
                "displaycolor": color,
            },
        )

    object_ids: List[int] = []
    next_object_id = 2
    for part in parts:
        color_index = color_map.get(part.color, 0)
        obj = ET.SubElement(
            resources,
            f"{{{CORE_NS}}}object",
            attrib={
                "id": str(next_object_id),
                "type": "model",
                "pid": "1",
                "pindex": str(color_index),
                "name": part.name,
            },
        )
        mesh_el = ET.SubElement(obj, f"{{{CORE_NS}}}mesh")
        verts_el = ET.SubElement(mesh_el, f"{{{CORE_NS}}}vertices")
        tris_el = ET.SubElement(mesh_el, f"{{{CORE_NS}}}triangles")

        vertices = np.asarray(part.mesh.vertices, dtype=np.float64)
        faces = np.asarray(part.mesh.faces, dtype=np.int64)

        for vx, vy, vz in vertices:
            ET.SubElement(
                verts_el,
                f"{{{CORE_NS}}}vertex",
                attrib={"x": fmt(vx), "y": fmt(vy), "z": fmt(vz)},
            )

        for f in faces:
            ET.SubElement(
                tris_el,
                f"{{{CORE_NS}}}triangle",
                attrib={"v1": str(int(f[0])), "v2": str(int(f[1])), "v3": str(int(f[2]))},
            )

        object_ids.append(next_object_id)
        next_object_id += 1

    build = ET.SubElement(root, f"{{{CORE_NS}}}build")
    for object_id in object_ids:
        ET.SubElement(build, f"{{{CORE_NS}}}item", attrib={"objectid": str(object_id)})

    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def write_3mf(parts: List[ScenePart], output_path: str):
    model_xml = build_3mf_xml(parts)
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
        "</Types>"
    )
    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        "</Relationships>"
    )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels_xml)
        zf.writestr("3D/3dmodel.model", model_xml)


def main():
    args = parse_args()
    scene = load_scene(args.scene)
    parts = build_parts(args.asset_root, scene)
    orient_and_scale_parts(parts)
    write_3mf(parts, args.output)
    print(f"[color-3mf] wrote {args.output} with {len(parts)} parts")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[color-3mf] failed: {exc}")
        traceback.print_exc()
        raise

