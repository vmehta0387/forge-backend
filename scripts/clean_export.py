import argparse
import json
import math
import os
import sys
from mathutils import Vector

import bpy
import bmesh


HEX_SIZE = 1.05
HEX_GAP = 0.04
TARGET_TILE_DIAMETER = (HEX_SIZE - HEX_GAP) * 2.0
MIN_PRINT_WIDTH_MM = 90.0
MAX_PRINT_WIDTH_MM = 150.0
CSG_OBJECT_LIMIT = 80
FAST_FALLBACK_OBJECT_THRESHOLD = 40

BASE_STL_REL = os.path.join("terrain", "Base Tiles_v1.stl")
OBJECT_STL_REL = {
    "tree": os.path.join("objects", "Single Assets_v1.stl"),
    "rock": os.path.join("objects", "Single Assets_v2.stl"),
    "wall": os.path.join("objects", "Single Assets_v3.stl"),
    "asset4": os.path.join("objects", "Single Assets_v4.stl"),
}

OBJECT_SCALE_PROFILE = {
    "tree": {"footprintRatio": 0.62, "heightRatio": 1.05},
    "rock": {"footprintRatio": 0.58, "heightRatio": 0.78},
    "wall": {"footprintRatio": 0.85, "heightRatio": 0.64},
    "asset4": {"footprintRatio": 0.65, "heightRatio": 0.92},
}


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser(description="Forge3D clean STL export pipeline")
    parser.add_argument("--scene", required=True, help="Path to scene JSON")
    parser.add_argument("--output", required=True, help="Path to output STL")
    parser.add_argument("--asset-root", required=True, help="Asset root directory")
    return parser.parse_args(argv)


def import_stl(filepath):
    bpy.ops.object.select_all(action="DESELECT")
    if hasattr(bpy.ops.wm, "stl_import"):
        bpy.ops.wm.stl_import(filepath=filepath)
    elif hasattr(bpy.ops.import_mesh, "stl"):
        bpy.ops.import_mesh.stl(filepath=filepath)
    else:
        raise RuntimeError("No STL import operator available in this Blender build.")

    imported = [obj for obj in bpy.context.selected_objects if obj.type == "MESH"]
    if not imported:
        raise RuntimeError(f"No mesh imported from STL: {filepath}")

    if len(imported) == 1:
        obj = imported[0]
    else:
        bpy.context.view_layer.objects.active = imported[0]
        bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active

    return obj


def export_stl(filepath, obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    if hasattr(bpy.ops.wm, "stl_export"):
        bpy.ops.wm.stl_export(filepath=filepath, export_selected_objects=True, ascii_format=False)
    elif hasattr(bpy.ops.export_mesh, "stl"):
        bpy.ops.export_mesh.stl(filepath=filepath, use_selection=True, ascii=False)
    else:
        raise RuntimeError("No STL export operator available in this Blender build.")


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def apply_object_transforms(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def get_bounds(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    min_v = Vector(
        (
            min(c.x for c in corners),
            min(c.y for c in corners),
            min(c.z for c in corners),
        )
    )
    max_v = Vector(
        (
            max(c.x for c in corners),
            max(c.y for c in corners),
            max(c.z for c in corners),
        )
    )
    size = max_v - min_v
    return min_v, max_v, size


def center_mesh_to_bottom(obj):
    mesh = obj.data
    verts = mesh.vertices
    if not verts:
        return

    min_x = min(v.co.x for v in verts)
    max_x = max(v.co.x for v in verts)
    min_y = min(v.co.y for v in verts)
    max_y = max(v.co.y for v in verts)
    min_z = min(v.co.z for v in verts)

    cx = (min_x + max_x) * 0.5
    cy = (min_y + max_y) * 0.5

    for vert in verts:
        vert.co.x -= cx
        vert.co.y -= cy
        vert.co.z -= min_z

    mesh.update()
    obj.location = Vector((0.0, 0.0, 0.0))
    apply_object_transforms(obj)


def prepare_base_template(asset_root):
    path = os.path.join(asset_root, BASE_STL_REL)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Base tile STL missing: {path}")

    obj = import_stl(path)
    obj.name = "__template_base__"
    apply_object_transforms(obj)

    _, _, size = get_bounds(obj)
    footprint = max(size.x, size.y, 1e-6)
    scale = TARGET_TILE_DIAMETER / footprint
    obj.scale = Vector((scale, scale, scale))
    apply_object_transforms(obj)
    center_mesh_to_bottom(obj)
    return obj


def prepare_object_template(asset_root, object_type):
    rel = OBJECT_STL_REL.get(object_type)
    if not rel:
        raise RuntimeError(f"Unknown object type: {object_type}")
    path = os.path.join(asset_root, rel)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Object STL missing for {object_type}: {path}")

    obj = import_stl(path)
    obj.name = f"__template_object_{object_type}__"
    apply_object_transforms(obj)

    _, _, size = get_bounds(obj)
    profile = OBJECT_SCALE_PROFILE[object_type]
    footprint = max(size.x, size.y, 1e-6)
    height = max(size.z, 1e-6)

    target_footprint = TARGET_TILE_DIAMETER * profile["footprintRatio"]
    target_height = TARGET_TILE_DIAMETER * profile["heightRatio"]
    scale = min(target_footprint / footprint, target_height / height)
    obj.scale = Vector((scale, scale, scale))
    apply_object_transforms(obj)
    center_mesh_to_bottom(obj)
    return obj


def hex_to_world(q, r):
    w = math.sqrt(3.0) * HEX_SIZE
    h = 2.0 * HEX_SIZE
    x = w * q + (w * 0.5 if (r % 2 == 1) else 0.0)
    z = h * 0.75 * r
    return x, z


def grid_center_world(grid_cols, grid_rows):
    center_q = math.floor(grid_cols / 2)
    center_r = math.floor(grid_rows / 2)
    return hex_to_world(center_q, center_r)


def duplicate_linked(template_obj, name, single_user_mesh=False):
    inst = template_obj.copy()
    inst.data = template_obj.data.copy() if single_user_mesh else template_obj.data
    inst.name = name
    bpy.context.scene.collection.objects.link(inst)
    return inst


def build_scene_objects(scene_data, base_template, object_templates):
    enabled_cells = [cell for cell in scene_data["hexGrid"] if bool(cell.get("enabled", False))]
    if not enabled_cells:
        raise RuntimeError("Scene has no enabled terrain tiles.")

    center_x, center_z = grid_center_world(scene_data["gridCols"], scene_data["gridRows"])

    base_instances = []
    for idx, cell in enumerate(enabled_cells):
        x, z = hex_to_world(int(cell["q"]), int(cell["r"]))
        obj = duplicate_linked(base_template, f"base_{idx}")
        obj.location = Vector((x - center_x, z - center_z, 0.0))
        base_instances.append(obj)

    object_instances = []
    for idx, obj_data in enumerate(scene_data["objects"]):
        template = object_templates.get(obj_data.get("type"))
        if template is None:
            continue

        px = float(obj_data["position"][0])
        py = float(obj_data["position"][1])
        pz = float(obj_data["position"][2])

        inst = duplicate_linked(template, f"obj_{idx}", single_user_mesh=True)
        inst.location = Vector((px, pz, py))
        inst.rotation_euler = (0.0, 0.0, float(obj_data.get("rotationY", 0.0)))
        object_scale = float(obj_data.get("objectScale", 1.0))
        inst.scale = Vector((object_scale, object_scale, object_scale))
        apply_object_transforms(inst)
        object_instances.append(inst)

    return base_instances, object_instances


def join_objects(objects, name):
    if not objects:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    return joined


def mesh_cleanup(obj, merge_distance=0.0002):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=merge_distance)
    bpy.ops.mesh.delete_loose()
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.mesh.quads_convert_to_tris(quad_method="BEAUTY", ngon_method="BEAUTY")
    bpy.ops.object.mode_set(mode="OBJECT")


def boolean_union(base_obj, object_objs):
    if not object_objs:
        return base_obj
    if len(object_objs) > CSG_OBJECT_LIMIT:
        raise RuntimeError("Too many objects for robust boolean union.")

    for idx, obj in enumerate(object_objs):
        mod = base_obj.modifiers.new(name=f"union_{idx}", type="BOOLEAN")
        mod.operation = "UNION"
        mod.solver = "EXACT"
        mod.object = obj
        bpy.ops.object.select_all(action="DESELECT")
        base_obj.select_set(True)
        bpy.context.view_layer.objects.active = base_obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.data.objects.remove(obj, do_unlink=True)

    return base_obj


def fallback_voxel_remesh(obj):
    _, _, size = get_bounds(obj)
    max_dim = max(size.x, size.y, size.z, 1e-6)
    voxel_size = max(max_dim / 700.0, 0.02)

    remesh = obj.modifiers.new(name="fallback_voxel_remesh", type="REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = voxel_size
    remesh.use_smooth_shade = False

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    mesh_cleanup(obj, merge_distance=voxel_size * 0.5)


def normalize_for_print(obj):
    min_v, max_v, size = get_bounds(obj)
    max_xy = max(size.x, size.y, 1e-6)

    scale = 1.0
    if max_xy < MIN_PRINT_WIDTH_MM:
        scale = MIN_PRINT_WIDTH_MM / max_xy
    elif max_xy > MAX_PRINT_WIDTH_MM:
        scale = MAX_PRINT_WIDTH_MM / max_xy

    obj.scale = Vector((scale, scale, scale))
    apply_object_transforms(obj)

    min_v, max_v, _ = get_bounds(obj)
    center_xy = Vector(((min_v.x + max_v.x) * 0.5, (min_v.y + max_v.y) * 0.5, 0.0))
    obj.location.x -= center_xy.x
    obj.location.y -= center_xy.y
    obj.location.z -= min_v.z
    apply_object_transforms(obj)


def load_scene_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    args = parse_args()
    scene_data = load_scene_json(args.scene)
    asset_root = args.asset_root
    output_path = args.output

    if not os.path.isdir(asset_root):
        raise RuntimeError(f"Asset root directory missing: {asset_root}")

    clear_scene()
    base_template = prepare_base_template(asset_root)

    object_templates = {}
    required_object_types = sorted(
        {
            obj.get("type")
            for obj in scene_data.get("objects", [])
            if obj.get("type") in OBJECT_STL_REL
        }
    )
    for object_type in required_object_types:
        object_templates[object_type] = prepare_object_template(asset_root, object_type)

    base_instances, object_instances = build_scene_objects(scene_data, base_template, object_templates)

    # Remove template objects early to reduce memory pressure.
    bpy.data.objects.remove(base_template, do_unlink=True)
    for template in list(object_templates.values()):
        bpy.data.objects.remove(template, do_unlink=True)

    base_joined = join_objects(base_instances, "terrain_base")
    if base_joined is None:
        raise RuntimeError("Failed to build terrain base mesh.")

    final_obj = base_joined
    used_fallback = False
    try:
        if object_instances and len(object_instances) > FAST_FALLBACK_OBJECT_THRESHOLD:
            # For large object counts, full exact boolean is expensive on constrained instances.
            all_objs = [base_joined] + object_instances
            final_obj = join_objects(all_objs, "terrain_joined_fast_fallback")
            used_fallback = True
        elif object_instances:
            final_obj = boolean_union(base_joined, object_instances)
    except Exception as error:
        print(f"[clean-export] Boolean union failed, fallback remesh will be used: {error}")
        all_objs = [base_joined] + [obj for obj in object_instances if obj.name in bpy.data.objects]
        final_obj = join_objects(all_objs, "terrain_joined_fallback")
        used_fallback = True

    mesh_cleanup(final_obj)
    if used_fallback:
        fallback_voxel_remesh(final_obj)

    normalize_for_print(final_obj)
    mesh_cleanup(final_obj, merge_distance=0.0005)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    export_stl(output_path, final_obj)
    print(f"[clean-export] STL written: {output_path}")


if __name__ == "__main__":
    main()
