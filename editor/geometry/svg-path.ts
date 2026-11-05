import type { Data, Point, Shape } from '../contracts';

export function canonicalPathSegments(segments: Data[]): Data[] {
    let previous: Point = { x: 0, y: 0 }, start = previous;
    return segments.map(segment => {
        const kind = String(segment.command ?? segment.type ?? 'line').toLowerCase(), command = ({ m: 'move', l: 'line', c: 'curve', cubic: 'curve', q: 'quadratic', z: 'close' } as Data)[kind] ?? kind;
        const result: Data = { ...segment, command };
        for (const key of ['type', 'point', 'to', 'control1', 'control2', 'c1', 'c2', 'handle1', 'handle2'])
            delete result[key];
        if (command === 'close') {
            previous = start;
            return result;
        }
        if (!['move', 'line', 'curve', 'quadratic'].includes(command))
            throw new Error('Invalid path command');
        const point = segment.point ?? segment.to ?? segment;
        result.x = point.x;
        result.y = point.y;
        if (command === 'curve' || command === 'quadratic') {
            const first = segment.control1 ?? segment.c1 ?? segment.handle1 ?? { x: segment.x1, y: segment.y1 }, second = segment.control2 ?? segment.c2 ?? segment.handle2 ?? { x: segment.x2, y: segment.y2 };
            result.x1 = command === 'quadratic' ? previous.x + 2 / 3 * (first.x - previous.x) : first.x;
            result.y1 = command === 'quadratic' ? previous.y + 2 / 3 * (first.y - previous.y) : first.y;
            result.x2 = command === 'quadratic' ? point.x + 2 / 3 * (first.x - point.x) : second.x;
            result.y2 = command === 'quadratic' ? point.y + 2 / 3 * (first.y - point.y) : second.y;
            result.command = 'curve';
        }
        const keys = result.command === 'curve' ? ['x', 'y', 'x1', 'y1', 'x2', 'y2'] : ['x', 'y'];
        if (!keys.every(key => Number.isFinite(result[key]) && Math.abs(result[key]) <= 1e9))
            throw new Error('Invalid path coordinates');
        previous = point;
        if (command === 'move')
            start = point;
        return result;
    });
}

export function normalizePathContent(shape: Shape, migrateLegacyEmpty = false): void {
    if (!['path', 'boolean'].includes(shape.type))
        return;
    const d = shape.d ?? shape.pathData ?? shape.path?.d;
    const aliases = typeof d === 'string' && d.trim() || (shape.segments ?? shape.path?.segments)?.length;
    if (Array.isArray(shape.content) && !(migrateLegacyEmpty && !shape.pathContentVersion && !shape.content.length && aliases)) {
        shape.pathContentVersion = 1;
        return;
    }
    const segments = typeof d === 'string' && d.trim() ? parseSvgPath(d) : shape.segments ?? shape.path?.segments ?? shape.content?.segments ?? (typeof d === 'string' ? parseSvgPath(d) : undefined);
    if (Array.isArray(segments)) {
        shape.content = canonicalPathSegments(segments);
        shape.pathContentVersion = 1;
    }
}

function arc(from: Point, to: Point, rx: number, ry: number, angle: number, large: number, sweep: number): Data[] {
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (!rx || !ry || from.x === to.x && from.y === to.y)
        return [{ type: 'line', point: to }];
    const phi = angle * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi), dx = (from.x - to.x) / 2, dy = (from.y - to.y) / 2, x = c * dx + s * dy, y = -s * dx + c * dy, lambda = x * x / (rx * rx) + y * y / (ry * ry);
    if (lambda > 1) {
        rx *= Math.sqrt(lambda);
        ry *= Math.sqrt(lambda);
    }
    const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y * y - ry * ry * x * x) / (rx * rx * y * y + ry * ry * x * x))), cxp = factor * rx * y / ry, cyp = -factor * ry * x / rx, cx = c * cxp - s * cyp + (from.x + to.x) / 2, cy = s * cxp + c * cyp + (from.y + to.y) / 2;
    const start = Math.atan2((y - cyp) / ry, (x - cxp) / rx);
    let delta = Math.atan2((-y - cyp) / ry, (-x - cxp) / rx) - start;
    if (sweep && delta < 0)
        delta += Math.PI * 2;
    if (!sweep && delta > 0)
        delta -= Math.PI * 2;
    const count = Math.ceil(Math.abs(delta) / (Math.PI / 2)), segments: Data[] = [];
    const p = (a: number) => ({ x: cx + rx * c * Math.cos(a) - ry * s * Math.sin(a), y: cy + rx * s * Math.cos(a) + ry * c * Math.sin(a) }), derivative = (a: number) => ({ x: -rx * c * Math.sin(a) - ry * s * Math.cos(a), y: -rx * s * Math.sin(a) + ry * c * Math.cos(a) });
    for (let i = 0; i < count; i++) {
        const a = start + delta * i / count, b = start + delta * (i + 1) / count, k = 4 / 3 * Math.tan((b - a) / 4), p0 = p(a), p1 = p(b), d0 = derivative(a), d1 = derivative(b);
        segments.push({ type: 'curve', control1: { x: p0.x + k * d0.x, y: p0.y + k * d0.y }, control2: { x: p1.x - k * d1.x, y: p1.y - k * d1.y }, point: i === count - 1 ? to : p1 });
    }
    return segments;
}
/** SVG path grammar interpreted into editable world-coordinate cubic segments. */
export function parseSvgPath(value: string, maxSegments = 50000): Data[] {
    if (value.length > 2000000 || !Number.isInteger(maxSegments) || maxSegments < 0 || maxSegments > 50000)
        throw new Error('SVG path too complex');
    const tokens: string[] = [], segments: Data[] = [];
    for (const match of value.matchAll(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)) {
        if (tokens.length >= maxSegments * 8)
            throw new Error('SVG path too complex');
        tokens.push(match[0]);
    }
    const append = (...next: Data[]) => {
        if (segments.length + next.length > maxSegments)
            throw new Error('SVG path too complex');
        segments.push(...next);
    };
    let index = 0, command = '', p: Point = { x: 0, y: 0 }, start = { ...p }, lastControl: Point | null = null, lastKind = '';
    const take = () => {
        const t = tokens[index++];
        if (t === undefined || /^[a-z]$/i.test(t))
            throw new Error('Invalid SVG path');
        const n = Number(t);
        if (!Number.isFinite(n))
            throw new Error('Invalid SVG path number');
        return n;
    };
    while (index < tokens.length) {
        if (/^[a-z]$/i.test(tokens[index]))
            command = tokens[index++];
        if (!command)
            throw new Error('SVG path command missing');
        const upper = command.toUpperCase(), relative = command !== upper, point = () => { const x = take(), y = take(); return { x: x + (relative ? p.x : 0), y: y + (relative ? p.y : 0) }; };
        if (upper === 'Z') {
            append({ type: 'close' });
            p = { ...start };
            lastControl = null;
            command = '';
            continue;
        }
        const old = { ...p };
        switch (upper) {
            case 'M':
                p = point();
                start = { ...p };
                append({ type: 'move', point: p });
                command = relative ? 'l' : 'L';
                break;
            case 'L':
                p = point();
                append({ type: 'line', point: p });
                break;
            case 'H':
                p = { x: take() + (relative ? p.x : 0), y: p.y };
                append({ type: 'line', point: p });
                break;
            case 'V':
                p = { x: p.x, y: take() + (relative ? p.y : 0) };
                append({ type: 'line', point: p });
                break;
            case 'C': {
                const c1 = point(), c2 = point();
                p = point();
                append({ type: 'curve', control1: c1, control2: c2, point: p });
                lastControl = c2;
                break;
            }
            case 'S': {
                const c1 = lastControl && ['C', 'S'].includes(lastKind) ? { x: 2 * p.x - lastControl.x, y: 2 * p.y - lastControl.y } : { ...p }, c2 = point();
                p = point();
                append({ type: 'curve', control1: c1, control2: c2, point: p });
                lastControl = c2;
                break;
            }
            case 'Q':
            case 'T': {
                const q: Point = upper === 'Q' ? point() : lastControl && ['Q', 'T'].includes(lastKind) ? { x: 2 * p.x - lastControl.x, y: 2 * p.y - lastControl.y } : { ...p };
                p = point();
                append({ type: 'curve', control1: { x: old.x + 2 / 3 * (q.x - old.x), y: old.y + 2 / 3 * (q.y - old.y) }, control2: { x: p.x + 2 / 3 * (q.x - p.x), y: p.y + 2 / 3 * (q.y - p.y) }, point: p });
                lastControl = q;
                break;
            }
            case 'A': {
                const flag = () => { const token = tokens[index]; if (!token || !/^([01])/.test(token))
                    throw new Error('Invalid SVG arc flag'); const value = Number(token[0]); if (token.length === 1)
                    index++;
                else
                    tokens[index] = token.slice(1); return value; };
                const rx = take(), ry = take(), a = take(), large = flag(), sweep = flag();
                p = point();
                append(...arc(old, p, rx, ry, a, large, sweep));
                break;
            }
            default: throw new Error(`Unsupported SVG path command ${command}`);
        }
        if (!['C', 'S', 'Q', 'T'].includes(upper))
            lastControl = null;
        lastKind = upper;
    }
    return segments;
}
