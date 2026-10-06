// Inspection du FBX (Node) : matériaux, triangles, boîtes englobantes.
import { readFileSync } from "node:fs";
const stub = () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} });
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { createElementNS: stub, createElement: stub };
const THREE = await import("three");
const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
THREE.Cache.enabled = false;
const buf = readFileSync(process.argv[2]);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
root.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(root); const size = box.getSize(new THREE.Vector3());
console.log("taille", size.toArray().map((v) => v.toFixed(1)), "centre", box.getCenter(new THREE.Vector3()).toArray().map((v) => v.toFixed(1)));
const perMat = {};
root.traverse((o) => {
  if (!o.isMesh) return;
  const g = o.geometry, mats = Array.isArray(o.material) ? o.material : [o.material];
  const groups = g.groups.length ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
  const pos = g.attributes.position;
  for (const gr of groups) {
    const name = mats[gr.materialIndex]?.name ?? "?";
    const b = new THREE.Box3();
    for (let i = gr.start; i < gr.start + gr.count; i++) b.expandByPoint(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
    const e = (perMat[name] ??= { tris: 0, meshes: new Set(), box: new THREE.Box3() });
    e.tris += gr.count / 3; e.meshes.add(o.name); e.box.union(b);
  }
});
for (const [n, e] of Object.entries(perMat).sort((a, b) => b[1].tris - a[1].tris))
  console.log(n.padEnd(24), String(Math.round(e.tris)).padStart(6), "tri", `${e.meshes.size} mesh`, "min", e.box.min.toArray().map((v) => v.toFixed(0)).join(","), "max", e.box.max.toArray().map((v) => v.toFixed(0)).join(","));
