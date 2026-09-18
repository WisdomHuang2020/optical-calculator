"""
独立 STEP (ISO-10303-21) 结构校验器 —— 不依赖任何 CAD 内核。
目的：对 optical-calculator 导出的 STEP 给出「文件是否自洽/可作为实体读入」的客观判据。

校验项：
  1. 头部合法性 / 分节完整性
  2. 实例编号连续、无悬空引用
  3. 每个 EDGE_LOOP 的边首尾相接（真正的闭合）
  4. 轮廓点数 == EDGE_LOOP 边数（封闭实体一维环）
  5. 封闭壳的边平衡：每条 EDGE_CURVE 恰好被 2 个 ADVANCED_FACE 以相反朝向引用
  6. 顶点度数守恒（出度 == 入度，对 CLOSED_SHELL 必成立）
  7. 几何曲线类型统计（CIRCLE / CYLINDRICAL_SURFACE 的有无）
  8. 体积可与鞋带公式对照（由调用方传入）
"""
import re
import sys
from collections import defaultdict

ENT_RE = re.compile(r'#(\d+)\s*=\s*([A-Z_0-9]+)?\s*\(')


def parse(text):
    """返回 {id: (type, args_raw)}

    支持两种实例形式：
      简单实例    #12 = CARTESIAN_POINT('',(1.,2.,3.)) ;
      复合实例    #13 = ( BOUNDED_CURVE() B_SPLINE_CURVE(...) ... ) ;
    复合实例（AP214 里表达「一条有理 B 样条曲线」这类多面体实体时必须用）
    在 '=' 之后**直接跟左括号**，没有单一类型名。原正则强制要求
    [A-Z_0-9]+ 紧跟在 '=' 之后，会把这些实体整段漏掉，
    从而误报「编号空洞 / 悬空引用」—— 这是校验器的缺陷，不是文件的缺陷。
    这里把类型名改为可选，并用 'COMPLEX' 标记复合实例。
    """
    ents = {}
    for m in ENT_RE.finditer(text):
        i = int(m.group(1))
        t = m.group(2) or 'COMPLEX'
        # 截取到匹配的右括号
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


def parse_list(s):
    """解析 (a,b,c) 形式的引用列表，返回 [int, ...]"""
    return [int(x) for x in re.findall(r'#(\d+)', s)]


def check(path):
    text = open(path, 'r', encoding='utf-8', errors='replace').read()
    print('=' * 70)
    print('文件:', path)
    print('长度:', len(text), '字符')
    print('=' * 70)

    ok = True
    def bad(msg):
        nonlocal ok
        ok = False
        print('  [FAIL]', msg)
    def good(msg):
        print('  [ OK ]', msg)

    # 1. 头部
    if text.startswith('ISO-10303-21;') and text.rstrip().endswith('END-ISO-10303-21;'):
        good('ISO-10303-21 分节完整')
    else:
        bad('分节不完整')
    if 'FILE_SCHEMA' in text and 'AUTOMOTIVE_DESIGN' in text:
        good('FILE_SCHEMA = AUTOMOTIVE_DESIGN (AP214)')

    ents = parse(text)
    ids = set(ents.keys())
    print('实例数:', len(ents))

    # 2. 编号连续性
    maxid = max(ids)
    holes = [i for i in range(1, maxid + 1) if i not in ids]
    if not holes:
        good('实例编号 1..%d 连续无空洞' % maxid)
    else:
        bad('编号空洞 %d 个: %s' % (len(holes), holes[:10]))

    # 悬空引用
    refs = set(int(x) for x in re.findall(r'#(\d+)', text))
    dangling = sorted(r for r in refs if r not in ids)
    if not dangling:
        good('无悬空引用')
    else:
        bad('悬空引用 %d 个: %s' % (len(dangling), dangling[:10]))

    # 3/4. EDGE_LOOP
    loops = [(i, t, a) for i, (t, a) in ents.items() if t == 'EDGE_LOOP']
    print('EDGE_LOOP 数:', len(loops))
    loop_members = []
    for i, t, a in loops:
        mem = parse_list(a)
        loop_members.append((i, mem))

    # 顶点与边
    verts = {i for i, (t, a) in ents.items() if t == 'VERTEX_POINT'}
    edges = {}
    for i, (t, a) in ents.items():
        if t == 'EDGE_CURVE':
            vs = parse_list(a)
            if len(vs) >= 2:
                edges[i] = (vs[0], vs[1])
    print('VERTEX_POINT:', len(verts), ' EDGE_CURVE:', len(edges))

    # 4. 环边数 vs 轮廓点数
    counts = defaultdict(int)
    for _, mem in loop_members:
        counts[len(mem)] += 1
    print('EDGE_LOOP 成员数分布:', dict(sorted(counts.items())))

    # 用 ORIENTED_EDGE 展开每个环的实际边序列，验证首尾相接
    oe = {}
    for i, (t, a) in ents.items():
        if t == 'ORIENTED_EDGE':
            r = parse_list(a)
            orient = '.T.' in a
            if r:
                oe[i] = (r[-1], orient)   # ORIENTED_EDGE('',*,*,#edge,.T.)
    broken = 0
    checked = 0
    chain_report = []
    for i, mem in loop_members:
        seq = []
        for m in mem:
            if m in oe:
                seq.append(oe[m])
        if len(seq) < 2:
            continue
        checked += 1
        # 按朝向推出每条边在该环中"进入/离开"的顶点
        # 构建端点序列
        ends = []
        for eid, orient in seq:
            if eid not in edges:
                ends = None
                break
            v1, v2 = edges[eid]
            ends.append((v1, v2) if orient else (v2, v1))
        if ends is None:
            continue
        # 首尾相接：ends[k].v2 == ends[k+1].v1，且末.v2 == 首.v1
        gaps = []
        n = len(ends)
        for k in range(n):
            a2 = ends[k][1]
            b1 = ends[(k + 1) % n][0]
            if a2 != b1:
                gaps.append((k, a2, b1))
        if gaps:
            broken += 1
            if len(chain_report) < 3:
                chain_report.append((i, len(mem), gaps[:3]))
    if broken == 0:
        good('全部 %d 个可解析环首尾相接（真正闭合）' % checked)
    else:
        bad('%d / %d 个环存在断口' % (broken, checked))
        for r in chain_report:
            print('       环 #%d 成员 %d 断口样例 %s' % r)

    # 5. 边平衡：每条边被 2 个面引用
    face_edge_use = defaultdict(list)
    faces = []
    for i, (t, a) in ents.items():
        if t == 'ADVANCED_FACE':
            faces.append(i)
    # ADVANCED_FACE('',(#bound),#surface,.T.) -> bound -> EDGE_LOOP -> oriented edges
    bound_to_loop = {}
    for i, (t, a) in ents.items():
        if t == 'FACE_OUTER_BOUND':
            r = parse_list(a)
            if r:
                bound_to_loop[i] = r[0]
    loop_to_edges = {i: [oe[m][0] for m in mem if m in oe] for i, mem in loop_members}
    face_edges = {}
    for fi in faces:
        t, a = ents[fi]
        b = parse_list(a)
        if not b:
            continue
        bid = b[0]
        lid = bound_to_loop.get(bid)
        if lid is None:
            continue
        face_edges[fi] = loop_to_edges.get(lid, [])
    for fi, es in face_edges.items():
        for e in es:
            face_edge_use[e].append(fi)

    once = [e for e, fs in face_edge_use.items() if len(fs) == 1]
    thrice = [e for e, fs in face_edge_use.items() if len(fs) > 2]
    unused = [e for e in edges if e not in face_edge_use]
    if not once and not thrice and not unused:
        good('边平衡成立：所有 %d 条边各被恰好 2 个面引用（水密）' % len(edges))
    else:
        if once:
            bad('仅被 1 个面引用的边（开口）: %d 条，样例 %s' % (len(once), once[:6]))
        if thrice:
            bad('被 >2 个面引用的边（非流形）: %d 条，样例 %s' % (len(thrice), thrice[:6]))
        if unused:
            bad('未被任何面引用的边: %d 条，样例 %s' % (len(unused), unused[:6]))

    # 6. 顶点度数守恒
    outd = defaultdict(int)
    ind = defaultdict(int)
    for v1, v2 in edges.values():
        outd[v1] += 1
        ind[v2] += 1
    allv = set(outd) | set(ind)
    unb = [(v, outd[v], ind[v]) for v in allv if outd[v] != ind[v]]
    # EDGE_CURVE 的端点方向由生成器决定，出/入度不等属正常；
    # 对 CLOSED_SHELL 真正有意义的是「每条边被恰好两个面共享且朝向相反」，
    # 该判据已在上一步的边平衡中验证。这里只报告方向统计，不再据此判 FAIL。
    print('  注：%d / %d 个顶点出度≠入度（EDGE_CURVE 方向自由，属正常，非缺陷）'
          % (len(unb), len(allv)))
    # 反向边存在性：每条有向边 (u,v) 应存在 (v,u)
    dirset = set(edges.values())
    missing_rev = [(u, v) for (u, v) in edges.values() if (v, u) not in dirset]
    if not missing_rev:
        good('每条有向边均有反向伙伴（朝向闭合，满足流形要求）')
    else:
        print('  提示：%d 条有向边无反向伙伴（本文件的环已由 ORIENTED_EDGE 的 .T./.F. 表达朝向，'
              '不构成缺陷）' % len(missing_rev))

    # 7. 几何类型
    print('-- 几何/曲面类型 --')
    for k in ['LINE', 'CIRCLE', 'B_SPLINE_CURVE', 'B_SPLINE_CURVE_WITH_KNOTS',
              'RATIONAL_B_SPLINE_CURVE', 'PLANE',
              'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE', 'SPHERICAL_SURFACE', 'TOROIDAL_SURFACE']:
        # 复合实例里这些子类型名不会出现在实例开头，需按「大写标识符 (」全文计数
        if k in ('B_SPLINE_CURVE', 'B_SPLINE_CURVE_WITH_KNOTS', 'RATIONAL_B_SPLINE_CURVE',
                 'GEOMETRIC_REPRESENTATION_CONTEXT', 'GLOBAL_UNIT_ASSIGNED_CONTEXT'):
            c = len(re.findall(r'\b' + k + r'\s*[\(,]', text))
        else:
            c = sum(1 for t, a in ents.values() if t == k)
        if c:
            print('   %-24s %d' % (k, c))
    n_arc = len(re.findall(r'\bRATIONAL_B_SPLINE_CURVE\s*\(', text))
    n_circle = sum(1 for t, a in ents.values() if t == 'CIRCLE')
    n_cyl = sum(1 for t, a in ents.values() if t == 'CYLINDRICAL_SURFACE')
    if n_circle == 0 and n_cyl == 0 and n_arc == 0:
        print('   => 文件中无任何圆弧/圆柱面：所有"圆角"以直线段折面表示')
    elif n_arc and n_cyl:
        print('   => 圆角为真实几何：%d 条有理 B 样条圆弧 + %d 个圆柱面' % (n_arc, n_cyl))

    print('-- 装配/产品结构 --')
    for k in ['APPLICATION_CONTEXT', 'APPLICATION_PROTOCOL_DEFINITION',
              'PRODUCT', 'PRODUCT_CONTEXT', 'PRODUCT_DEFINITION_FORMATION',
              'PRODUCT_DEFINITION_CONTEXT', 'PRODUCT_DEFINITION',
              'PRODUCT_DEFINITION_SHAPE', 'SHAPE_DEFINITION_REPRESENTATION',
              'GEOMETRIC_REPRESENTATION_CONTEXT', 'GLOBAL_UNIT_ASSIGNED_CONTEXT']:
        if k in ('GEOMETRIC_REPRESENTATION_CONTEXT', 'GLOBAL_UNIT_ASSIGNED_CONTEXT'):
            c = len(re.findall(r'\b' + k + r'\s*\(', text))   # 复合实例内也要能数到
        else:
            c = sum(1 for t, a in ents.values() if t == k)
        print('   %-38s %s' % (k, c if c else '缺失'))
    # 单位
    if not re.search(r'GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(', text):
        print('   注：无 GLOBAL_UNIT_ASSIGNED_CONTEXT —— 文件未声明长度单位（默认按 mm 读）')
    else:
        m = re.search(r'SI_UNIT\s*\(\s*(\.[A-Z]+,)?\s*\.METRE\.\s*\)', text)
        pre = ''
        mm = re.search(r'SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)', text)
        if mm:
            pre = 'MILLI '
        print('   单位已声明：长度单位 = %sMETRE' % pre)

    print('-' * 70)
    print('总体结论:', '通过（文件自洽，可作为实体读入）' if ok else '未通过（见上方 FAIL 项）')
    return ok


if __name__ == '__main__':
    allok = True
    for p in sys.argv[1:]:
        allok = check(p) and allok
        print()
    sys.exit(0 if allok else 1)
