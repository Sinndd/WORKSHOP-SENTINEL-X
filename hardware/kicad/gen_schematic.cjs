// Génère hardware/kicad/SENTINEL-X.kicad_sch (KiCad 8) : `node hardware/kicad/gen_schematic.cjs`
// Le schéma est décrit ici en code (composants, valeurs, nets) puis écrit au format KiCad.
// Convention : chaque broche utilisée reçoit un court fil terminé par une étiquette de net (ou un symbole
// d'alimentation) ; deux broches portant la même étiquette sont reliées. Modifier le schéma = modifier ce fichier.
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const uuid = () => crypto.randomUUID();
const ROOT = uuid();
const f = (n) => String(Math.round(n * 100) / 100);
const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
const FONT = "(effects (font (size 1.27 1.27)))";
const FONT_HIDE = "(effects (font (size 1.27 1.27)) hide)";

// ---------------------------------------------------------------- bibliothèque de symboles
const libs = new Map();     // lib_id -> texte
const pinPos = new Map();   // lib_id -> { nom: {x, y, angle, num} }

function pinText(p) {
  return `(pin ${p.type} line (at ${f(p.x)} ${f(p.y)} ${p.angle}) (length ${f(p.len)}) (name ${q(p.name)} ${FONT}) (number ${q(p.num)} ${FONT}))`;
}
function defineSymbol(libId, { ref, value, graphics, pins, hideNames = false, hideNumbers = false, power = false }) {
  const name = libId.split(":")[1];
  const map = {};
  pins.forEach((p) => { map[p.name + (p.alias ? "" : "")] = p; });
  pinPos.set(libId, pins);
  libs.set(libId, `    (symbol ${q(libId)}${power ? " (power)" : ""}${hideNumbers ? " (pin_numbers hide)" : ""} (pin_names (offset ${hideNames ? 0 : 1.016})${hideNames ? " hide" : ""}) (exclude_from_sim no) (in_bom ${power ? "no" : "yes"}) (on_board ${power ? "no" : "yes"})
      (property "Reference" ${q(ref)} (at 0 0 0) ${power ? FONT_HIDE : FONT})
      (property "Value" ${q(value)} (at 0 0 0) ${FONT})
      (property "Footprint" "" (at 0 0 0) ${FONT_HIDE})
      (property "Datasheet" "~" (at 0 0 0) ${FONT_HIDE})
      (symbol ${q(name + "_0_1")}
${graphics.map((g) => "        " + g).join("\n")}
      )
      (symbol ${q(name + "_1_1")}
${pins.map((p) => "        " + pinText(p)).join("\n")}
      )
    )`);
}
const stroke = "(stroke (width 0.254) (type default))";
const rect = (x1, y1, x2, y2, fill = "background") => `(rectangle (start ${f(x1)} ${f(y1)}) (end ${f(x2)} ${f(y2)}) ${stroke} (fill (type ${fill})))`;
const poly = (pts, fill = "none") => `(polyline (pts ${pts.map(([x, y]) => `(xy ${f(x)} ${f(y)})`).join(" ")}) ${stroke} (fill (type ${fill})))`;

// Boîtier générique : broches réparties sur les 4 côtés. sides = { left: [...], right: [...], top: [...], bottom: [...] }
function box(libId, ref, value, sides, minW = 12.7) {
  const L = sides.left || [], R = sides.right || [], T = sides.top || [], B = sides.bottom || [];
  const w = Math.max(minW, (Math.max(T.length, B.length) + 1) * 5.08), h = Math.max(7.62, (Math.max(L.length, R.length) + 1) * 2.54);
  const hw = w / 2, hh = h / 2, len = 3.81, pins = [];
  const spread = (arr, step) => arr.map((_, i) => (i - (arr.length - 1) / 2) * step);
  L.forEach((p, i) => pins.push({ ...p, x: -hw - len, y: -spread(L, 2.54)[i], angle: 0, len }));
  R.forEach((p, i) => pins.push({ ...p, x: hw + len, y: -spread(R, 2.54)[i], angle: 180, len }));
  T.forEach((p, i) => pins.push({ ...p, x: spread(T, 5.08)[i], y: hh + len, angle: 270, len }));
  B.forEach((p, i) => pins.push({ ...p, x: spread(B, 5.08)[i], y: -hh - len, angle: 90, len }));
  defineSymbol(libId, { ref, value, graphics: [rect(-hw, -hh, hw, hh)], pins });
  return { w, h };
}
const P = (name, num, type) => ({ name, num: String(num), type });

// Composants discrets (verticaux : broche 1 en haut, broche 2 en bas)
defineSymbol("SENTINEL:R", { ref: "R", value: "R", hideNames: true, hideNumbers: true, graphics: [rect(-1.016, -2.54, 1.016, 2.54, "none")],
  pins: [{ ...P("~", 1, "passive"), x: 0, y: 3.81, angle: 270, len: 1.27 }, { ...P("~", 2, "passive"), x: 0, y: -3.81, angle: 90, len: 1.27 }] });
defineSymbol("SENTINEL:C", { ref: "C", value: "C", hideNames: true, hideNumbers: true,
  graphics: [poly([[-2.032, 0.762], [2.032, 0.762]]), poly([[-2.032, -0.762], [2.032, -0.762]])],
  pins: [{ ...P("~", 1, "passive"), x: 0, y: 3.81, angle: 270, len: 3.048 }, { ...P("~", 2, "passive"), x: 0, y: -3.81, angle: 90, len: 3.048 }] });
defineSymbol("SENTINEL:C_Polarized", { ref: "C", value: "C_Polarized", hideNames: true, hideNumbers: true,
  graphics: [poly([[-2.032, 0.762], [2.032, 0.762]]), poly([[-2.032, -0.762], [2.032, -0.762]]), poly([[-1.5, 1.6], [-0.5, 1.6]]), poly([[-1, 1.1], [-1, 2.1]])],
  pins: [{ ...P("~", 1, "passive"), x: 0, y: 3.81, angle: 270, len: 3.048 }, { ...P("~", 2, "passive"), x: 0, y: -3.81, angle: 90, len: 3.048 }] });
const diodeG = [poly([[-1.27, -1.27], [1.27, -1.27], [0, 1.27], [-1.27, -1.27]], "outline"), poly([[-1.27, 1.27], [1.27, 1.27]])];
defineSymbol("SENTINEL:D", { ref: "D", value: "D", hideNames: true, hideNumbers: true, graphics: diodeG,
  pins: [{ ...P("K", 1, "passive"), x: 0, y: 3.81, angle: 270, len: 2.54 }, { ...P("A", 2, "passive"), x: 0, y: -3.81, angle: 90, len: 2.54 }] });
defineSymbol("SENTINEL:D_Zener", { ref: "D", value: "D_Zener", hideNames: true, hideNumbers: true,
  graphics: [...diodeG.slice(0, 1), poly([[-1.8, 0.76], [-1.27, 1.27], [1.27, 1.27], [1.8, 1.78]])],
  pins: [{ ...P("K", 1, "passive"), x: 0, y: 3.81, angle: 270, len: 2.54 }, { ...P("A", 2, "passive"), x: 0, y: -3.81, angle: 90, len: 2.54 }] });
defineSymbol("SENTINEL:Q_NPN", { ref: "Q", value: "2N2222", hideNames: true, hideNumbers: true,
  graphics: [`(circle (center 1.27 0) (radius 3.3) ${stroke} (fill (type none)))`, poly([[-1.27, 1.8], [-1.27, -1.8]]),
    poly([[-1.27, 0.635], [2.54, 2.54]]), poly([[-1.27, -0.635], [2.54, -2.54]])],
  pins: [{ ...P("B", 2, "passive"), x: -5.08, y: 0, angle: 0, len: 3.81 }, { ...P("C", 3, "passive"), x: 2.54, y: 5.08, angle: 270, len: 2.54 },
    { ...P("E", 1, "passive"), x: 2.54, y: -5.08, angle: 90, len: 2.54 }] });

// Symboles d'alimentation
const powerSym = (id, pos) => defineSymbol(`SENTINEL:${id}`, { ref: "#PWR", value: id, power: true, hideNames: true, hideNumbers: true,
  graphics: pos === "up" ? [poly([[-0.762, 1.27], [0, 2.54], [0.762, 1.27], [-0.762, 1.27]], "outline"), poly([[0, 0], [0, 1.27]])]
    : [poly([[0, 0], [0, -1.27]]), poly([[-1.27, -1.27], [1.27, -1.27], [0, -2.54], [-1.27, -1.27]], "outline")],
  pins: [{ ...P(id, 1, "power_in"), x: 0, y: 0, angle: pos === "up" ? 90 : 270, len: 0 }] });
powerSym("+5V", "up"); powerSym("+3V3", "up"); powerSym("GND", "down");

// Modules du projet
const dim = {};
dim.NODE = box("SENTINEL:NodeMCU_ESP8266", "U", "NodeMCU_ESP8266", {
  left: [P("D0", 1, "bidirectional"), P("D1", 2, "bidirectional"), P("D2", 3, "bidirectional"), P("D3", 4, "bidirectional"), P("D4", 5, "bidirectional")],
  right: [P("D5", 6, "bidirectional"), P("D6", 7, "bidirectional"), P("D7", 8, "bidirectional"), P("D8", 9, "bidirectional"), P("A0", 10, "input")],
  top: [P("VIN", 11, "power_in"), P("3V3", 12, "power_out")], bottom: [P("GND", 13, "power_in")],
}, 20.32);
dim.USB = box("SENTINEL:Alim_5V", "J", "Alim_5V", { top: [P("+5V", 1, "power_out")], bottom: [P("GND", 2, "power_out")] }, 10.16);
dim.OLED = box("SENTINEL:OLED_SSD1306_I2C", "DISP", "OLED_0.96_I2C", { right: [P("SCL", 3, "input"), P("SDA", 4, "bidirectional")], top: [P("VCC", 2, "power_in")], bottom: [P("GND", 1, "power_in")] });
dim.DHT = box("SENTINEL:DHT22_V182", "SEN", "DHT22_V182", { right: [P("DATA", 2, "bidirectional")], top: [P("VCC", 1, "power_in")], bottom: [P("GND", 3, "power_in")] });
dim.PIR = box("SENTINEL:PIR_HC-SR501", "SEN", "PIR_HC-SR501", { right: [P("OUT", 2, "output")], top: [P("VCC", 1, "power_in")], bottom: [P("GND", 3, "power_in")] });
dim.MQ = box("SENTINEL:MQ-2_Module", "SEN", "MQ-2_Module", { right: [P("AO", 3, "output"), P("DO", 4, "output")], top: [P("VCC", 1, "power_in")], bottom: [P("GND", 2, "power_in")] });
dim.RGB = box("SENTINEL:KS_RGB_Module", "D", "KS_RGB_Module", { right: [P("R", 1, "input"), P("G", 2, "input"), P("B", 3, "input")], bottom: [P("GND", 4, "power_in")] });
dim.BZ = box("SENTINEL:Buzzer_5V", "BZ", "Buzzer_YXDZ_5V", { top: [P("+", 1, "passive")], bottom: [P("-", 2, "passive")] }, 10.16);

// ---------------------------------------------------------------- placement
const out = { wires: [], labels: [], symbols: [], noconn: [], texts: [], frames: [] };
let pwrN = 0;
const outward = { 0: [-1, 0], 180: [1, 0], 270: [0, -1], 90: [0, 1] };
const STUB = 5.08;

function wire(x1, y1, x2, y2) {
  out.wires.push(`  (wire (pts (xy ${f(x1)} ${f(y1)}) (xy ${f(x2)} ${f(y2)})) (stroke (width 0) (type default)) (uuid ${q(uuid())}))`);
}
function label(name, x, y, dir) {
  const ang = { "-1,0": 180, "1,0": 0, "0,-1": 90, "0,1": 270 }[dir.join(",")];
  out.labels.push(`  (label ${q(name)} (at ${f(x)} ${f(y)} ${ang}) (effects (font (size 1.27 1.27)) (justify ${ang === 180 || ang === 270 ? "right" : "left"} bottom)) (uuid ${q(uuid())}))`);
}
function instance(libId, ref, value, x, y, extra = {}) {
  const pins = pinPos.get(libId);
  const dnp = extra.dnp ? "yes" : "no";
  const hideRef = ref.startsWith("#");
  out.symbols.push(`  (symbol (lib_id ${q(libId)}) (at ${f(x)} ${f(y)} 0) (unit 1) (exclude_from_sim no) (in_bom ${hideRef ? "no" : "yes"}) (on_board ${hideRef ? "no" : "yes"}) (dnp ${dnp})
    (uuid ${q(uuid())})
    (property "Reference" ${q(ref)} (at ${f(x + (extra.rx ?? 3))} ${f(y + (extra.ry ?? -1.5))} 0) (effects (font (size 1.27 1.27)) (justify left)${hideRef ? " hide" : ""}))
    (property "Value" ${q(value)} (at ${f(x + (extra.rx ?? 3))} ${f(y + (extra.ry ?? -1.5) + 2.54)} 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "" (at ${f(x)} ${f(y)} 0) ${FONT_HIDE})
    (property "Datasheet" "~" (at ${f(x)} ${f(y)} 0) ${FONT_HIDE})
${pins.map((p) => `    (pin ${q(p.num)} (uuid ${q(uuid())}))`).join("\n")}
    (instances (project "SENTINEL-X" (path "/${ROOT}" (reference ${q(ref)}) (unit 1))))
  )`);
}
function power(id, x, y) {
  instance(`SENTINEL:${id}`, `#PWR${String(++pwrN).padStart(2, "0")}`, id, x, y);
}
// Place un composant et relie ses broches : nets = { nomBroche: "NET" | "+5V" | "+3V3" | "GND" | null (non connectée) }
const snap = (v) => Math.round(v / 1.27) * 1.27;
function place(libId, ref, value, x, y, nets, extra = {}) {
  x = Math.round(snap(x) * 100) / 100; y = Math.round(snap(y) * 100) / 100;
  instance(libId, ref, value, x, y, extra);
  for (const p of pinPos.get(libId)) {
    const net = nets[p.name === "~" ? p.num : p.name];
    if (net === undefined) throw new Error(`${ref}: broche ${p.name}/${p.num} non définie`);
    const px = x + p.x, py = y - p.y, [dx, dy] = outward[p.angle];
    if (net === null) { out.noconn.push(`  (no_connect (at ${f(px)} ${f(py)}) (uuid ${q(uuid())}))`); continue; }
    const ex = px + dx * STUB, ey = py + dy * STUB;
    wire(px, py, ex, ey);
    if (["+5V", "+3V3", "GND"].includes(net)) power(net, ex, ey);
    else label(net, ex, ey, [dx, dy]);
  }
}
const frame = (x1, y1, x2, y2, title) => {
  out.frames.push(`  (rectangle (start ${f(x1)} ${f(y1)}) (end ${f(x2)} ${f(y2)}) (stroke (width 0.2) (type dash)) (fill (type none)) (uuid ${q(uuid())}))`);
  out.texts.push(`  (text ${q(title)} (at ${f(x1 + 2)} ${f(y1 + 4)} 0) (effects (font (size 2.54 2.54) bold) (justify left bottom)) (uuid ${q(uuid())}))`);
};
const note = (txt, x, y) => out.texts.push(`  (text ${q(txt)} (at ${f(x)} ${f(y)} 0) (effects (font (size 1.27 1.27)) (justify left top)) (uuid ${q(uuid())}))`);

// --- Cœur : ESP8266
place("SENTINEL:NodeMCU_ESP8266", "U1", "NodeMCU ESP8266 (ESP-12E)", 210.82, 127, {
  D0: "PIR_SIG", D1: "SCL", D2: "SDA", D3: null, D4: "DHT_DATA", D5: "RGB_B", D6: "RGB_G", D7: "RGB_R", D8: "BUZ_DRV", A0: "A0_GAS",
  VIN: "+5V", "3V3": "+3V3", GND: "GND",
}, { rx: -9, ry: -28 });
note("U1 : NodeMCU 1.0 (ESP-12E)\nD3 (GPIO0) : volontairement libre -> LOW au reset = mode flash\nD0 (GPIO16) : PIR, sans rôle au démarrage\nD8 (GPIO15) : doit rester LOW au démarrage (driver buzzer)\nD4 (GPIO2) : doit être HIGH au démarrage (pull-up du DHT)", 171, 168);

// --- Alimentation
frame(20, 20, 150, 82, "ALIMENTATION 5 V");
place("SENTINEL:Alim_5V", "J1", "USB / alim 5V-2A", 45, 52, { "+5V": "+5V", GND: "GND" }, { rx: -10, ry: -22 });
place("SENTINEL:C_Polarized", "C1", "470uF/10V", 85, 52, { 1: "+5V", 2: "GND" });
place("SENTINEL:C", "C2", "100nF", 105, 52, { 1: "+5V", 2: "GND" });
note("Alimentation dédiée 5 V / 2 A recommandée :\nMQ-2 (~150 mA) + buzzer + ESP8266 dépassent\nsouvent les 500 mA d'un port USB de PC.", 25, 74);

// --- PIR
frame(20, 90, 150, 165, "PIR HC-SR501 (corrigé)");
place("SENTINEL:PIR_HC-SR501", "SEN3", "PIR HC-SR501", 45, 128, { VCC: "+5V", OUT: "PIR_OUT", GND: "GND" }, { rx: -10, ry: -22 });
place("SENTINEL:R", "R1", "1k", 85, 118, { 1: "PIR_OUT", 2: "PIR_SIG" });
place("SENTINEL:R", "R2", "10k", 105, 128, { 1: "PIR_SIG", 2: "GND" });
place("SENTINEL:C_Polarized", "C3", "100uF/10V", 125, 108, { 1: "+5V", 2: "GND" });
place("SENTINEL:C", "C4", "100nF", 138, 108, { 1: "+5V", 2: "GND" });
note("VCC en 5 V obligatoire (module 4,5-20 V ; sortie 3,3 V).\nJumper en mode H (répétition), potentiomètre\nde délai au minimum, sensibilité au milieu.\nAttendre ~60 s de chauffe après la mise sous tension.", 25, 152);

// --- OLED
frame(20, 172, 150, 232, "ECRAN OLED I2C");
place("SENTINEL:OLED_SSD1306_I2C", "DISP1", "OLED 0.96 SSD1306 (0x3C)", 45, 202, { VCC: "+3V3", GND: "GND", SCL: "SCL", SDA: "SDA" }, { rx: -10, ry: -22 });
place("SENTINEL:R", "R3", "4.7k (DNP)", 95, 190, { 1: "+3V3", 2: "SCL" }, { dnp: true });
place("SENTINEL:R", "R4", "4.7k (DNP)", 112, 190, { 1: "+3V3", 2: "SDA" }, { dnp: true });
note("R3/R4 : à monter seulement si le module\nn'a pas déjà ses pull-up I2C.", 25, 222);

// --- DHT
frame(20, 238, 150, 288, "TEMPERATURE / HUMIDITE");
place("SENTINEL:DHT22_V182", "SEN2", "DHT22 (module V182)", 45, 266, { VCC: "+3V3", GND: "GND", DATA: "DHT_DATA" }, { rx: -10, ry: -22 });
place("SENTINEL:R", "R5", "10k (DNP)", 95, 258, { 1: "+3V3", 2: "DHT_DATA" }, { dnp: true });
note("R5 : pull-up de la ligne DATA (D4/GPIO2 doit être\nHIGH au démarrage) ; inutile si le module la contient.", 60, 278);

// --- MQ-2
frame(270, 20, 400, 95, "CAPTEUR DE GAZ MQ-2");
place("SENTINEL:MQ-2_Module", "SEN1", "MQ-2 (alim. 5 V)", 292, 55, { VCC: "+5V", GND: "GND", AO: "MQ_AO", DO: null }, { rx: -10, ry: -22 });
place("SENTINEL:R", "R6", "1k", 335, 45, { 1: "MQ_AO", 2: "A0_GAS" });
place("SENTINEL:D_Zener", "D2", "BZX55C3V3", 355, 58, { K: "A0_GAS", A: "GND" });
place("SENTINEL:C", "C5", "100nF", 372, 58, { 1: "A0_GAS", 2: "GND" });
note("Protège A0 : la zener limite l'entrée à 3,3 V (AO du MQ-2 peut\ndépasser 3,3 V en 5 V). Sous 3,3 V rien ne change :\nla calibration actuelle du firmware reste valable.", 275, 82);

// --- LED RGB
frame(270, 100, 400, 158, "LED RGB (module KS)");
place("SENTINEL:KS_RGB_Module", "D1", "KS RGB Module", 292, 130, { R: "RGB_R", G: "RGB_G", B: "RGB_B", GND: "GND" }, { rx: -10, ry: -22 });
note("Module à résistances intégrées (type KY-016).\nLED nue : 220 ohms en série sur chaque couleur.", 275, 148);

// --- Buzzer
frame(270, 165, 400, 232, "BUZZER (driver transistor)");
place("SENTINEL:R", "R7", "1k", 292, 195, { 1: "BUZ_DRV", 2: "BUZ_B" });
place("SENTINEL:R", "R8", "10k", 308, 205, { 1: "BUZ_B", 2: "GND" });
place("SENTINEL:Q_NPN", "Q1", "2N2222 / BC547", 335, 195, { B: "BUZ_B", C: "BUZ_N", E: "GND" });
place("SENTINEL:Buzzer_5V", "BZ1", "Buzzer YXDZ 5V", 365, 190, { "+": "+5V", "-": "BUZ_N" });
place("SENTINEL:D", "D3", "1N4148", 385, 190, { K: "+5V", A: "BUZ_N" });
note("Le buzzer 5 V n'est plus piloté directement par la GPIO 3,3 V :\nR8 maintient la base à 0 V au démarrage (D8 = GPIO15 doit être LOW),\nD3 absorbe la surtension de coupure.", 275, 218);

note("Révision v3.0 - 2026-10-05 : PIR déplacé de D3 (GPIO0) vers D0 (GPIO16) et alimenté en 5 V ; protection de A0 ; driver de buzzer.\nGénéré par hardware/kicad/gen_schematic.cjs", 140, 285);

// ---------------------------------------------------------------- écriture
const sch = `(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")
  (uuid ${q(ROOT)})
  (paper "A3")
  (title_block
    (title "MISSION SENTINEL-X - AVANT-POSTE INDUSTRIEL")
    (date "2026-10-05")
    (rev "v3.0")
    (company "AetherCorp Industrial Solutions / Workshop EPSI BAC+4")
    (comment 1 "Schema electrique - ESP8266 NodeMCU et peripheriques (PIR sur D0, 5 V, protections)")
  )
  (lib_symbols
${[...libs.values()].join("\n")}
  )
${out.frames.join("\n")}
${out.wires.join("\n")}
${out.noconn.join("\n")}
${out.labels.join("\n")}
${out.symbols.join("\n")}
${out.texts.join("\n")}
  (sheet_instances (path "/" (page "1")))
)
`;
const lib = `(kicad_symbol_lib (version 20231120) (generator "kicad_symbol_editor") (generator_version "8.0")
${[...libs.entries()].map(([id, txt]) => txt.replace(`(symbol "${id}"`, `(symbol "${id.split(":")[1]}"`)).join("\n")}
)
`;
fs.writeFileSync(path.join(__dirname, "SENTINEL.kicad_sym"), lib);
fs.writeFileSync(path.join(__dirname, "sym-lib-table"), `(sym_lib_table
  (version 7)
  (lib (name "SENTINEL")(type "KiCad")(uri "\${KIPRJMOD}/SENTINEL.kicad_sym")(options "")(descr "Symboles du projet SENTINEL-X"))
)
`);
const target = path.join(__dirname, "SENTINEL-X.kicad_sch");
fs.writeFileSync(target, sch);
console.log("écrit", target, `(${out.symbols.length} symboles, ${out.wires.length} fils, ${out.labels.length} étiquettes)`);
