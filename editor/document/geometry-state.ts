import type { Shape } from '../contracts';

/** Geometry inputs and derived caches checked before skipping reconciliation. */
export type GeometryState = Pick<Shape, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'transform' | 'box' | 'corners' | 'inverseTransform'> & {
    flipX?: boolean;
    flipY?: boolean;
};

function sameRecord(before: any, after: any): boolean {
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object')
        return false;
    const keys = Object.keys(before);
    return keys.length === Object.keys(after).length && keys.every(key => Object.hasOwn(after, key) && Object.is(before[key], after[key]));
}

/** Skipping calculation is safe only when both canonical inputs and derived
 * caches still match. Mutations of box/corners/inverseTransform must be repaired.
 * Never install shared mutable cache objects into a candidate before hooks run.
 */
export function geometryUnchanged(before: GeometryState | undefined, after: Shape): boolean {
    return !!before && ['x', 'y', 'width', 'height', 'rotation'].every(key => Object.is(before[key as keyof GeometryState], after[key])) &&
        !!before.flipX === !!after.flipX && !!before.flipY === !!after.flipY &&
        sameRecord(before.transform, after.transform) && sameRecord(before.inverseTransform, after.inverseTransform) &&
        sameRecord(before.box, after.box) && Array.isArray(before.corners) && Array.isArray(after.corners) && before.corners.length === after.corners.length &&
        before.corners.every((point, index) => sameRecord(point, after.corners[index]));
}
