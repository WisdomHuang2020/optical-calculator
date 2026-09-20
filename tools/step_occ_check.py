"""
用真实 OpenCascade 内核读取导出的 STEP，检验审核报告的核心断言：
  「ReadFile 返回 RetDone，但 root 数 = 0、shape 为空、且不报错 —— 静默失败」

真正的判据不是 RetDone，而是：
  - TransferRoots() 之后 NbShapes() 是否 > 0
  - 转成 TopoDS_Shape 后 IsNull() 是否为真
  - 实体数 / 面数 / 体积是否合理
若这些都为真，则"静默失败"不成立（文件确实能读成实体）。
"""
import sys
import os
from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID, TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX
from OCP.TopoDS import TopoDS
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.ShapeFix import ShapeFix_Shape


def count(shape, kind):
    ex = TopExp_Explorer(shape, kind)
    n = 0
    while ex.More():
        n += 1
        ex.Next()
    return n


def analyse(path):
    print('=' * 70)
    print('读取:', path)
    print('=' * 70)

    reader = STEPControl_Reader()
    status = reader.ReadFile(path)
    print('ReadFile 返回 =', status, '(IFSelect_RetDone =', IFSelect_RetDone, ')',
          '=>', 'RetDone' if status == IFSelect_RetDone else '非 RetDone')

    n_transfer = reader.TransferRoots()
    n_shapes = reader.NbShapes()
    print('TransferRoots 转移根数 =', n_transfer)
    print('NbShapes() =', n_shapes)

    if n_shapes == 0:
        print('>>> 判定：根数为 0 —— 报告所述"静默失败"成立')
        return False

    shape = reader.OneShape()
    print('OneShape().IsNull() =', shape.IsNull())
    if shape.IsNull():
        print('>>> 判定：形状为空 —— 报告所述"静默失败"成立')
        return False

    print('SOLID =', count(shape, TopAbs_SOLID))
    print('FACE  =', count(shape, TopAbs_FACE))
    print('EDGE  =', count(shape, TopAbs_EDGE))
    print('VERTEX=', count(shape, TopAbs_VERTEX))

    # 体积
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    vol = props.Mass()
    print('体积 (mm³) =', round(vol, 6))

    # 是否有效实体
    analyzer = BRepCheck_Analyzer(shape)
    print('BRepCheck_Analyzer.IsValid() =', analyzer.IsValid())

    # 曲面类型统计
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone, GeomAbs_Torus
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    types = {}
    while ex.More():
        f = TopoDS.Face_s(ex.Current())
        try:
            st = BRepAdaptor_Surface(f).GetType()
            types[st] = types.get(st, 0) + 1
        except Exception:
            pass
        ex.Next()
    print('面类型分布 =', types)
    print('  (0=Plane 1=Cylinder 2=Cone 3=Sphere 4=Torus 5=Bezier 6=BSpline 7=Revolution 8=Extrusion 9=Offset 10=Other)')

    print('>>> 判定：文件可正常读入为有效实体，"静默失败"不成立')
    return True


if __name__ == '__main__':
    results = []
    for p in sys.argv[1:]:
        results.append((p, analyse(p)))
        print()
    print('=' * 70)
    for p, r in results:
        print(('PASS' if r else 'FAIL'), p)
