import * as THREE from "three";

const hud = document.getElementById("hud");
const statusEl = document.getElementById("status");
const btnVr = document.getElementById("btn-vr");
const xrFoot = document.getElementById("xr-foot");
const vrTools = document.getElementById("vr-tools");
const chkPassthrough = document.getElementById("chk-passthrough");

const API = () => `${location.origin}`;

const BG_NORMAL = new THREE.Color(0x0a0f18);

let ws = null;

/** WebXR Y-up -> MuJoCo z-up (inverso della mappa posizioni usata dal server per le mesh). */
function xrPosToMj(p) {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  return [x, -z, y];
}

function connectWs() {
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsProto}//${location.host}/ws`;
  if (ws) {
    ws.close();
    ws = null;
  }
  ws = new WebSocket(url);
  ws.onopen = () => {
    const cur = statusEl?.textContent || "";
    const tag = `WS OK (${location.protocol}//${location.host})`;
    setStatus(cur.includes(tag) ? cur : `${cur} | ${tag}`.replace(/^\s*\|\s*/, ""));
  };
  ws.onclose = () => setStatus("WS disconnesso — controlla server.py e usa https://…:8443/");
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
  if (hands !== undefined) o.hands = hands;
  ws.send(JSON.stringify(o));
}

const scene = new THREE.Scene();
scene.background = BG_NORMAL.clone();

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
renderer.toneMappingExposure = 1.15;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
scene.add(new THREE.HemisphereLight(0xc8d4e8, 0x1a1f2e, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(4, 12, 6);
scene.add(sun);

const gridHelper = new THREE.GridHelper(24, 48, 0x5a6b8c, 0x2a3548);
scene.add(gridHelper);

/** Tavolo davanti all'origine (local-floor: -Z = avanti). */
const deskGroup = new THREE.Group();
deskGroup.position.set(0, 0, 0);
scene.add(deskGroup);

const TABLE_Z = -0.72;
const TABLE_TOP_Y = 0.82;
const tableTop = new THREE.Mesh(
  new THREE.BoxGeometry(1.35, 0.045, 0.88),
  new THREE.MeshStandardMaterial({
    color: 0x5c4033,
    roughness: 0.88,
    metalness: 0.05,
  }),
);
tableTop.position.set(0, TABLE_TOP_Y - 0.0225, TABLE_Z);
tableTop.receiveShadow = true;
deskGroup.add(tableTop);

const deskLight = new THREE.PointLight(0xfff4e6, 14, 4.5, 1.2);
deskLight.position.set(0, TABLE_TOP_Y + 0.55, TABLE_Z);
deskGroup.add(deskLight);

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
const _vAngDelta = new THREE.Vector3();
const _qAngDel = new THREE.Quaternion();
const _qAngPrevInv = new THREE.Quaternion();

/** @type {null | (() => void)} */
let xrRefSpaceResetCleanup = null;

/** Stato iniziale dei corpi cannon (stesso ordine di world.bodies) dopo initDeskPhysics. */
let deskPhysicsRestSnapshot = [];

function captureDeskPhysicsRestState() {
  if (!deskPhysics?.world?.bodies) return;
  deskPhysicsRestSnapshot = deskPhysics.world.bodies.map((b) => ({
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
  deskGroup.position.set(0, 0, 0);
  deskGroup.quaternion.set(0, 0, 0, 1);
  deskGroup.scale.set(1, 1, 1);
  deskGroup.updateMatrixWorld(true);

  pinchState.left.mesh = pinchState.right.mesh = null;
  resetGrabTracking(pinchState.left);
  resetGrabTracking(pinchState.right);
  for (const o of grabbables) {
    o.userData.heldBy = null;
    releaseBody(o, null, null);
  }

  if (!deskPhysics?.world?.bodies?.length || deskPhysicsRestSnapshot.length !== deskPhysics.world.bodies.length) {
    return;
  }
  const bodies = deskPhysics.world.bodies;
  for (let i = 0; i < bodies.length; i++) {
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
  deskGroup.add(mesh);
}

/** physicsSpec: forma per cannon-es (vedi initDeskPhysics). */
function makeProp(geom, color, x, y, z, physicsSpec) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.25,
    roughness: 0.35,
  });
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.userData.physicsSpec = physicsSpec;
  addGrabbable(m);
  return m;
}

makeProp(new THREE.SphereGeometry(0.055, 28, 20), 0xf97316, -0.32, TABLE_TOP_Y + 0.055, TABLE_Z + 0.06, {
  type: "sphere",
  radius: 0.055,
});
makeProp(new THREE.BoxGeometry(0.11, 0.11, 0.11), 0x22d3ee, 0.02, TABLE_TOP_Y + 0.055, TABLE_Z - 0.04, {
  type: "box",
  hx: 0.055,
  hy: 0.055,
  hz: 0.055,
});
makeProp(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 24), 0xeab308, 0.32, TABLE_TOP_Y + 0.06, TABLE_Z + 0.05, {
  type: "cylinder",
  r: 0.045,
  h: 0.12,
});
makeProp(new THREE.TorusGeometry(0.055, 0.018, 12, 28), 0xd946ef, -0.08, TABLE_TOP_Y + 0.055, TABLE_Z - 0.12, {
  type: "box",
  hx: 0.075,
  hy: 0.04,
  hz: 0.075,
});

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
  world.addContactMaterial(new ContactMaterial(mat, mat, { friction: 0.52, restitution: 0.07 }));

  const ground = new Body({ mass: 0, material: mat });
  ground.addShape(new Box(new Vec3(24, 0.04, 24)), new Vec3(0, -0.04, 0));
  world.addBody(ground);

  const tableBody = new Body({ mass: 0, material: mat });
  tableBody.addShape(
    new Box(new Vec3(1.35 / 2, 0.045 / 2, 0.88 / 2)),
    new Vec3(0, TABLE_TOP_Y - 0.0225, TABLE_Z),
  );
  world.addBody(tableBody);

  for (const mesh of grabbables) {
    const spec = mesh.userData.physicsSpec;
    if (!spec) continue;
    const body = new Body({
      mass: 0.38,
      material: mat,
      linearDamping: 0.12,
      angularDamping: 0.18,
    });
    if (spec.type === "sphere") {
      body.addShape(new Sphere(spec.radius));
    } else if (spec.type === "box") {
      body.addShape(new Box(new Vec3(spec.hx, spec.hy, spec.hz)));
    } else if (spec.type === "cylinder") {
      const q = new Quaternion().setFromAxisAngle(new Vec3(1, 0, 0), Math.PI / 2);
      body.addShape(new Cylinder(spec.r, spec.r, spec.h, 10), new Vec3(0, 0, 0), q);
    } else continue;
    body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
    body.quaternion.set(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
    world.addBody(body);
    mesh.userData.cannonBody = body;
  }

  deskPhysics = { world, Body };
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
    gridHelper.visible = false;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    robotGroup.visible = false;
  } else {
    gridHelper.visible = true;
    scene.background = BG_NORMAL.clone();
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
      const mat = new THREE.MeshPhongMaterial({
        color: 0x94a3b8,
        emissive: 0x2a3444,
        emissiveIntensity: 0.4,
        shininess: 28,
        specular: 0x666666,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
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
      const d = _vMid.distanceTo(obj.position);
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
  deskPhysics.world.step(1 / 60, dt, 5);
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

  let line = `mesh G1: ${robotMeshes.length}`;
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
  gridHelper.visible = true;
  scene.background = BG_NORMAL.clone();
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
