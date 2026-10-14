/** Office → the panel view its 3D object opens (default: the room's whiteboard). */
export function anchorMap(
  offices: Array<{ flowId: string; anchors: Array<{ object: string; view: string }> }>,
  object = 'wall-board',
): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of offices) {
    const a = o.anchors.find((x) => x.object === object);
    if (a) m.set(o.flowId, a.view);
  }
  return m;
}
