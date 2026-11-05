import type { Data, Point, Shape, Rect } from '../contracts';
import { shapePath } from './scene';
import type { CanvasKit, Path } from 'canvaskit-wasm';
let kitPromise: Promise<CanvasKit> | undefined;
export async function loadKit(wasmUrl?: string) {
    if (!kitPromise) {
        kitPromise = import('canvaskit-wasm/full').then(module => module.default({ locateFile: () => wasmUrl ?? '/canvaskit.wasm' })).catch(error => {
            kitPromise = undefined;
            throw error;
        });
    }
    return kitPromise;
}
export async function combinePaths(shapes: Shape[], operation: 'union' | 'subtract' | 'intersect' | 'exclude' | 'flatten', options: {
    wasmUrl?: string;
    objects?: Record<string, Shape>;
} = {}): Promise<{
    segments: Data[];
    fillRule: string;
    bounds: Rect;
}> {
    if (!shapes.length)
        throw new Error('At least one path is required');
    const kit = await loadKit(options.wasmUrl), paths: Path[] = [];
    let result: Path | undefined;
    try {
        const build = (shape: Shape): Path => {
            const children = (shape.childIds ?? []).map(id => options.objects?.[id]).filter((child): child is Shape => !!child && !child.hidden);
            if (children.length) {
                let combined = build(children[0]);
                const operation = shape.type === 'boolean' ? (shape.booleanOperation ?? shape.operation ?? 'union') : 'union';
                const op = operation === 'subtract' ? kit.PathOp.Difference : operation === 'intersect' ? kit.PathOp.Intersect : operation === 'exclude' ? kit.PathOp.XOR : kit.PathOp.Union;
                for (const child of children.slice(1)) {
                    const path = build(child);
                    try {
                        const next = kit.Path.MakeFromOp(combined, path, op);
                        if (!next)
                            throw new Error('Grouped operand could not be combined');
                        combined.delete();
                        combined = next;
                    }
                    finally {
                        path.delete();
                    }
                }
                return combined;
            }
            const pathData = shapePath(shape);
            if (!pathData || shape.childIds?.length && !children.length) {
                const builder = new kit.PathBuilder();
                try {
                    return builder.snapshot();
                }
                finally {
                    builder.delete();
                }
            }
            const path = kit.Path.MakeFromSVGString(pathData);
            if (!path)
                throw new Error(`Invalid path: ${shape.id}`);
            path.setFillType(shape.fillRule === 'evenodd' ? kit.FillType.EvenOdd : kit.FillType.Winding);
            const m = shape.type === 'path' || shape.type === 'boolean' ? { a: 1, b: 0, c: 0, d: 1 } : shape.transform ?? { a: 1, b: 0, c: 0, d: 1 }, cx = shape.x + shape.width / 2, cy = shape.y + shape.height / 2;
            const builder = new kit.PathBuilder(path);
            try {
                builder.transform(m.a, m.c, cx - m.a * cx - m.c * cy, m.b, m.d, cy - m.b * cx - m.d * cy, 0, 0, 1);
                return builder.snapshot();
            }
            finally {
                builder.delete();
                path.delete();
            }
        };
        for (const shape of shapes)
            paths.push(build(shape));
        result = paths[0].copy();
        const op = operation === 'subtract' ? kit.PathOp.Difference : operation === 'intersect' ? kit.PathOp.Intersect : operation === 'exclude' ? kit.PathOp.XOR : kit.PathOp.Union;
        for (const path of paths.slice(1)) {
            const merged = kit.Path.MakeFromOp(result, path, op);
            if (!merged)
                throw new Error('CanvasKit could not combine these paths');
            result.delete();
            result = merged;
        }
        if (operation === 'flatten') {
            const simplified = result.makeSimplified();
            if (!simplified)
                throw new Error('CanvasKit could not simplify the path');
            result.delete();
            result = simplified;
        }
        const tight = result.computeTightBounds();
        return { segments: canonicalSegments(kit, result.toCmds()), fillRule: 'nonzero', bounds: { x: tight[0], y: tight[1], width: Math.max(0, tight[2] - tight[0]), height: Math.max(0, tight[3] - tight[1]) } };
    }
    finally {
        result?.delete();
        for (const path of paths)
            path.delete();
    }
}
export function canonicalSegments(kit: CanvasKit, commands: Float32Array): Data[] {
    const segments: Data[] = [];
    let index = 0, current: Point = { x: 0, y: 0 }, origin: Point = { x: 0, y: 0 };
    const point = (): Point => ({ x: commands[index++], y: commands[index++] });
    const curve = (c1: Point, c2: Point, end: Point) => {
        segments.push({
            command: 'curve', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y
        });
        current = end;
    };
    while (index < commands.length) {
        const verb = commands[index++];
        if (verb === kit.MOVE_VERB) {
            current = point();
            origin = { ...current };
            segments.push({ command: 'move', ...current });
        }
        else if (verb === kit.LINE_VERB) {
            current = point();
            segments.push({ command: 'line', ...current });
        }
        else if (verb === kit.QUAD_VERB) {
            const control = point(), end = point();
            curve({ x: current.x + (control.x - current.x) * 2 / 3, y: current.y + (control.y - current.y) * 2 / 3 }, { x: end.x + (control.x - end.x) * 2 / 3, y: end.y + (control.y - end.y) * 2 / 3 }, end);
        }
        else if (verb === kit.CONIC_VERB) {
            const control = point(), end = point(), weight = commands[index++], start = { ...current };
            for (const segment of approximateConic(start, control, end, weight))
                curve(segment[0], segment[1], segment[2]);
        }
        else if (verb === kit.CUBIC_VERB) {
            const c1 = point(), c2 = point(), end = point();
            curve(c1, c2, end);
        }
        else if (verb === kit.CLOSE_VERB) {
            segments.push({ command: 'close' });
            current = { ...origin };
        }
        else
            throw new Error(`Unsupported CanvasKit path verb: ${verb}`);
    }
    return segments;
}
/** Rational quadratics are converted adaptively because the portable path ABI stores cubics. */
function approximateConic(start: Point, control: Point, end: Point, weight: number): [
    Point,
    Point,
    Point
][] {
    const value = (t: number): Point => {
        const a = (1 - t) ** 2, b = 2 * weight * t * (1 - t), c = t * t, d = a + b + c;
        return { x: (a * start.x + b * control.x + c * end.x) / d, y: (a * start.y + b * control.y + c * end.y) / d };
    };
    const derivative = (t: number): Point => {
        const a = (1 - t) ** 2, b = 2 * weight * t * (1 - t), c = t * t, d = a + b + c;
        const da = -2 * (1 - t), db = 2 * weight * (1 - 2 * t), dc = 2 * t, dd = da + db + dc;
        return { x: ((da * start.x + db * control.x + dc * end.x) * d - (a * start.x + b * control.x + c * end.x) * dd) / (d * d), y: ((da * start.y + db * control.y + dc * end.y) * d - (a * start.y + b * control.y + c * end.y) * dd) / (d * d) };
    };
    const result: [
        Point,
        Point,
        Point
    ][] = [];
    function subdivide(t0: number, t1: number, depth: number) {
        const a = value(t0), b = value(t1), da = derivative(t0), db = derivative(t1), dt = (t1 - t0) / 3;
        const c1 = { x: a.x + da.x * dt, y: a.y + da.y * dt }, c2 = { x: b.x - db.x * dt, y: b.y - db.y * dt };
        let error = 0;
        for (const t of [.25, .5, .75]) {
            const actual = value(t0 + (t1 - t0) * t), u = 1 - t;
            const x = u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.x, y = u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.y;
            error = Math.max(error, Math.hypot(actual.x - x, actual.y - y));
        }
        if (error <= 1e-6) {
            result.push([c1, c2, b]);
            return;
        }
        if (depth >= 20)
            throw new Error('Conic curve cannot meet the conversion tolerance');
        const middle = (t0 + t1) / 2;
        subdivide(t0, middle, depth + 1);
        subdivide(middle, t1, depth + 1);
    }
    subdivide(0, 1, 0);
    return result;
}
