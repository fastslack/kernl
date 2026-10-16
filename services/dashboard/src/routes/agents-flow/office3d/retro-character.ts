/** Pixel-grid silhouettes shared by walking figures and seated instances. */
export function pixelSilhouette(three: any, outline: number[][], pixel: number, depth: number) {
  const shape = new three.Shape();
  outline.forEach(([x, y], i) => {
    if (i === 0) shape.moveTo(x * pixel, y * pixel);
    else shape.lineTo(x * pixel, y * pixel);
  });
  shape.closePath();
  const geometry = new three.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 1 });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

export function retroBodyGeometries(three: any) {
  return {
    torso: pixelSilhouette(three, [[-4,-5],[4,-5],[4,3],[3,3],[3,5],[-3,5],[-3,3],[-4,3]], 0.06, 0.24),
    head: pixelSilhouette(three, [[-2,-3],[2,-3],[2,-2],[3,-2],[3,2],[2,2],[2,3],[-2,3],[-2,2],[-3,2],[-3,-2],[-2,-2]], 0.06, 0.24),
    hair: pixelSilhouette(three, [[-3,0],[-2,0],[-2,2],[1,2],[1,1],[3,1],[3,3],[2,3],[2,4],[-2,4],[-2,3],[-3,3]], 0.06, 0.26),
    neck: new three.BoxGeometry(0.12, 0.15, 0.12),
    arm: pixelSilhouette(three, [[-1,-3],[1,-3],[1,3],[0,3],[0,4],[-1,4]], 0.06, 0.12),
    hand: new three.BoxGeometry(0.12, 0.12, 0.12),
    leg: new three.BoxGeometry(0.18, 0.56, 0.18),
    shoe: new three.BoxGeometry(0.18, 0.12, 0.3),
    eye: new three.BoxGeometry(0.045, 0.045, 0.018),
  };
}
