"""
Generate a sample car assembly (body, cabin, glass, wheels, seats, engine, ...)
as real B-rep CAD data and export it to STEP, IGES and STL.

Requires: pip install cadquery-ocp
Usage:    python3 scripts/generate_car.py [output_dir]

Units are millimetres. X = length (front is +X), Y = width, Z = up.
"""
import os
import sys

from OCP.gp import gp_Pnt, gp_Ax2, gp_Dir, gp_Vec, gp_Trsf
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeTorus
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
from OCP.BRepBuilderAPI import (BRepBuilderAPI_MakePolygon, BRepBuilderAPI_Transform)
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_EDGE, TopAbs_SOLID
from OCP.TopoDS import TopoDS
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.TDataStd import TDataStd_Name
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.IGESCAFControl import IGESCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.StlAPI import StlAPI_Writer
from OCP.TopoDS import TopoDS_Compound
from OCP.BRep import BRep_Builder
from OCP.Interface import Interface_Static


# ---------- primitive helpers ----------

def box(x, y, z, dx, dy, dz):
    return BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape()


def cyl(x, y, z, r, h, axis=(0, 1, 0)):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(*axis)), r, h).Shape()


def torus(x, y, z, r1, r2, axis=(0, 1, 0)):
    return BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(*axis)), r1, r2).Shape()


def cut(a, *bs):
    for b in bs:
        a = BRepAlgoAPI_Cut(a, b).Shape()
    return a


def fuse(a, *bs):
    for b in bs:
        a = BRepAlgoAPI_Fuse(a, b).Shape()
    return unwrap(a)


def solids(shape):
    out = []
    exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def unwrap(shape):
    """Boolean ops return a compound; hand back the single solid when there is only one."""
    s = solids(shape)
    return s[0] if len(s) == 1 else shape


def fillet_all(shape, r):
    mk = BRepFilletAPI_MakeFillet(shape)
    exp = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp.More():
        mk.Add(r, TopoDS.Edge(exp.Current()))
        exp.Next()
    mk.Build()
    return mk.Shape() if mk.IsDone() else shape


def rect_wire(x0, x1, y0, y1, z):
    p = BRepBuilderAPI_MakePolygon()
    for (x, y) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        p.Add(gp_Pnt(x, y, z))
    p.Close()
    return p.Wire()


def loft(sections):
    ts = BRepOffsetAPI_ThruSections(True, True)
    for s in sections:
        ts.AddWire(rect_wire(*s))
    ts.Build()
    return ts.Shape()


def moved(shape, dx=0, dy=0, dz=0):
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(dx, dy, dz))
    return BRepBuilderAPI_Transform(shape, t, True).Shape()


def mirror_y(shape):
    from OCP.gp import gp_Ax2 as Ax2
    t = gp_Trsf()
    t.SetMirror(Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 1, 0)))
    return BRepBuilderAPI_Transform(shape, t, True).Shape()


# ---------- car dimensions ----------
L, W = 4500.0, 1800.0
HW = W / 2
GROUND = 150.0          # ground clearance
BODY_H = 650.0          # lower body height
WHEEL_R, WHEEL_W = 330.0, 225.0
FRONT_AXLE, REAR_AXLE = 1400.0, -1300.0
WALL = 40.0


def build_parts():
    parts = []  # (name, shape, rgb, group)

    # --- lower body: filleted block, hollowed, with wheel arches ---
    outer = fillet_all(box(-L / 2, -HW, GROUND, L, W, BODY_H), 120)
    inner = box(-L / 2 + WALL + 500, -HW + WALL, GROUND + WALL, L - 2 * WALL - 900, W - 2 * WALL, BODY_H + 10)
    arches = []
    for ax in (FRONT_AXLE, REAR_AXLE):
        arches.append(cyl(ax, -HW - 10, WHEEL_R + 10, WHEEL_R + 40, W + 20))
    body = cut(outer, inner, *arches)
    parts.append(("Body_Lower", body, (0.75, 0.05, 0.08), "Body"))

    # --- hood and trunk lid close the top of the lower body (hide them to see the engine) ---
    top = GROUND + BODY_H
    hood = fillet_all(box(880, -HW + 30, top - 20, 1280, W - 60, 25), 10)
    parts.append(("Body_Hood", hood, (0.75, 0.05, 0.08), "Body"))
    trunk = fillet_all(box(-2150, -HW + 30, top - 20, 660, W - 60, 25), 10)
    parts.append(("Body_TrunkLid", trunk, (0.75, 0.05, 0.08), "Body"))

    # --- cabin (greenhouse): lofted, hollowed, window openings cut ---
    z0, z1 = GROUND + BODY_H, GROUND + BODY_H + 560
    cab_out = loft([(-1500, 900, -HW + 40, HW - 40, z0), (-1150, 350, -HW + 140, HW - 140, z1)])
    cab_in = loft([(-1500 + WALL, 900 - WALL, -HW + 40 + WALL, HW - 40 - WALL, z0 - 1),
                   (-1150 + WALL, 350 - WALL, -HW + 140 + WALL, HW - 140 - WALL, z1 - WALL)])
    # side windows (front door, rear door), windscreen, rear screen
    win_z = z0 + 80
    windows = [
        box(-100, -HW - 50, win_z, 650, W + 100, 380),     # front side windows
        box(-1150, -HW - 50, win_z, 950, W + 100, 360),    # rear side windows
        box(400, -HW + 250, win_z, 700, W - 500, 400),     # windscreen
        box(-1700, -HW + 250, win_z, 500, W - 500, 380),   # rear screen
    ]
    cabin = cut(cab_out, cab_in, *windows)
    parts.append(("Body_Cabin", cabin, (0.75, 0.05, 0.08), "Body"))

    # glass panels (thin transparent parts that fill the openings)
    glass = [
        ("Glass_Windscreen", loft([(640, 900, -HW + 80, HW - 80, z0 + 20), (330, 360, -HW + 170, HW - 170, z1 - 30)])),
        ("Glass_RearScreen", loft([(-1480, -1450, -HW + 80, HW - 80, z0 + 20), (-1145, -1120, -HW + 170, HW - 170, z1 - 30)])),
        ("Glass_Side_Left", box(-1100, HW - 110, win_z + 10, 1600, 8, 330)),
        ("Glass_Side_Right", box(-1100, -HW + 102, win_z + 10, 1600, 8, 330)),
    ]
    for name, g in glass:
        parts.append((name, g, (0.55, 0.75, 0.9), "Glass"))

    # --- floor pan + dashboard + seats + steering wheel (the interior) ---
    parts.append(("Interior_Floor", box(-1350, -HW + WALL, GROUND + WALL, 2250, W - 2 * WALL, 30), (0.2, 0.2, 0.22), "Interior"))
    dash = fillet_all(box(500, -HW + 80, z0 - 150, 300, W - 160, 280), 40)
    parts.append(("Interior_Dashboard", dash, (0.12, 0.12, 0.13), "Interior"))

    def seat(x, y):
        cushion = fillet_all(box(x, y, GROUND + 220, 520, 500, 120), 30)
        back = fillet_all(box(x - 100, y, GROUND + 220, 110, 500, 650), 30)
        head = fillet_all(box(x - 90, y + 125, GROUND + 830, 90, 250, 170), 30)
        return fuse(cushion, back, head)

    for name, x, y in (("Seat_Driver", -150, 100), ("Seat_Passenger", -150, -600),
                       ("Seat_Rear_Left", -1050, 100), ("Seat_Rear_Right", -1050, -600)):
        parts.append((f"Interior_{name}", seat(x, y), (0.3, 0.22, 0.15), "Interior"))

    sw = fuse(torus(420, 350, z0 + 60, 190, 18, axis=(1, 0, 0.35)),
              cyl(420, 350, z0 + 60, 40, 180, axis=(1, 0, 0.35)),
              box(410, 350 - 195, z0 + 50, 20, 390, 20))  # spoke joins hub and rim into one solid
    parts.append(("Interior_SteeringWheel", sw, (0.05, 0.05, 0.05), "Interior"))

    # --- engine bay ---
    block = fillet_all(box(1450, -350, GROUND + 180, 550, 700, 380), 30)
    for i in range(4):
        block = cut(block, cyl(1530 + i * 130, -200, GROUND + 400, 45, 400, axis=(0, 0, 1)))
    parts.append(("Engine_Block", block, (0.45, 0.47, 0.5), "Powertrain"))
    head = fillet_all(box(1470, -330, GROUND + 560, 510, 660, 90), 20)
    parts.append(("Engine_CylinderHead", head, (0.2, 0.2, 0.2), "Powertrain"))
    parts.append(("Engine_Radiator", box(2050, -600, GROUND + 150, 60, 1200, 450), (0.3, 0.3, 0.32), "Powertrain"))
    parts.append(("Gearbox", fillet_all(box(1050, -250, GROUND + 150, 400, 500, 300), 40), (0.4, 0.4, 0.42), "Powertrain"))

    # --- axles ---
    for name, ax in (("Axle_Front", FRONT_AXLE), ("Axle_Rear", REAR_AXLE)):
        parts.append((name, cyl(ax, -HW + 110, WHEEL_R, 35, W - 220), (0.25, 0.25, 0.25), "Chassis"))

    # --- wheels: tyre (torus-ish) + rim (disc with spoke holes) ---
    for label, ax in (("Front", FRONT_AXLE), ("Rear", REAR_AXLE)):
        for side, y0 in (("Left", HW - WHEEL_W - 20), ("Right", -HW + 20)):
            tyre = cut(cyl(ax, y0, WHEEL_R, WHEEL_R, WHEEL_W), cyl(ax, y0 - 1, WHEEL_R, WHEEL_R - 90, WHEEL_W + 2))
            tyre = fillet_all(tyre, 25)
            rim = cyl(ax, y0 + 40, WHEEL_R, WHEEL_R - 90, WHEEL_W - 80)
            holes = []
            for k in range(5):
                import math
                a = 2 * math.pi * k / 5
                holes.append(cyl(ax + 150 * math.cos(a), y0 + 30, WHEEL_R + 150 * math.sin(a), 55, WHEEL_W))
            rim = cut(rim, *holes)
            parts.append((f"Wheel_{label}_{side}_Tyre", tyre, (0.06, 0.06, 0.06), "Wheels"))
            parts.append((f"Wheel_{label}_{side}_Rim", rim, (0.8, 0.8, 0.82), "Wheels"))
            disc = cyl(ax, y0 + 150 if side == "Left" else y0 - 20 + 90, WHEEL_R, 170, 25)
            parts.append((f"Wheel_{label}_{side}_BrakeDisc", disc, (0.5, 0.35, 0.3), "Wheels"))

    # --- lights & bumpers ---
    for side, y in (("Left", HW - 380), ("Right", -HW + 80)):
        parts.append((f"Light_Head_{side}", fillet_all(box(L / 2 - 60, y, GROUND + 450, 70, 300, 110), 20), (1.0, 0.97, 0.8), "Lights"))
        parts.append((f"Light_Tail_{side}", fillet_all(box(-L / 2 - 10, y, GROUND + 470, 70, 300, 100), 20), (0.9, 0.1, 0.05), "Lights"))
    parts.append(("Bumper_Front", fillet_all(box(L / 2 - 40, -HW + 30, GROUND + 60, 120, W - 60, 180), 50), (0.15, 0.15, 0.15), "Body"))
    parts.append(("Bumper_Rear", fillet_all(box(-L / 2 - 80, -HW + 30, GROUND + 60, 120, W - 60, 180), 50), (0.15, 0.15, 0.15), "Body"))

    # --- mirrors ---
    for side, y, sgn in (("Left", HW, 1), ("Right", -HW, -1)):
        m = fillet_all(box(420, y - 10 if sgn > 0 else y - 170, z0 + 40, 140, 180, 110), 30)
        parts.append((f"Mirror_{side}", m, (0.75, 0.05, 0.08), "Body"))

    return parts


def write_xcaf(parts, step_path, iges_path):
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

    builder = BRep_Builder()
    comp = TopoDS_Compound()
    builder.MakeCompound(comp)
    assy_label = shape_tool.NewShape()
    TDataStd_Name.Set_s(assy_label, TCollection_ExtendedString("Sample_Car"))

    for name, shape, rgb, group in parts:
        part_label = shape_tool.AddShape(shape, False)
        TDataStd_Name.Set_s(part_label, TCollection_ExtendedString(name))
        color = Quantity_Color(rgb[0], rgb[1], rgb[2], Quantity_TOC_RGB)
        color_tool.SetColor(part_label, color, XCAFDoc_ColorType.XCAFDoc_ColorGen)
        color_tool.SetColor(part_label, color, XCAFDoc_ColorType.XCAFDoc_ColorSurf)
        from OCP.TopLoc import TopLoc_Location
        comp_label = shape_tool.AddComponent(assy_label, part_label, TopLoc_Location())
        TDataStd_Name.Set_s(comp_label, TCollection_ExtendedString(name))
    shape_tool.UpdateAssemblies()

    Interface_Static.SetCVal_s("write.step.schema", "AP214")
    sw = STEPCAFControl_Writer()
    sw.SetColorMode(True)
    sw.SetNameMode(True)
    sw.Transfer(doc, STEPControl_AsIs)
    assert sw.Write(step_path) == IFSelect_RetDone, "STEP write failed"

    iw = IGESCAFControl_Writer()
    iw.SetColorMode(True)
    iw.SetNameMode(True)
    iw.Transfer(doc)
    assert iw.Write(iges_path), "IGES write failed"


def write_stl(shape, path, deflection=2.0):
    BRepMesh_IncrementalMesh(shape, deflection, False, 0.3, True)
    w = StlAPI_Writer()
    w.ASCIIMode = False
    w.Write(shape, path)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "samples")
    os.makedirs(out, exist_ok=True)
    parts = build_parts()
    print(f"built {len(parts)} parts")

    write_xcaf(parts, os.path.join(out, "sample_car.step"), os.path.join(out, "sample_car.iges"))

    # Individual car parts as separate files (useful for testing drag & drop of several files)
    part_dir = os.path.join(out, "car_parts")
    os.makedirs(part_dir, exist_ok=True)
    wanted = {"Engine_Block": "engine_block", "Wheel_Front_Left_Rim": "wheel_rim",
              "Interior_Seat_Driver": "seat", "Interior_SteeringWheel": "steering_wheel"}
    for name, shape, rgb, group in parts:
        if name in wanted:
            write_xcaf([(name, shape, rgb, group)],
                       os.path.join(part_dir, wanted[name] + ".step"),
                       os.path.join(part_dir, wanted[name] + ".iges"))

    # Whole car as one binary STL (no colours/names - STL can't store them)
    builder = BRep_Builder()
    comp = TopoDS_Compound()
    builder.MakeCompound(comp)
    for _, shape, _, _ in parts:
        builder.Add(comp, shape)
    write_stl(comp, os.path.join(out, "sample_car.stl"))
    write_stl([s for n, s, _, _ in parts if n == "Engine_Block"][0], os.path.join(part_dir, "engine_block.stl"), 0.5)
    print("done ->", os.path.abspath(out))


if __name__ == "__main__":
    main()
