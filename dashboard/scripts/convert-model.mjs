// Convertit le modèle FBX de Wall-E en GLB léger pour le tableau de bord (rendu en couleurs).
//
//   node scripts/convert-model.mjs "../Wall-E+mark+2(2).fbx"   ->  public/models/wall-e.glb
//
// - Garde la géométrie et la couleur de chaque matière du FBX (une primitive par matière ; les textures,
//   absentes du dépôt, sont remplacées par leur couleur de base).
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
const LENS_MATERIALS = new Set(["wall_e1", "wall_e1_1"]);                // verres (textures absentes)
const NECK_Y = 34;                                                         // au-dessus : tête mobile

const buf = readFileSync(input);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
root.updateMatrixWorld(true);

// 1. Triangles en coordonnées monde, répartis par pièce puis par matière.
const parts = { body: [], head: [], eyes: [] };          // tous les triangles de la pièce (emprises, pivots)
const byMat = { body: new Map(), head: new Map(), eyes: new Map() };
const matInfo = new Map();                               // nom -> couleur (espace linéaire) et éclat
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
root.traverse((o) => {
  if (!o.isMesh) return;
  const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
  const pos = g.attributes.position;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  const groups = g.groups.length ? g.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
  for (const gr of groups) {
    const m = mats[gr.materialIndex];
    const mName = m?.name || "default";
    if (!matInfo.has(mName)) matInfo.set(mName, { color: m?.color ? [m.color.r, m.color.g, m.color.b] : [0.5, 0.5, 0.5], shininess: m?.shininess ?? 30 });
    const eye = EYE_MATERIALS.has(mName);
    for (let i = gr.start; i + 2 < gr.start + gr.count; i += 3) {
      a.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i + 1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i + 2).applyMatrix4(o.matrixWorld);
      const part = eye ? "eyes" : (a.y + b.y + c.y) / 3 > NECK_Y ? "head" : "body";
      parts[part].push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      if (!byMat[part].has(mName)) byMat[part].set(mName, []);
      byMat[part].get(mName).push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }
});

// 1 bis. Verres : ceux du modèle ne ferment pas l'orbite (on voit à travers). Un disque plein, à la taille de chaque
// verre et juste derrière lui, bouche l'œil ; il porte la matière du verre (noire, cf. gltfMaterial).
for (const lens of LENS_MATERIALS) {
  const tris = byMat.eyes.get(lens);
  if (!tris) continue;
  const box = new THREE.Box3();
  for (let i = 0; i < tris.length; i += 3) box.expandByPoint(a.set(tris[i], tris[i + 1], tris[i + 2]));
  const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, z = box.min.z - 0.05;
  const r = Math.min(box.max.x - box.min.x, box.max.y - box.min.y) / 2 * 1.04;
  const SEG = 48;
  for (let k = 0; k < SEG; k++) {
    const t0 = (k / SEG) * Math.PI * 2, t1 = ((k + 1) / SEG) * Math.PI * 2;
    tris.push(cx, cy, z, cx + r * Math.cos(t0), cy + r * Math.sin(t0), z, cx + r * Math.cos(t1), cy + r * Math.sin(t1), z);
  }
}

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
const materials = new Map();
const gltfMaterial = (name) => {
  if (!materials.has(name)) {
    const { shininess } = matInfo.get(name);
    const gold = /gold/i.test(name);
    // Carrosserie : le « Gold » pur du FBX tire sur le citron ; jaune ocre plus fidèle au personnage.
    // Lentilles des yeux : leurs textures ne sont pas fournies -> noir brillant, visibles des deux côtés (sinon on voit à travers).
    const lens = LENS_MATERIALS.has(name);
    const color = lens ? [0.004, 0.004, 0.004] : gold ? new THREE.Color("#e2a733").toArray() : matInfo.get(name).color;
    materials.set(name, doc.createMaterial(name).setBaseColorFactor([...color, 1]).setDoubleSided(lens)
      .setMetallicFactor(gold ? 0.6 : 0.15).setRoughnessFactor(lens ? 0.15 : gold ? 0.35 : Math.max(0.35, 1 - shininess / 100)));
  }
  return materials.get(name);
};
for (const [name, arr] of Object.entries(parts)) {
  // Origine de chaque pièce : sol pour le corps, cou pour la tête, centre des yeux pour les yeux
  // (le clignement met les yeux à l'échelle autour de leur propre centre).
  const whole = new THREE.BufferGeometry();
  whole.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
  whole.translate(shift.x, shift.y, shift.z);
  whole.computeBoundingBox();
  const origin = name === "body" ? new THREE.Vector3() : name === "head" ? pivot.clone() : whole.boundingBox.getCenter(new THREE.Vector3());
  const mesh = doc.createMesh(name);
  for (const [mName, tris] of byMat[name]) {
    let geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(tris, 3));
    geo.translate(shift.x - origin.x, shift.y - origin.y, shift.z - origin.z);
    geo = mergeVertices(geo, 1e-4);
    geo.computeVertexNormals();
    mesh.addPrimitive(doc.createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(geo.attributes.position.array).setBuffer(buffer))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(geo.attributes.normal.array).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(geo.index.array)).setBuffer(buffer))
      .setMaterial(gltfMaterial(mName)));
  }
  const node = doc.createNode(name).setMesh(mesh)
    .setTranslation(name === "eyes" ? origin.clone().sub(pivot).toArray() : [0, 0, 0]);
  (name === "body" ? rootNode : neck).addChild(node);
  console.log(`${name.padEnd(5)} ${String(arr.length / 9).padStart(6)} triangles, ${byMat[name].size} matière(s)`);
}
doc.createExtension(KHRMeshQuantization).setRequired(true);
await doc.transform(dedup(), weld(), quantize({ quantizePosition: 14, quantizeNormal: 8 }), prune());

mkdirSync(dirname(output), { recursive: true });
await new NodeIO().registerExtensions([KHRMeshQuantization]).write(output, doc);
const s = all.getSize(new THREE.Vector3());
console.log(`taille ${s.x.toFixed(1)} x ${s.y.toFixed(1)} x ${s.z.toFixed(1)}, pivot du cou ${pivot.toArray().map((v) => v.toFixed(1))}`);
console.log(`-> ${output} (${(readFileSync(output).length / 1024).toFixed(0)} Ko)`);
