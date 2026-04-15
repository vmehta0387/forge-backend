import argparse
import os
import sys

import bpy


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser(description="Fast STL cleanup pipeline")
    parser.add_argument("--input", required=True, help="Input STL path")
    parser.add_argument("--output", required=True, help="Output STL path")
    parser.add_argument(
        "--decimate-ratio",
        type=float,
        default=0.85,
        help="Decimate ratio in (0,1]. 1 disables decimation.",
    )
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)


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


def minimal_clean(obj, decimate_ratio):
    bpy.context.view_layer.objects.active = obj

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")

    if 0.0 < decimate_ratio < 1.0:
        decimate = obj.modifiers.new(name="Decimate", type="DECIMATE")
        decimate.ratio = decimate_ratio
        bpy.ops.object.modifier_apply(modifier=decimate.name)

    bpy.ops.object.shade_smooth()


def main():
    args = parse_args()
    input_path = args.input
    output_path = args.output
    decimate_ratio = max(0.05, min(1.0, args.decimate_ratio))

    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input STL missing: {input_path}")

    clear_scene()
    obj = import_stl(input_path)
    minimal_clean(obj, decimate_ratio)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    export_stl(output_path, obj)
    print(f"[fast-clean] STL written: {output_path}")


if __name__ == "__main__":
    main()

