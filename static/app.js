import * as THREE from "three";

const hud = document.getElementById("hud");
const statusEl = document.getElementById("status");
const btnVr = document.getElementById("btn-vr");
const xrFoot = document.getElementById("xr-foot");
const vrTools = document.getElementById("vr-tools");
const chkPassthrough = document.getElementById("chk-passthrough");

const API = () => `${location.origin}`;

/** Sfondo / nebbia (stesso tono per fusione orizzonte). */
const BG_NORMAL = new THREE.Color(0x080c14);

let ws = null;
/** Heartbeat verso server (watchdog): solo fuori VR; in sessione XR `animate` invia già input ogni frame. */
let wsKeepAlive = null;

/** WebXR Y-up -> MuJoCo z-up (inverso della mappa posizioni usata dal server per le mesh). */
function xrPosToMj(p) {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  return [x, -z, y];
}

/** Offset mani (metri, frame MuJoCo dopo xrPosToMj), sommato lato client; persiste in localStorage. */
const HAND_CALIB_STORAGE_KEY = "g1-hand-calib-v1";
const CALIB_LIM = 0.75;
const handCalibOffset = { x: 0, y: 0, z: 0 };

function loadHandCalib() {
  try {
    const raw = localStorage.getItem(HAND_CALIB_STORAGE_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (typeof j.x === "number") handCalibOffset.x = j.x;
    if (typeof j.y === "number") handCalibOffset.y = j.y;
    if (typeof j.z === "number") handCalibOffset.z = j.z;
    clampHandCalib();
  } catch (_) {
    /* ignore */
  }
}

function persistHandCalib() {
  try {
    localStorage.setItem(
      HAND_CALIB_STORAGE_KEY,
      JSON.stringify({ x: handCalibOffset.x, y: handCalibOffset.y, z: handCalibOffset.z }),
    );
  } catch (_) {
    /* ignore */
  }
}

function clampHandCalib() {
  handCalibOffset.x = Math.max(-CALIB_LIM, Math.min(CALIB_LIM, handCalibOffset.x));
  handCalibOffset.y = Math.max(-CALIB_LIM, Math.min(CALIB_LIM, handCalibOffset.y));
  handCalibOffset.z = Math.max(-CALIB_LIM, Math.min(CALIB_LIM, handCalibOffset.z));
}

function applyHandCalibToHands(hands) {
  if (!hands || typeof hands !== "object") return hands;
  const { x: ox, y: oy, z: oz } = handCalibOffset;
  const out = { ...hands };
  const bump = (a) =>
    Array.isArray(a) && a.length >= 3 ? [a[0] + ox, a[1] + oy, a[2] + oz] : a;
  if (out.left) out.left = bump(out.left);
  if (out.right) out.right = bump(out.right);
  return out;
}

function syncHandCalibUI() {
  const fmt = (n) => n.toFixed(3);
  const sx = document.getElementById("calib-x-slider");
  const sy = document.getElementById("calib-y-slider");
  const sz = document.getElementById("calib-z-slider");
  const vx = document.getElementById("calib-x-val");
  const vy = document.getElementById("calib-y-val");
  const vz = document.getElementById("calib-z-val");
  if (sx) sx.value = String(handCalibOffset.x);
  if (sy) sy.value = String(handCalibOffset.y);
  if (sz) sz.value = String(handCalibOffset.z);
  if (vx) vx.textContent = fmt(handCalibOffset.x);
  if (vy) vy.textContent = fmt(handCalibOffset.y);
  if (vz) vz.textContent = fmt(handCalibOffset.z);
}

function initHandCalibUI() {
  loadHandCalib();
  syncHandCalibUI();

  const panel = document.getElementById("hand-calib");
  panel?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("button[data-d]");
    if (!btn) return;
    const row = btn.closest(".btns");
    const axis = row?.dataset?.axis;
    const d = parseFloat(btn.dataset.d);
    if (axis !== "x" && axis !== "y" && axis !== "z") return;
    if (!Number.isFinite(d)) return;
    handCalibOffset[axis] += d;
    clampHandCalib();
    syncHandCalibUI();
    persistHandCalib();
  });

  for (const axis of ["x", "y", "z"]) {
    document.getElementById(`calib-${axis}-slider`)?.addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      if (!Number.isFinite(v)) return;
      handCalibOffset[axis] = v;
      clampHandCalib();
      syncHandCalibUI();
      persistHandCalib();
    });
  }

  document.getElementById("calib-reset")?.addEventListener("click", () => {
    handCalibOffset.x = handCalibOffset.y = handCalibOffset.z = 0;
    syncHandCalibUI();
    persistHandCalib();
  });

  const pad = document.getElementById("calib-pad");
  let padActive = false;
  let padRaf = 0;
  let padNorm = { x: 0, y: 0 };
  let padLastT = performance.now();

  function padLoop() {
    if (!padActive) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - padLastT) / 1000);
    padLastT = now;
    const sens = 0.42;
    handCalibOffset.x += padNorm.x * sens * dt;
    handCalibOffset.y -= padNorm.y * sens * dt;
    clampHandCalib();
    syncHandCalibUI();
    persistHandCalib();
    padRaf = requestAnimationFrame(padLoop);
  }

  function stopPad(e) {
    if (!padActive) return;
    padActive = false;
    padNorm.x = padNorm.y = 0;
    if (padRaf) cancelAnimationFrame(padRaf);
    padRaf = 0;
    if (pad && e?.pointerId != null) {
      try {
        pad.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
  }

  pad?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    padActive = true;
    padLastT = performance.now();
    if (!padRaf) padRaf = requestAnimationFrame(padLoop);
  });
  pad?.addEventListener("pointermove", (e) => {
    if (!padActive) return;
    const r = pad.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const my = ((e.clientY - r.top) / r.height) * 2 - 1;
    padNorm.x = Math.max(-1, Math.min(1, mx));
    padNorm.y = Math.max(-1, Math.min(1, my));
  });
  pad?.addEventListener("pointerup", stopPad);
  pad?.addEventListener("pointercancel", stopPad);
}

initHandCalibUI();

function connectWs() {
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsProto}//${location.host}/ws`;
  if (wsKeepAlive) {
    clearInterval(wsKeepAlive);
    wsKeepAlive = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  ws = new WebSocket(url);
  ws.onopen = () => {
    const cur = statusEl?.textContent || "";
    const tag = `WS OK (${location.protocol}//${location.host})`;
    setStatus(cur.includes(tag) ? cur : `${cur} | ${tag}`.replace(/^\s*\|\s*/, ""));
    wsKeepAlive = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (renderer.xr.isPresenting) return;
      ws.send(JSON.stringify({ type: "ping" }));
    }, 250);
  };
  ws.onclose = () => {
    if (wsKeepAlive) {
      clearInterval(wsKeepAlive);
      wsKeepAlive = null;
    }
    setStatus("WS disconnesso — controlla server.py e usa https://…:8443/");
  };
  ws.onerror = () => setStatus("Errore WS (serve stesso host/protocol della pagina)");
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state" && msg.sim?.geom_mat4) applyRobotMatrices(msg.sim.geom_mat4);
    } catch (_) {}
  };
}
connectWs();

function setStatus(t) {
  if (statusEl) statusEl.textContent = t;
}

function sendInput(axes, hands) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const o = { type: "input", axes };
  if (hands !== undefined) o.hands = applyHandCalibToHands(hands);
  ws.send(JSON.stringify(o));
}

const scene = new THREE.Scene();
scene.background = BG_NORMAL.clone();
scene.fog = new THREE.Fog(BG_NORMAL.getHex(), 5.5, 38);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(2, 1.5, 2);
camera.lookAt(0, 0.8, 0);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0x9fb4d6, 0.38));
const hemi = new THREE.HemisphereLight(0xb8cceb, 0x121820, 0.95);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff5e8, 1.85);
sun.position.set(5.5, 14, 4.5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 0.4;
sun.shadow.camera.far = 42;
sun.shadow.camera.left = -11;
sun.shadow.camera.right = 11;
sun.shadow.camera.top = 14;
sun.shadow.camera.bottom = -4;
sun.shadow.bias = -0.00025;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);
sun.target.position.set(0, 0.85, -0.6);

/** Pavimento, griglia, parete: nascosti in passthrough insieme. */
const roomShell = new THREE.Group();
scene.add(roomShell);

const gridHelper = new THREE.GridHelper(26, 52, 0x4a5f7a, 0x283246);
gridHelper.position.y = 0.004;
roomShell.add(gridHelper);

const backWall = new THREE.Mesh(
  new THREE.PlaneGeometry(28, 14),
  new THREE.MeshStandardMaterial({
    color: 0x1a222c,
    roughness: 0.96,
    metalness: 0.05,
    emissive: 0x0a1018,
    emissiveIntensity: 0.22,
  }),
);
backWall.position.set(0, 4.2, 4.2);
backWall.rotation.y = Math.PI;
backWall.receiveShadow = true;
roomShell.add(backWall);

const rimLight = new THREE.DirectionalLight(0x6b9fff, 0.35);
rimLight.position.set(-6, 6, -3);
scene.add(rimLight);

/** Banco di assemblaggio: gruppo ruotato 90° rispetto al nastro (nastro lungo +X). */
const deskGroup = new THREE.Group();
scene.add(deskGroup);
/** Prensili in coordinate mondo (NON figli di deskGroup altrimenti mesh e Cannon si disallineano). */
const pickRoot = new THREE.Group();
scene.add(pickRoot);

/** Ancoraggio corsia nastro (non coincide più col tavolo). */
const TABLE_Z = -0.72;
const TABLE_TOP_Y = 0.82;
/** Tavolino industriale (top più piccolo, acciaio). Dimensioni in spazio locale gruppo: lungo X, corto Z. */
const DESK_TOP_W = 0.92;
const DESK_TOP_D = 0.58;
const DESK_TOP_THK = 0.038;
const DESK_GROUP_X = -0.2;
const DESK_GROUP_Z = 0.07;
const DESK_ROT_Y = Math.PI / 2;

function applyDeskGroupPose() {
  deskGroup.position.set(DESK_GROUP_X, 0, DESK_GROUP_Z);
  deskGroup.setRotationFromEuler(new THREE.Euler(0, DESK_ROT_Y, 0));
  deskGroup.scale.set(1, 1, 1);
  deskGroup.updateMatrixWorld(true);
}

applyDeskGroupPose();
/** Nastro (fisica + logica): avanza lungo +X, corsia tra z0–z1. */
const BELT_Z0 = TABLE_Z + 0.22;
const BELT_Z1 = TABLE_Z + 0.5;
const BELT = {
  x0: -0.92,
  x1: 0.52,
  z0: BELT_Z0,
  z1: BELT_Z1,
  /** Velocità di trasporto lungo +X (m/s). */
  vx: 0.42,
  dispatchX: 0.48,
};
/** Superiore nastro (allineato al mesh visivo) e spessore collider fisico. */
const BELT_VIS_TOP = TABLE_TOP_Y + 0.026;
const BELT_PHY_HALF_Y = 0.048;
const BELT_PHY_CENTER_Y = BELT_VIS_TOP - BELT_PHY_HALF_Y;

/** Texture a strisce animata sul nastro. */
let beltScrollTexture = null;
let lastAnimTime = performance.now();

function buildIndustrialConveyorBelt() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 16;
  const ctx = c.getContext("2d");
  if (ctx) {
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#252d3a" : "#e8b923";
      ctx.fillRect(i * 8, 0, 8, 16);
    }
  }
  beltScrollTexture = new THREE.CanvasTexture(c);
  beltScrollTexture.wrapS = THREE.RepeatWrapping;
  beltScrollTexture.wrapT = THREE.ClampToEdgeWrapping;
  beltScrollTexture.repeat.set(16, 1);
  const beltMat = new THREE.MeshStandardMaterial({
    map: beltScrollTexture,
    color: 0x2a3038,
    roughness: 0.78,
    metalness: 0.12,
  });
  const beltW = BELT.z1 - BELT.z0;
  const beltLen = BELT.x1 - BELT.x0;
  const beltThick = 0.028;
  const beltMesh = new THREE.Mesh(new THREE.BoxGeometry(beltLen, beltThick, beltW), beltMat);
  beltMesh.position.set((BELT.x0 + BELT.x1) * 0.5, BELT_VIS_TOP - beltThick * 0.5, (BELT.z0 + BELT.z1) * 0.5);
  beltMesh.castShadow = true;
  beltMesh.receiveShadow = true;
  roomShell.add(beltMesh);

  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x343b4d,
    metalness: 0.58,
    roughness: 0.36,
  });
  const sideGeo = new THREE.BoxGeometry(beltLen + 0.14, 0.052, 0.04);
  const sideY = BELT_VIS_TOP - beltThick - 0.024;
  const s0 = new THREE.Mesh(sideGeo, frameMat);
  s0.position.set(beltMesh.position.x, sideY, BELT.z0 - 0.028);
  const s1 = s0.clone();
  s1.position.z = BELT.z1 + 0.028;
  roomShell.add(s0, s1);

  const legGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.42, 12);
  const frameBottomY = sideY - 0.026;
  const legCy = frameBottomY - 0.21;
  for (const sx of [BELT.x0 + 0.08, BELT.x1 - 0.08]) {
    for (const sz of [BELT.z0 - 0.02, BELT.z1 + 0.02]) {
      const leg = new THREE.Mesh(legGeo, frameMat);
      leg.position.set(sx, Math.max(0.21, legCy), sz);
      leg.castShadow = true;
      roomShell.add(leg);
    }
  }

}

const tableTop = new THREE.Mesh(
  new THREE.BoxGeometry(DESK_TOP_W, DESK_TOP_THK, DESK_TOP_D),
  new THREE.MeshStandardMaterial({
    color: 0x5a6572,
    roughness: 0.48,
    metalness: 0.62,
    envMapIntensity: 0,
  }),
);
tableTop.position.set(0, TABLE_TOP_Y - DESK_TOP_THK * 0.5, 0);
tableTop.receiveShadow = true;
tableTop.castShadow = true;
deskGroup.add(tableTop);

const legMat = new THREE.MeshStandardMaterial({
  color: 0x3a4250,
  roughness: 0.55,
  metalness: 0.5,
  envMapIntensity: 0,
});
const legH = TABLE_TOP_Y - DESK_TOP_THK;
const legInsetX = DESK_TOP_W * 0.5 - 0.055;
const legInsetZ = DESK_TOP_D * 0.5 - 0.055;
for (const sx of [-1, 1]) {
  for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.048, legH, 0.048), legMat);
    leg.position.set(sx * legInsetX, legH * 0.5, sz * legInsetZ);
    leg.castShadow = true;
    leg.receiveShadow = true;
    deskGroup.add(leg);
  }
}

const deskLight = new THREE.PointLight(0xfff0e0, 12, 3.8, 1.25);
deskLight.position.set(0, TABLE_TOP_Y + 0.42, 0);
deskGroup.add(deskLight);

buildIndustrialConveyorBelt();

const grabbables = [];
const pinchState = {
  left: {
    mesh: null,
    grabVel: new THREE.Vector3(),
    prevGrabMid: new THREE.Vector3(),
    prevGrabT: 0,
    wristQuat: new THREE.Quaternion(),
    grabQuatOff: new THREE.Quaternion(),
    prevWristQuat: new THREE.Quaternion(),
    prevWristT: 0,
    grabAngVel: new THREE.Vector3(),
  },
  right: {
    mesh: null,
    grabVel: new THREE.Vector3(),
    prevGrabMid: new THREE.Vector3(),
    prevGrabT: 0,
    wristQuat: new THREE.Quaternion(),
    grabQuatOff: new THREE.Quaternion(),
    prevWristQuat: new THREE.Quaternion(),
    prevWristT: 0,
    grabAngVel: new THREE.Vector3(),
  },
};
const _vThumb = new THREE.Vector3();
const _vIndex = new THREE.Vector3();
const _vMid = new THREE.Vector3();
const _vGrabDelta = new THREE.Vector3();
const _vGrabWorld = new THREE.Vector3();
const _vAngDelta = new THREE.Vector3();
const _qAngDel = new THREE.Quaternion();
const _qAngPrevInv = new THREE.Quaternion();

/** @type {null | (() => void)} */
let xrRefSpaceResetCleanup = null;

/** Snapshot solo terreno + piano tavolo (primi 2 body); i pezzi linea sono rigenerati a reset. */
let deskPhysicsRestSnapshot = [];

function captureDeskPhysicsRestState() {
  if (!deskPhysics?.world?.bodies?.length) return;
  deskPhysicsRestSnapshot = deskPhysics.world.bodies.slice(0, 2).map((b) => ({
    px: b.position.x,
    py: b.position.y,
    pz: b.position.z,
    qx: b.quaternion.x,
    qy: b.quaternion.y,
    qz: b.quaternion.z,
    qw: b.quaternion.w,
    vx: b.velocity.x,
    vy: b.velocity.y,
    vz: b.velocity.z,
    ax: b.angularVelocity.x,
    ay: b.angularVelocity.y,
    az: b.angularVelocity.z,
  }));
}

/**
 * Dopo reset XR (guardian / pavimento / gesture di ricentratura): niente matrici XR sul tavolo
 * (spesso portava il desk sopra la testa). Si ripristina deskGroup a origine e la fisica allo snapshot.
 */
function restoreDeskXRLayoutToDefaults() {
  applyDeskGroupPose();

  pinchState.left.mesh = pinchState.right.mesh = null;
  resetGrabTracking(pinchState.left);
  resetGrabTracking(pinchState.right);
  for (const o of grabbables) {
    o.userData.heldBy = null;
    releaseBody(o, null, null);
  }

  if (!deskPhysics?.world?.bodies?.length || deskPhysicsRestSnapshot.length !== 2) {
    return;
  }
  const bodies = deskPhysics.world.bodies;
  for (let i = 0; i < 2; i++) {
    const b = bodies[i];
    const s = deskPhysicsRestSnapshot[i];
    b.position.set(s.px, s.py, s.pz);
    b.quaternion.set(s.qx, s.qy, s.qz, s.qw);
    b.velocity.set(s.vx, s.vy, s.vz);
    b.angularVelocity.set(s.ax, s.ay, s.az);
    if (b.mass > 0) {
      b.wakeUp();
      if (typeof b.updateMassProperties === "function") b.updateMassProperties();
    }
  }
  resetFactoryScene();
  for (const m of grabbables) {
    const b = m.userData.cannonBody;
    if (!b) continue;
    m.position.set(b.position.x, b.position.y, b.position.z);
    m.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  }
}

function addGrabbable(mesh) {
  mesh.userData.heldBy = null;
  grabbables.push(mesh);
  pickRoot.add(mesh);
}

function removeGrabbable(mesh) {
  const idx = grabbables.indexOf(mesh);
  if (idx >= 0) grabbables.splice(idx, 1);
  const b = mesh.userData.cannonBody;
  if (b && deskPhysics?.world) {
    deskPhysics.world.removeBody(b);
  }
  mesh.userData.cannonBody = null;
  mesh.parent?.remove(mesh);
}

function clearFactoryGrabbables() {
  const list = [...grabbables];
  for (const m of list) {
    if (m.userData.partKind) removeGrabbable(m);
  }
}

function spawnAssemblyPair() {
  if (!deskPhysics?.world) return;
  const { world, Body, Vec3, Box, contactMat } = deskPhysics;

  const beltMidZ = (BELT.z0 + BELT.z1) * 0.5;
  const partMass = 0.36;
  const partDamp = 0.13;
  const partAng = 0.19;

  const housingMat = new THREE.MeshStandardMaterial({
    color: 0x6b7280,
    metalness: 0.45,
    roughness: 0.42,
  });
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.055, 0.1), housingMat);
  housing.position.set(-0.82, BELT_VIS_TOP + 0.03, beltMidZ);
  housing.castShadow = true;
  housing.receiveShadow = true;
  housing.userData.partKind = "housing";
  housing.userData.physicsSpec = { type: "box", hx: 0.05, hy: 0.0275, hz: 0.05 };
  addGrabbable(housing);
  const bH = new Body({
    mass: partMass,
    material: contactMat,
    linearDamping: partDamp,
    angularDamping: partAng,
  });
  bH.addShape(new Box(new Vec3(0.05, 0.0275, 0.05)));
  bH.position.set(housing.position.x, housing.position.y, housing.position.z);
  world.addBody(bH);
  housing.userData.cannonBody = bH;

  /* Inserito: parallelepipedo (stessa corsia Z del nastro → stessa velocità di trasporto). */
  const pinMat = new THREE.MeshStandardMaterial({
    color: 0xc9a227,
    metalness: 0.65,
    roughness: 0.28,
  });
  const pinHx = 0.02;
  const pinHy = 0.028;
  const pinHz = 0.02;
  const pin = new THREE.Mesh(
    new THREE.BoxGeometry(pinHx * 2, pinHy * 2, pinHz * 2),
    pinMat,
  );
  pin.position.set(-0.58, BELT_VIS_TOP + pinHy, beltMidZ);
  pin.castShadow = true;
  pin.receiveShadow = true;
  pin.userData.partKind = "pin";
  pin.userData.physicsSpec = { type: "box", hx: pinHx, hy: pinHy, hz: pinHz };
  addGrabbable(pin);
  const bP = new Body({
    mass: partMass,
    material: contactMat,
    linearDamping: partDamp,
    angularDamping: partAng,
  });
  bP.addShape(new Box(new Vec3(pinHx, pinHy, pinHz)));
  bP.position.set(pin.position.x, pin.position.y, pin.position.z);
  world.addBody(bP);
  pin.userData.cannonBody = bP;
}

function doMergeHousingPin(housingMesh, pinMesh) {
  if (!deskPhysics?.world) return;
  const { world, Body, Vec3, Box, contactMat } = deskPhysics;
  const bh = housingMesh.userData.cannonBody;
  const bp = pinMesh.userData.cannonBody;
  if (!bh || !bp) return;

  const mx = (bh.position.x + bp.position.x) * 0.5;
  const my = Math.max(bh.position.y, bp.position.y) + 0.025;
  const mz = (bh.position.z + bp.position.z) * 0.5;

  removeGrabbable(housingMesh);
  removeGrabbable(pinMesh);

  const mat = new THREE.MeshStandardMaterial({
    color: 0x5c6575,
    metalness: 0.48,
    roughness: 0.4,
    emissive: 0x4a3f10,
    emissiveIntensity: 0.15,
  });
  const merged = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.11), mat);
  merged.position.set(mx, my, mz);
  merged.castShadow = true;
  merged.receiveShadow = true;
  merged.userData.partKind = "assembled";
  merged.userData.physicsSpec = { type: "box", hx: 0.055, hy: 0.035, hz: 0.055 };
  addGrabbable(merged);
  const body = new Body({
    mass: 0.62,
    material: contactMat,
    linearDamping: 0.12,
    angularDamping: 0.18,
  });
  body.addShape(new Box(new Vec3(0.055, 0.035, 0.055)));
  body.position.set(mx, my, mz);
  world.addBody(body);
  merged.userData.cannonBody = body;
}

function tryAssemblyMerge() {
  let housing = null;
  let pin = null;
  let assembled = null;
  for (const m of grabbables) {
    if (m.userData.partKind === "housing") housing = m;
    else if (m.userData.partKind === "pin") pin = m;
    else if (m.userData.partKind === "assembled") assembled = m;
  }
  if (!housing || !pin || assembled) return;
  if (housing.userData.heldBy || pin.userData.heldBy) return;
  const bh = housing.userData.cannonBody;
  const bp = pin.userData.cannonBody;
  if (!bh || !bp) return;
  const dx = bh.position.x - bp.position.x;
  const dy = bh.position.y - bp.position.y;
  const dz = bh.position.z - bp.position.z;
  const dxz = Math.hypot(dx, dz);
  const d3 = Math.hypot(dx, dy, dz);
  const vrel = Math.hypot(
    bh.velocity.x - bp.velocity.x,
    bh.velocity.y - bp.velocity.y,
    bh.velocity.z - bp.velocity.z,
  );
  /*
   * Assemblaggio: vicini in pianta (da accoppiare sopra l’alloggio), allineati in altezza.
   * dxz stretto evita merge quando sono solo affiancati sul nastro (grande separazione lungo X).
   */
  if (dxz < 0.068 && Math.abs(dy) < 0.058 && d3 < 0.095 && vrel < 1.15) {
    doMergeHousingPin(housing, pin);
  }
}

function applyConveyorBelt(dt) {
  const target = BELT.vx;
  const yLo = BELT_PHY_CENTER_Y - BELT_PHY_HALF_Y - 0.08;
  const yHi = BELT_VIS_TOP + 0.2;
  for (const m of grabbables) {
    if (!m.userData.partKind || m.userData.heldBy) continue;
    const b = m.userData.cannonBody;
    if (!b) continue;
    const p = b.position;
    if (
      p.x > BELT.x0 - 0.04 &&
      p.x < BELT.x1 + 0.04 &&
      p.z > BELT.z0 - 0.03 &&
      p.z < BELT.z1 + 0.03 &&
      p.y < yHi &&
      p.y > yLo
    ) {
      b.wakeUp();
      /* Stessa velocità lungo X per tutti i pezzi in corsia (nastro “vincolato”). */
      b.velocity.x = target;
      b.velocity.z *= Math.max(0.88, 1 - dt * 6);
      b.velocity.y *= 0.995;
      const wD = Math.max(0.86, 1 - dt * 10);
      b.angularVelocity.x *= wD;
      b.angularVelocity.y *= wD;
      b.angularVelocity.z *= wD;
    }
  }
}

function tryConveyorDispatch() {
  for (const m of grabbables) {
    if (m.userData.partKind !== "assembled" || m.userData.heldBy) continue;
    const b = m.userData.cannonBody;
    if (b && b.position.x > BELT.dispatchX) {
      removeGrabbable(m);
      spawnAssemblyPair();
      break;
    }
  }
}

function resetFactoryScene() {
  if (!deskPhysics?.world) return;
  clearFactoryGrabbables();
  spawnAssemblyPair();
}

/** @type {{ world: import('cannon-es').World; Body: typeof import('cannon-es').Body } | null} */
let deskPhysics = null;
let lastPhysTime = performance.now();

async function initDeskPhysics() {
  let World;
  let Body;
  let Box;
  let Sphere;
  let Cylinder;
  let Vec3;
  let Quaternion;
  let Material;
  let ContactMaterial;
  try {
    const C = await import("cannon-es");
    World = C.World;
    Body = C.Body;
    Box = C.Box;
    Sphere = C.Sphere;
    Cylinder = C.Cylinder;
    Vec3 = C.Vec3;
    Quaternion = C.Quaternion;
    Material = C.Material;
    ContactMaterial = C.ContactMaterial;
  } catch (e) {
    console.warn("cannon-es (fisica tavolo):", e);
    return;
  }

  const world = new World({ gravity: new Vec3(0, -9.82, 0) });
  world.allowSleep = true;
  const mat = new Material("desk");
  const matBelt = new Material("belt");
  world.addContactMaterial(new ContactMaterial(mat, mat, { friction: 0.52, restitution: 0.07 }));
  /* Basso attrito pezzo–nastro: il trasporto è guidato da applyConveyorBelt (nastro statico in Cannon). */
  world.addContactMaterial(new ContactMaterial(mat, matBelt, { friction: 0.08, restitution: 0.05 }));

  const ground = new Body({ mass: 0, material: mat });
  ground.addShape(new Box(new Vec3(24, 0.04, 24)), new Vec3(0, -0.04, 0));
  world.addBody(ground);

  const tableBody = new Body({ mass: 0, material: mat });
  tableBody.addShape(
    new Box(new Vec3(DESK_TOP_W / 2, DESK_TOP_THK / 2, DESK_TOP_D / 2)),
    new Vec3(0, 0, 0),
  );
  tableBody.position.set(DESK_GROUP_X, TABLE_TOP_Y - DESK_TOP_THK * 0.5, DESK_GROUP_Z);
  const qTab = new Quaternion().setFromAxisAngle(new Vec3(0, 1, 0), DESK_ROT_Y);
  tableBody.quaternion.set(qTab.x, qTab.y, qTab.z, qTab.w);
  world.addBody(tableBody);

  const beltHalfX = (BELT.x1 - BELT.x0) * 0.5 + 0.03;
  const beltHalfZ = (BELT.z1 - BELT.z0) * 0.5 + 0.025;
  const beltCx = (BELT.x0 + BELT.x1) * 0.5;
  const beltCz = (BELT.z0 + BELT.z1) * 0.5;
  const beltDeck = new Body({ mass: 0, material: matBelt });
  beltDeck.addShape(new Box(new Vec3(beltHalfX, BELT_PHY_HALF_Y, beltHalfZ)));
  beltDeck.position.set(beltCx, BELT_PHY_CENTER_Y, beltCz);
  world.addBody(beltDeck);

  const railHalfX = beltHalfX + 0.04;
  const railHy = 0.036;
  const railHz = 0.016;
  const railY = BELT_VIS_TOP + railHy * 0.5 - 0.008;
  const rail0 = new Body({ mass: 0, material: matBelt });
  rail0.addShape(new Box(new Vec3(railHalfX, railHy, railHz)));
  rail0.position.set(beltCx, railY, BELT.z0 - 0.026);
  world.addBody(rail0);
  const rail1 = new Body({ mass: 0, material: matBelt });
  rail1.addShape(new Box(new Vec3(railHalfX, railHy, railHz)));
  rail1.position.set(beltCx, railY, BELT.z1 + 0.026);
  world.addBody(rail1);

  deskPhysics = { world, Body, Vec3, Quaternion, Box, Cylinder, Sphere, contactMat: mat };
  spawnAssemblyPair();
  captureDeskPhysicsRestState();
}

void initDeskPhysics();

const robotGroup = new THREE.Group();
scene.add(robotGroup);
let robotMeshes = [];

let passthroughWanted = false;

function applyPassthroughVisuals() {
  const on = passthroughWanted && renderer.xr.isPresenting;
  if (on) {
    roomShell.visible = false;
    scene.background = null;
    scene.fog = null;
    renderer.setClearColor(0x000000, 0);
    robotGroup.visible = false;
  } else {
    roomShell.visible = true;
    scene.background = BG_NORMAL.clone();
    scene.fog = new THREE.Fog(BG_NORMAL.getHex(), 5.5, 38);
    renderer.setClearColor(0x000000, 1);
    robotGroup.visible = true;
  }
}

chkPassthrough?.addEventListener("change", () => {
  passthroughWanted = !!chkPassthrough.checked;
  applyPassthroughVisuals();
});

function meshEntryToGeometry(m) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(m.v);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const idx = Array.isArray(m.i?.[0]) ? m.i.flat() : m.i;
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

async function setupXrInteraction() {
  try {
    const { XRControllerModelFactory } = await import("three/addons/webxr/XRControllerModelFactory.js");
    const { XRHandModelFactory } = await import("three/addons/webxr/XRHandModelFactory.js");
    const controllerModelFactory = new XRControllerModelFactory();
    const handMeshBase = `${window.location.origin}/static/hand-xr/`;
    const handModelFactory = new XRHandModelFactory().setPath(handMeshBase);
    for (let i = 0; i < 2; i++) {
      const xrCtrl = renderer.xr.getController(i);
      scene.add(xrCtrl);
      const grip = renderer.xr.getControllerGrip(i);
      scene.add(grip);
      grip.add(controllerModelFactory.createControllerModel(grip));
      const hand = renderer.xr.getHand(i);
      scene.add(hand);
      hand.add(handModelFactory.createHandModel(hand, "mesh"));
      hand.traverse((o) => {
        if (o.isMesh) {
          o.renderOrder = 10;
          o.frustumCulled = false;
        }
      });
    }
  } catch (e) {
    console.warn("XR modelli (opzionale, richiede rete per three/addons):", e);
  }
}

async function loadRobotMeshes() {
  const url = `${API()}/api/g1_viz_meshes`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const list = data.meshes || [];
    if (!list.length) throw new Error("meshes vuoto (modello non caricato sul server?)");

    for (const m of list) {
      const g = meshEntryToGeometry(m);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x8a9eb8,
        metalness: 0.38,
        roughness: 0.42,
        emissive: 0x1c2838,
        emissiveIntensity: 0.12,
        envMapIntensity: 0,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrix.identity();
      robotGroup.add(mesh);
      robotMeshes.push(mesh);
    }
    return true;
  } catch (e) {
    console.warn("g1_viz_meshes", e);
    setStatus(`ERRORE mesh robot: ${e.message || e}. Apri solo da ${API()}/ (non file://).`);
    return false;
  }
}

async function syncRobotPoseFromRest() {
  try {
    const r = await fetch(`${API()}/api/sim_state`);
    const data = await r.json();
    if (data.sim?.geom_mat4) applyRobotMatrices(data.sim.geom_mat4);
  } catch (e) {
    console.warn("sim_state", e);
  }
}

function applyRobotMatrices(geomMat4List) {
  if (!geomMat4List?.length || !robotMeshes.length) return;
  const n = Math.min(geomMat4List.length, robotMeshes.length);
  for (let i = 0; i < n; i++) {
    robotMeshes[i].matrix.fromArray(geomMat4List[i]);
    robotMeshes[i].updateMatrixWorld(true);
  }
}

function handSide(src) {
  if (src.handedness === "left") return "left";
  if (src.handedness === "right") return "right";
  return null;
}

function readWristQuaternion(frame, refSpace, side, out) {
  const session = frame.session;
  for (const src of session.inputSources) {
    if (handSide(src) !== side || !src.hand) continue;
    const wrist = src.hand.get("wrist");
    if (!wrist) continue;
    const pose = frame.getJointPose(wrist, refSpace);
    const o = pose?.transform?.orientation;
    if (!o) continue;
    out.set(o.x, o.y, o.z, o.w);
    return true;
  }
  return false;
}

/** ω approssimata (world) da due quaternioni consecutivi, dt in secondi. */
function quatDeltaToAngVel(qPrev, qCurr, dt, outVec3) {
  if (dt < 1e-4) {
    outVec3.set(0, 0, 0);
    return;
  }
  _qAngPrevInv.copy(qPrev).invert();
  _qAngDel.multiplyQuaternions(qCurr, _qAngPrevInv);
  let w = _qAngDel.w;
  let x = _qAngDel.x;
  let y = _qAngDel.y;
  let z = _qAngDel.z;
  if (w < 0) {
    w = -w;
    x = -x;
    y = -y;
    z = -z;
  }
  const s = Math.max(1e-8, w);
  const k = (2 / s) / dt;
  outVec3.set(x * k, y * k, z * k);
}

function syncHeldBody(mesh, mid, quat) {
  const b = mesh.userData.cannonBody;
  if (!b || !deskPhysics) return;
  b.velocity.set(0, 0, 0);
  b.angularVelocity.set(0, 0, 0);
  b.type = deskPhysics.Body.KINEMATIC;
  b.position.set(mid.x, mid.y, mid.z);
  if (quat) b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
}

/** @param {THREE.Vector3 | null} throwVel world-space m/s; @param {THREE.Vector3 | null} throwAngVel rad/s */
function releaseBody(mesh, throwVel = null, throwAngVel = null) {
  const b = mesh.userData.cannonBody;
  if (!b || !deskPhysics) return;
  b.type = deskPhysics.Body.DYNAMIC;
  if (throwVel) {
    const maxV = 7;
    const vx = throwVel.x;
    const vy = throwVel.y;
    const vz = throwVel.z;
    const sp = Math.hypot(vx, vy, vz);
    const s = sp > maxV ? maxV / sp : 1;
    b.velocity.set(vx * s, vy * s, vz * s);
  } else {
    b.velocity.set(0, 0, 0);
  }
  if (throwAngVel) {
    const maxW = 22;
    const wx = throwAngVel.x;
    const wy = throwAngVel.y;
    const wz = throwAngVel.z;
    const sp = Math.hypot(wx, wy, wz);
    const s = sp > maxW ? maxW / sp : 1;
    b.angularVelocity.set(wx * s, wy * s, wz * s);
  } else {
    b.angularVelocity.set(0, 0, 0);
  }
  b.wakeUp();
}

function resetGrabTracking(st) {
  st.prevGrabT = 0;
  st.grabVel.set(0, 0, 0);
  st.prevWristT = 0;
  st.grabAngVel.set(0, 0, 0);
}

function updatePinchGrab(frame, refSpace) {
  if (!frame || !refSpace) return;
  const session = frame.session;
  const PINCH = 0.048;
  const GRAB_R = 0.13;

  for (const side of ["left", "right"]) {
    const st = pinchState[side];
    if (!st.mesh) continue;
    let stillPinch = false;
    for (const src of session.inputSources) {
      if (handSide(src) !== side || !src.hand) continue;
      const thumb = src.hand.get("thumb-tip");
      const index = src.hand.get("index-finger-tip");
      if (!thumb || !index) continue;
      const pt = frame.getJointPose(thumb, refSpace);
      const pi = frame.getJointPose(index, refSpace);
      if (!pt?.transform?.position || !pi?.transform?.position) continue;
      _vThumb.set(pt.transform.position.x, pt.transform.position.y, pt.transform.position.z);
      _vIndex.set(pi.transform.position.x, pi.transform.position.y, pi.transform.position.z);
      if (_vThumb.distanceTo(_vIndex) >= PINCH) continue;
      stillPinch = true;
      _vMid.copy(_vThumb).add(_vIndex).multiplyScalar(0.5);
      const now = performance.now();
      if (st.prevGrabT > 0) {
        const dt = (now - st.prevGrabT) / 1000;
        if (dt > 1e-4 && dt < 0.12) {
          _vGrabDelta.copy(_vMid).sub(st.prevGrabMid).divideScalar(dt);
          st.grabVel.lerp(_vGrabDelta, 0.55);
        }
      }
      st.prevGrabMid.copy(_vMid);
      st.prevGrabT = now;
      break;
    }
    if (stillPinch) {
      st.mesh.position.copy(_vMid);
      if (readWristQuaternion(frame, refSpace, side, st.wristQuat)) {
        st.mesh.quaternion.copy(st.wristQuat).multiply(st.grabQuatOff);
        const nowW = performance.now();
        if (st.prevWristT > 0) {
          const dtW = (nowW - st.prevWristT) / 1000;
          if (dtW > 1e-4 && dtW < 0.12) {
            quatDeltaToAngVel(st.prevWristQuat, st.wristQuat, dtW, _vAngDelta);
            st.grabAngVel.lerp(_vAngDelta, 0.5);
          }
        }
        st.prevWristQuat.copy(st.wristQuat);
        st.prevWristT = nowW;
      }
      syncHeldBody(st.mesh, _vMid, st.mesh.quaternion);
    }
    if (!stillPinch) {
      releaseBody(st.mesh, st.grabVel, st.grabAngVel);
      resetGrabTracking(st);
      st.mesh.userData.heldBy = null;
      st.mesh = null;
    }
  }

  for (const src of session.inputSources) {
    const side = handSide(src);
    if (!side || !src.hand) continue;
    if (pinchState[side].mesh) continue;
    const thumb = src.hand.get("thumb-tip");
    const index = src.hand.get("index-finger-tip");
    if (!thumb || !index) continue;
    const pt = frame.getJointPose(thumb, refSpace);
    const pi = frame.getJointPose(index, refSpace);
    if (!pt?.transform?.position || !pi?.transform?.position) continue;
    _vThumb.set(pt.transform.position.x, pt.transform.position.y, pt.transform.position.z);
    _vIndex.set(pi.transform.position.x, pi.transform.position.y, pi.transform.position.z);
    if (_vThumb.distanceTo(_vIndex) >= PINCH) continue;
    _vMid.copy(_vThumb).add(_vIndex).multiplyScalar(0.5);
    let best = null;
    let bestD = GRAB_R;
    for (const obj of grabbables) {
      if (obj.userData.heldBy && obj.userData.heldBy !== side) continue;
      obj.getWorldPosition(_vGrabWorld);
      const d = _vMid.distanceTo(_vGrabWorld);
      if (d < bestD) {
        bestD = d;
        best = obj;
      }
    }
    if (best) {
      best.userData.heldBy = side;
      const st = pinchState[side];
      resetGrabTracking(st);
      st.mesh = best;
      best.position.copy(_vMid);
      st.prevGrabMid.copy(_vMid);
      st.prevGrabT = performance.now();
      if (readWristQuaternion(frame, refSpace, side, st.wristQuat)) {
        st.grabQuatOff.copy(st.wristQuat).invert().multiply(best.quaternion);
        st.prevWristQuat.copy(st.wristQuat);
        st.prevWristT = performance.now();
        best.quaternion.copy(st.wristQuat).multiply(st.grabQuatOff);
      } else {
        st.grabQuatOff.identity();
      }
      syncHeldBody(best, _vMid, best.quaternion);
    }
  }
}

function stepDeskPhysics(timeMs) {
  if (!deskPhysics?.world) return;
  const dt = Math.min(0.05, (timeMs - lastPhysTime) / 1000);
  lastPhysTime = timeMs;
  applyConveyorBelt(dt);
  deskPhysics.world.step(1 / 60, dt, 5);
  applyConveyorBelt(dt);
  tryAssemblyMerge();
  tryConveyorDispatch();
  for (const m of grabbables) {
    if (m.userData.heldBy) continue;
    const b = m.userData.cannonBody;
    if (!b) continue;
    m.position.set(b.position.x, b.position.y, b.position.z);
    m.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  }
}

async function boot() {
  const ok = await loadRobotMeshes();
  if (!ok) return;
  if (robotMeshes.length) await syncRobotPoseFromRest();

  let line = `mesh G1: ${robotMeshes.length} | Linea: alloggio grigio + tassello oro → avvicina sopra l’alloggio (si assembla) → nastro (→)`;
  try {
    const sec = window.isSecureContext ? "contesto sicuro: sì" : "contesto sicuro: no";
    const xr = await Promise.race([
      probeXr(),
      new Promise((resolve) => setTimeout(() => resolve("WebXR: timeout"), 2500)),
    ]);
    line = `${sec} | ${xr} | ${line}`;
  } catch (_) {
    /* ignore */
  }
  setStatus(line);
  await setupXrInteraction();
}

void boot();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function readStick(gp) {
  if (!gp?.axes?.length) return [0, 0];
  let x = gp.axes[0] || 0;
  let y = gp.axes[1] || 0;
  if (Math.hypot(x, y) < 0.05 && gp.axes.length >= 4) {
    x = gp.axes[2] || 0;
    y = gp.axes[3] || 0;
  }
  return [x, y];
}

function trig(gp) {
  const v = gp?.buttons?.[0]?.value;
  return typeof v === "number" ? v : 0;
}

function readPads(frame) {
  const out = { lx: 0, ly: 0, rx: 0, ry: 0, left_trig: 0, right_trig: 0 };
  const session = frame?.session ?? renderer.xr.getSession();
  if (!session) return out;
  const src = [...session.inputSources].filter((s) => s.gamepad);
  let L = src.find((s) => s.handedness === "left");
  let R = src.find((s) => s.handedness === "right");
  if (!L && !R && src.length >= 2) {
    L = src[0];
    R = src[1];
  } else {
    if (!L && src.length) L = src[0];
    if (!R && src.length > 1) R = src.find((s) => s !== L) || src[1];
  }
  if (L?.gamepad) {
    [out.lx, out.ly] = readStick(L.gamepad);
    out.left_trig = trig(L.gamepad);
  }
  if (R?.gamepad) {
    [out.rx, out.ry] = readStick(R.gamepad);
    out.right_trig = trig(R.gamepad);
  }
  return out;
}

function _mjFromXrTransform(t) {
  if (!t?.position) return null;
  return xrPosToMj(t.position);
}

function readHands(frame, refSpace) {
  const out = {};
  if (!frame || !refSpace) return out;
  const session = frame.session;
  if (!session) return out;
  for (const src of session.inputSources) {
    let mj = null;
    if (src.hand) {
      const wrist = src.hand.get("wrist");
      if (wrist) {
        const jp = frame.getJointPose?.(wrist, refSpace);
        mj = _mjFromXrTransform(jp?.transform);
      }
    }
    if (!mj && src.gripSpace) {
      const gp = frame.getPose(src.gripSpace, refSpace);
      mj = _mjFromXrTransform(gp?.transform);
    }
    if (!mj) continue;
    if (src.handedness === "left") out.left = mj;
    else if (src.handedness === "right") out.right = mj;
    else if (!out.left) out.left = mj;
    else if (!out.right) out.right = mj;
  }
  return out;
}

function localSecureEnough() {
  if (window.isSecureContext) return true;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

async function probeXr() {
  if (!("xr" in navigator)) return "WebXR non disponibile in questo browser";
  try {
    const vr = await navigator.xr.isSessionSupported("immersive-vr");
    let ar = false;
    try {
      ar = await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
      ar = false;
    }
    const vrS = vr ? "sì" : "no (usa Quest Browser o collega visore)";
    const arS = ar ? "sì" : "no";
    return `immersive-vr: ${vrS} | immersive-ar: ${arS}`;
  } catch (e) {
    return `WebXR: ${e.message || e}`;
  }
}

async function enterVr() {
  if (renderer.xr.isPresenting) {
    const s = renderer.xr.getSession();
    if (s) await s.end();
    return;
  }
  if (!("xr" in navigator)) {
    setStatus("Nessun WebXR — sul Quest usa il browser Meta (Internet)");
    return;
  }
  if (!localSecureEnough()) {
    setStatus("Serve https:// (es. https://127.0.0.1:8443/ o https://IP-PC:8443/) — non http://IP");
    return;
  }
  passthroughWanted = !!chkPassthrough?.checked;
  let arSupported = false;
  if (passthroughWanted && navigator.xr?.isSessionSupported) {
    try {
      arSupported = await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
      arSupported = false;
    }
  }

  const vrTries = [
    { ref: "local-floor", init: { optionalFeatures: ["local-floor", "hand-tracking", "layers"] } },
    { ref: "local-floor", init: { optionalFeatures: ["local-floor", "hand-tracking"] } },
    { ref: "local", init: { optionalFeatures: ["hand-tracking", "local-floor"] } },
    { ref: "local", init: { optionalFeatures: ["hand-tracking"] } },
    { ref: "local-floor", init: { optionalFeatures: ["local-floor"] } },
    { ref: "local", init: { optionalFeatures: ["local-floor", "bounded-floor"] } },
    { ref: "local", init: {} },
  ];
  const arTries = [
    { ref: "local-floor", init: { optionalFeatures: ["local-floor", "hand-tracking"] } },
    { ref: "local-floor", init: { optionalFeatures: ["local-floor"] } },
    { ref: "local", init: { optionalFeatures: ["hand-tracking", "local-floor"] } },
    { ref: "local", init: { optionalFeatures: ["hand-tracking"] } },
    { ref: "local", init: {} },
  ];

  /** @type {{ mode: string; ref: string; init: XRSessionInit }[]} */
  const tries = [];
  if (arSupported) for (const t of arTries) tries.push({ mode: "immersive-ar", ...t });
  for (const t of vrTries) tries.push({ mode: "immersive-vr", ...t });

  let last = null;
  for (const { mode, ref, init } of tries) {
    renderer.xr.setReferenceSpaceType(ref);
    try {
      const session = await navigator.xr.requestSession(mode, init);
      await renderer.xr.setSession(session);
      const feats = session.enabledFeatures?.join?.(", ") ?? "";
      const blend = session.environmentBlendMode ?? "?";
      const modeLine =
        mode === "immersive-ar"
          ? "Sessione AR (camera mista / passthrough)"
          : "Sessione VR";
      const ht = feats.includes("hand-tracking")
        ? "Hand tracking OK — avvicina pollice e indice (pinch) per prendere gli oggetti sul tavolo."
        : "Senza hand tracking: usa il Quest con tracking mani attivo per afferrare.";
      const line = `${modeLine}\n${ht}\nblend: ${blend}${feats ? ` | ${feats}` : ""}`;
      queueMicrotask(() => {
        setStatus(line.replace(/\n/g, " | "));
        if (xrFoot) {
          xrFoot.textContent = line;
          xrFoot.classList.add("on");
        }
      });
      return;
    } catch (e) {
      last = e;
    }
  }
  setStatus(last ? String(last.message || last) : "VR non avviata");
}

btnVr?.addEventListener("click", () => {
  enterVr().catch((e) => setStatus(String(e.message || e)));
});

renderer.xr.addEventListener("sessionstart", () => {
  hud?.classList.add("vr-hidden");
  if (btnVr) btnVr.textContent = "Esci VR";
  passthroughWanted = !!chkPassthrough?.checked;
  applyPassthroughVisuals();
  queueMicrotask(() => {
    try {
      restoreDeskXRLayoutToDefaults();
      xrRefSpaceResetCleanup?.();
      const rs = renderer.xr.getReferenceSpace();
      if (!rs?.addEventListener) return;
      const onReset = () => restoreDeskXRLayoutToDefaults();
      rs.addEventListener("reset", onReset);
      xrRefSpaceResetCleanup = () => {
        rs.removeEventListener("reset", onReset);
        xrRefSpaceResetCleanup = null;
      };
    } catch (_) {
      /* ignore */
    }
  });
});
renderer.xr.addEventListener("sessionend", () => {
  xrRefSpaceResetCleanup?.();
  hud?.classList.remove("vr-hidden");
  if (xrFoot) {
    xrFoot.textContent = "";
    xrFoot.classList.remove("on");
  }
  if (btnVr) btnVr.textContent = "VR";
  pinchState.left.mesh = pinchState.right.mesh = null;
  resetGrabTracking(pinchState.left);
  resetGrabTracking(pinchState.right);
  for (const o of grabbables) {
    o.userData.heldBy = null;
    releaseBody(o, null, null);
  }
  roomShell.visible = true;
  scene.background = BG_NORMAL.clone();
  scene.fog = new THREE.Fog(BG_NORMAL.getHex(), 5.5, 38);
  renderer.setClearColor(0x000000, 1);
  robotGroup.visible = true;
  sendInput(
    { lx: 0, ly: 0, rx: 0, ry: 0, left_trig: 0, right_trig: 0 },
    { left: null, right: null },
  );
});

const keys = {};
window.addEventListener("keydown", (e) => {
  keys[e.code] = true;
});
window.addEventListener("keyup", (e) => {
  keys[e.code] = false;
});

function animate(time, frame) {
  if (renderer.xr.isPresenting) {
    const refSpace = renderer.xr.getReferenceSpace();
    const ax = readPads(frame);
    const hands = readHands(frame, refSpace);
    const hk = Object.keys(hands);
    sendInput(ax, hk.length ? hands : undefined);
    updatePinchGrab(frame, refSpace);
  }
  const t = typeof time === "number" && time > 0 ? time : performance.now();
  const dtAnim = Math.min(0.05, (t - lastAnimTime) / 1000);
  lastAnimTime = t;
  if (beltScrollTexture) beltScrollTexture.offset.x -= dtAnim * 0.38;
  stepDeskPhysics(t);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

setInterval(() => {
  if (renderer.xr.isPresenting) return;
  let lx = 0,
    ly = 0,
    rx = 0;
  if (keys.KeyA) lx -= 1;
  if (keys.KeyD) lx += 1;
  if (keys.KeyW) ly += 1;
  if (keys.KeyS) ly -= 1;
  if (keys.KeyQ) rx -= 1;
  if (keys.KeyE) rx += 1;
  if (lx || ly || rx) {
    sendInput({ lx, ly, rx, ry: 0, left_trig: 0, right_trig: 0 });
  }
}, 40);
