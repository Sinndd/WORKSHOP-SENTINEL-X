// Convertit le modèle FBX de Wall-E en GLB léger pour l'hologramme du tableau de bord.
//
//   node scripts/convert-model.mjs "../Wall-E+mark+2(2).fbx"   ->  public/models/wall-e.glb
//
// - Ne garde que la géométrie (positions + normales) : l'hologramme n'utilise ni couleurs ni textures.
// - Découpe en 3 pièces animables : "body", "head" (pivot au cou) et "eyes" (lentilles avant, pivot en leur centre).
// - Recentre (base au sol, centre en x/z), soude les sommets et quantifie (KHR_mesh_quantization,
//   lu nativement par Three.js : aucun décodeur WASM, compatible avec la CSP du tableau de bord).
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// FBXLoader crée des éléments <img> pour les textures : bouchons minimaux pour Node.
const stub = () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} });
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { createElementNS: stub, createElement: stub };

const THREE = await import("three");
const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
const { mergeVertices } = await import("three/examples/jsm/utils/BufferGeometryUtils.js");
const { Document, NodeIO } = await import("@gltf-transform/core");
const { KHRMeshQuantization } = await import("@gltf-transform/extensions");
const { quantize, weld, prune, dedup } = await import("@gltf-transform/functions");

const here = dirname(fileURLToPath(import.meta.url));
const input = resolve(process.argv[2] ?? resolve(here, "../../Wall-E+mark+2(2).fbx"));
const output = resolve(here, "../public/models/wall-e.glb");

const EYE_MATERIALS = new Set(["wall_e1", "wall_e1_1", "Color_002"]);   // lentilles et cerclages avant
const NECK_Y = 34;                                                         // au-dessus : tête mobile

const buf = readFileSync(input);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
root.updateMatrixWorld(true);

// 1. Triangles en coordonnées monde, répartis par pièce.
const parts = { body: [], head: [], eyes: [] };
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
root.traverse((o) => {
  if (!o.isMesh) return;
  const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
  const pos = g.attributes.position;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  const groups = g.groups.length ? g.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
  for (const gr of groups) {
    const eye = EYE_MATERIALS.has(mats[gr.materialIndex]?.name);
    for (let i = gr.start; i + 2 < gr.start + gr.count; i += 3) {
      a.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i + 1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i + 2).applyMatrix4(o.matrixWorld);
      const part = eye ? "eyes" : (a.y + b.y + c.y) / 3 > NECK_Y ? "head" : "body";
      parts[part].push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }
});

// 2. Recentrage : base à y = 0, centre de l'emprise en x/z = 0.
const all = new THREE.Box3();
for (const arr of Object.values(parts)) for (let i = 0; i < arr.length; i += 3) all.expandByPoint(a.set(arr[i], arr[i + 1], arr[i + 2]));
const center = all.getCenter(new THREE.Vector3());
const shift = new THREE.Vector3(-center.x, -all.min.y, -center.z);
const headBox = new THREE.Box3();
for (let i = 0; i < parts.head.length; i += 3) headBox.expandByPoint(a.set(parts.head[i], parts.head[i + 1], parts.head[i + 2]).add(shift));
// Pivot du cou : centre de la tête en x/z, à la hauteur de la coupe.
const pivot = new THREE.Vector3(headBox.getCenter(a).x, NECK_Y + shift.y, headBox.getCenter(b).z);

// 3. Écriture glTF : chaque pièce = un nœud ; tête et yeux sont enfants d'un nœud "neck" placé au pivot.
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene("wall-e");
const neck = doc.createNode("neck").setTranslation(pivot.toArray());
scene.addChild(doc.createNode("root"));
const rootNode = scene.listChildren()[0];
rootNode.addChild(neck);
for (const [name, arr] of Object.entries(parts)) {
  let geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
  geo.translate(shift.x, shift.y, shift.z);
  // Origine de chaque pièce : sol pour le corps, cou pour la tête, centre des yeux pour les yeux
  // (le clignement met les yeux à l'échelle autour de leur propre centre).
  geo.computeBoundingBox();
  const origin = name === "body" ? new THREE.Vector3() : name === "head" ? pivot.clone() : geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-origin.x, -origin.y, -origin.z);
  geo = mergeVertices(geo, 1e-4);
  geo.computeVertexNormals();
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(geo.attributes.position.array).setBuffer(buffer))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(geo.attributes.normal.array).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(geo.index.array)).setBuffer(buffer));
  const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim))
    .setTranslation(name === "eyes" ? origin.clone().sub(pivot).toArray() : [0, 0, 0]);
  (name === "body" ? rootNode : neck).addChild(node);
  console.log(`${name.padEnd(5)} ${String(arr.length / 9).padStart(6)} triangles, ${geo.attributes.position.count} sommets`);
}
doc.createExtension(KHRMeshQuantization).setRequired(true);
await doc.transform(dedup(), weld(), quantize({ quantizePosition: 14, quantizeNormal: 8 }), prune());

mkdirSync(dirname(output), { recursive: true });
await new NodeIO().registerExtensions([KHRMeshQuantization]).write(output, doc);
const s = all.getSize(new THREE.Vector3());
console.log(`taille ${s.x.toFixed(1)} x ${s.y.toFixed(1)} x ${s.z.toFixed(1)}, pivot du cou ${pivot.toArray().map((v) => v.toFixed(1))}`);
console.log(`-> ${output} (${(readFileSync(output).length / 1024).toFixed(0)} Ko)`);
