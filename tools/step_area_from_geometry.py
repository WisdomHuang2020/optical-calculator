"""
从 STEP 文件本身重建截面多边形的精确面积，与 OCC 报告的实体体积对照。
方法：按 EDGE_LOOP 顺序走底环，把每个边离散成密集折线
     —— 直线取端点；有理二次 B 样条圆弧取圆周上的高密度采样
     （由 RATIONAL_B_SPLINE_CURVE 的三个控制点 + 权重**反解圆心与半径**）
再算面积 × 挤出长度。两者一致即说明「文件里的几何」与「内核读到的实体」
是同一件事，也说明页面显示值与导出件同源。

支持两种弧的写法：
  旧：裸 CIRCLE（整圆，需要靠 trim 语义表达其中一段 —— 已弃用）
  新：有理二次 B 样条（复合实例，圆弧写进曲线自身定义 —— 当前实现）
"""
import re
import sys
import math


ENT_RE = re.compile(r'#(\d+)\s*=\s*([A-Z_0-9]+)?\s*\(')


def parse_entities(text):
    """{id: (type, args_raw)}；复合实例的类型标为 'COMPLEX'"""
    ents = {}
    for m in ENT_RE.finditer(text):
        i = int(m.group(1))
        t = m.group(2) or 'COMPLEX'
        start = m.end() - 1
        depth = 0
        j = start
        while j < len(text):
            c = text[j]
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    break
            elif c == "'":
                j += 1
                while j < len(text) and text[j] != "'":
                    j += 1
            j += 1
        ents[i] = (t, text[start + 1:j])
    return ents


def nums(s):
    return [float(x) for x in re.findall(r'-?\d+\.?\d*(?:[eE][-+]?\d+)?', s)]


def refs(s):
    return [int(x) for x in re.findall(r'#(\d+)', s)]


def circle_from_rational_bezier(p0, p1, p2, w1):
    """由有理二次 Bézier 的三控制点与中间权重反解圆弧的圆心与半径。

    有理二次 Bézier 精确表示圆弧时：P1 是两切线交点，w1 = cos(Δ/2)。
    圆心落在 P0P1 与 P2P1 的角平分线上，且 |c-P0| = |c-P2| = r。
    直接解：圆心 = P1 沿 (P0-P1) 与 (P2-P1) 的单位向量之和方向偏移。
    设 u = (P0-P1)/|P0-P1|，v = (P2-P1)/|P2-P1|；
    则 c = P1 + t*(u+v)，且 |c-P0| = r = t*... 用半径公式解 t：
      cos(Δ/2) = w1 → Δ = 2*acos(w1)
      半径 r = |P0-P1| * w1 / sin(Δ/2)   （切线长 = r*tan(Δ/2) 的等价式）
    """
    d0 = math.hypot(p0[0] - p1[0], p0[1] - p1[1])
    d2 = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    if d0 < 1e-12 or d2 < 1e-12:
        return None
    half = math.acos(max(-1.0, min(1.0, w1)))       # Δ/2
    sin_half = math.sin(half)
    if sin_half < 1e-12:
        return None
    r = d0 * w1 / sin_half
    # 圆心：P1 沿角平分线朝内偏移 r/cos(Δ/2) ... 用 u,v 之和方向
    u = ((p0[0] - p1[0]) / d0, (p0[1] - p1[1]) / d0)
    v = ((p2[0] - p1[0]) / d2, (p2[1] - p1[1]) / d2)
    s = (u[0] + v[0], u[1] + v[1])
    sl = math.hypot(s[0], s[1])
    if sl < 1e-12:
        return None
    s = (s[0] / sl, s[1] / sl)
    # |c - P1| = r / cos(Δ/2) = r / w1
    dist = r / w1
    c = (p1[0] + s[0] * dist, p1[1] + s[1] * dist)
    return c, r


def main(path, length):
    text = open(path, encoding='utf-8', errors='replace').read()
    E = parse_entities(text)

    def pt(i):
        return tuple(nums(E[i][1]))

    # RATIONAL_B_SPLINE_CURVE 的权重内联在复合实例里：
    #   #n = ( BOUNDED_CURVE() B_SPLINE_CURVE(2,(#a,#b,#c),...) ... RATIONAL_B_SPLINE_CURVE((w0,w1,w2)) ... )
    curves = {}
    for i, (t, a) in E.items():
        if t == 'COMPLEX' and 'RATIONAL_B_SPLINE_CURVE' in a:
            rs = refs(a)
            wm = re.search(r'RATIONAL_B_SPLINE_CURVE\s*\(\s*\(([^)]*)\)', a)
            ws = nums(wm.group(1)) if wm else []
            if len(rs) >= 3 and len(ws) >= 3:
                curves[i] = ('arc', rs[0], rs[1], rs[2], ws[1])
        elif t == 'CIRCLE':
            curves[i] = ('circle', refs(a)[0], nums(a)[-1])

    circles = {}
    for i, (t, a) in E.items():
        if t == 'CIRCLE':
            circles[i] = (pt(refs(a)[0]), nums(a)[-1])

    edges = {}
    for i, (t, a) in E.items():
        if t == 'EDGE_CURVE':
            r = refs(a)
            edges[i] = (r[0], r[1], r[2])          # v1, v2, curve

    vertices = {}
    for i, (t, a) in E.items():
        if t == 'VERTEX_POINT':
            vertices[i] = pt(refs(a)[0])

    oriented = {}
    for i, (t, a) in E.items():
        if t == 'ORIENTED_EDGE':
            oriented[i] = (refs(a)[-1], '.T.' in a)

    loops = {}
    for i, (t, a) in E.items():
        if t == 'EDGE_LOOP':
            loops[i] = refs(a)

    bounds = {}
    for i, (t, a) in E.items():
        if t == 'FACE_OUTER_BOUND':
            bounds[i] = refs(a)[0]

    # 侧面轮廓环 = 边数最多的环（底盖/顶盖环）
    best = None
    for bi, li in bounds.items():
        mem = loops.get(li, [])
        if best is None or len(mem) > len(loops[best[1]]):
            best = (bi, li)
    bi, li = best
    mem = loops[li]
    print('选定轮廓环 #%d，边数 = %d' % (li, len(mem)))

    n_arc = 0
    dense = []
    for m in mem:
        eid, sense = oriented[m]
        v1, v2, cid = edges[eid]
        p1, p2 = vertices[v1], vertices[v2]
        if abs(p1[1]) > 1e-9 or abs(p2[1]) > 1e-9:
            continue                                # 只重建底环（y=0）
        cur = curves.get(cid)
        if cur and cur[0] == 'arc':
            _, a0, a1, a2, w1 = cur
            P0, P1, P2 = pt(a0), pt(a1), pt(a2)
            res = circle_from_rational_bezier((P0[0], P0[2]), (P1[0], P1[2]),
                                              (P2[0], P2[2]), w1)
            if res is None:
                dense.append((p1[0], p1[2]))
                continue
            (cx, cz), r = res
            t0 = math.atan2(P0[2] - cz, P0[0] - cx)
            t2 = math.atan2(P2[2] - cz, P2[0] - cx)
            d = t2 - t0
            while d > math.pi:
                d -= 2 * math.pi
            while d < -math.pi:
                d += 2 * math.pi
            N = 400
            for s in range(N):
                ang = t0 + d * s / N
                dense.append((cx + r * math.cos(ang), cz + r * math.sin(ang)))
            n_arc += 1
        elif cur and cur[0] == 'circle':
            _, aid, rad = cur
            cx, cy, cz = pt(aid)
            t0 = math.atan2(p1[2] - cz, p1[0] - cx)
            t2 = math.atan2(p2[2] - cz, p2[0] - cx)
            d = t2 - t0
            while d > math.pi:
                d -= 2 * math.pi
            while d < -math.pi:
                d += 2 * math.pi
            N = 400
            for s in range(N):
                ang = t0 + d * s / N
                dense.append((cx + rad * math.cos(ang), cz + rad * math.sin(ang)))
            n_arc += 1
        else:
            dense.append((p1[0], p1[2]))

    n = len(dense)
    area = 0.0
    for i in range(n):
        x1, z1 = dense[i]
        x2, z2 = dense[(i + 1) % n]
        area += x1 * z2 - x2 * z1
    area = abs(area) / 2
    print('其中圆弧边 = %d，离散后点数 = %d' % (n_arc, n))
    print('由 STEP 几何重建的截面积 = %.9f mm²' % area)
    print('推算体积 (×L=%g) = %.6f mm³' % (length, area * length))


if __name__ == '__main__':
    main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 50.0)
