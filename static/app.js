import * as THREE from "three";
import { runPhase, bootQueryFlag } from "./loadPipeline.js";

const hud = document.getElementById("hud");
const statusEl = document.getElementById("status");
const btnVr = document.getElementById("btn-vr");
const xrFoot = document.getElementById("xr-foot");
const vrTools = document.getElementById("vr-tools");
const chkPassthrough = document.getElementById("chk-passthrough");

/** Ultima sessione XR riuscita: mode + blend (diagnosi immersive-ar vs vr / lente nera). */
let lastXrSessionReport = "— (non ancora in XR)";

/** Ripristino tone mapping dopo XR (mitigazione lente nera / occhio destro su alcuni Quest). */
let _xrToneRestore = null;

const modePanel = document.getElementById("mode-panel");
const btnRealtime = document.getElementById("btn-realtime");
const btnRecord = document.getElementById("btn-record");
const btnStop = document.getElementById("btn-stop");
const btnPlayback = document.getElementById("btn-playback");
const selRecording = document.getElementById("sel-recording");
const btnDeleteRec = document.getElementById("btn-delete-rec");
const chkLoop = document.getElementById("chk-loop");
const modeStatus = document.getElementById("mode-status");
const opsSummaryEl = document.getElementById("ops-summary");
const opsBody = document.getElementById("ops-body");
const opsToggle = document.getElementById("ops-toggle");
const btnOpsRefresh = document.getElementById("btn-ops-refresh");
const btnSceneDefault = document.getElementById("btn-scene-default");
const btnSceneIndustrial = document.getElementById("btn-scene-industrial");
const inpAdminToken = document.getElementById("inp-admin-token");
const opsReloadHint = document.getElementById("ops-reload-hint");
const opsTokenWrap = document.getElementById("ops-token-wrap");
const selScene = document.getElementById("sel-scene");
const btnSceneLoad = document.getElementById("btn-scene-load");
const hudStrip = document.getElementById("hud-strip");
const hudDiag = document.getElementById("hud-diag");
const renderErrorBanner = document.getElementById("render-error-banner");
const inpG1OffX = document.getElementById("inp-g1-off-x");
const inpG1OffY = document.getElementById("inp-g1-off-y");
const inpG1OffZ = document.getElementById("inp-g1-off-z");
const inpG1OffYaw = document.getElementById("inp-g1-off-yaw");
const elG1OffXVal = document.getElementById("g1-off-x-val");
const elG1OffYVal = document.getElementById("g1-off-y-val");
const elG1OffZVal = document.getElementById("g1-off-z-val");
const elG1OffYawVal = document.getElementById("g1-off-yaw-val");
const btnG1OffApply = document.getElementById("btn-g1-off-apply");
const btnG1OffReset = document.getElementById("btn-g1-off-reset");
const chkHandFollowPelvis = document.getElementById("chk-hand-follow-pelvis");

const API = () => `${location.origin}`;

/** Ultimo conteggio mesh G1 lato client (per fascia stato). */
let _lastClientMeshCount = 0;
let _lastMeshOk = false;
/** Su Quest, con mesh caricate: niente stick manikin di default (?stick=1 per attivarlo). */
let _questPreferNoStick = false;
/** True se il server espone ADMIN_TOKEN e richiede header per reload_scene. */
let _reloadRequiresToken = false;

function mergeUrlParam(key, val) {
  const u = new URL(location.href);
  if (val == null || val === "") u.searchParams.delete(key);
  else u.searchParams.set(key, String(val));
  location.href = u.toString();
}

function refreshSetupPanel() {
  /* Pannello setup testuale rimosso: solo barra pulsanti in index.html. */
}

/** Dopo boot mesh: allinea stato con /api/health (viz_geom, base FREE, realtime). */
async function applyBootHealthHints(loadedMeshCount, meshOk, liteMode) {
  if (liteMode) {
    setStatus("Lite · no mesh G1 · rimuovi ?lite=1 dall’URL (pulsante Clr) o F5 dopo edit manuale");
    setHudDiag("Modalità Lite: teleop attivo, robot non disegnato. Se era comparso dopo un errore GPU, evita il vecchio reload automatico a lite.");
    return;
  }
  try {
    const r = await fetchWithTimeout(`${API()}/api/health`, { method: "GET", cache: "no-store" }, 8000);
    const j = await r.json();
    if (!j.ok) return;
    const vg = j.viz_geom_count ?? 0;
    const baseOk = j.free_base_ok !== false;
    const parts = [];
    if (!meshOk || loadedMeshCount === 0) {
      if (vg === 0) parts.push("server: 0 geom mesh (gruppo 2) — MJCF?");
      else parts.push("mesh client assenti — ?meshmode=piece o rete");
    }
    if (!baseOk) parts.push("no base FREE — WASD/stick base spenti");
    if (j.mode && j.mode !== "realtime") parts.push(`server mode=${j.mode} → Realtime`);
    if (!parts.length) return;
    const cur = statusEl?.textContent || "";
    setStatus(`${cur} | ${parts.join(" · ")}`);
  } catch (_) {}
}

async function refreshOpsPanel() {
  if (!opsSummaryEl) return;
  try {
    const r = await fetchWithTimeout(`${API()}/api/health`, { method: "GET", cache: "no-store" }, 12000);
    const j = await r.json();
    if (!j.ok) throw new Error("health not ok");
    const lab = j.scene_label || "?";
    const reloadOn = j.reload_api_enabled !== false;
    _reloadRequiresToken = !!j.reload_requires_admin_token;
    const bodies = j.mujoco_bodies_count != null ? `${j.mujoco_bodies_count}b` : "";
    const vg = j.viz_geom_count != null ? `${j.viz_geom_count}v` : "";
    const reloadTag = _reloadRequiresToken ? "reload·🔒" : "reload·✓";
    let warn = "";
    if (j.free_base_ok === false) {
      warn = ` <span class="warn" title="Base libera assente nel MJCF — stick non muovono il robot.">!</span>`;
    }
    if (j.viz_geom_count === 0 && j.model_loaded) {
      warn += ` <span class="warn" title="Nessun geom mesh gruppo 2 nel MJCF — G1 viewer vuoto">⚠</span>`;
    }
    opsSummaryEl.innerHTML = `<span class="tag">${lab}</span> <strong>${j.mode || "?"}</strong> ${bodies}${vg ? ` ${vg}` : ""} <span style="opacity:.75">${reloadTag}</span>${warn}`;
    if (chkHandFollowPelvis) chkHandFollowPelvis.checked = !!j.hand_follow_pelvis;
    if (btnSceneDefault) btnSceneDefault.disabled = !reloadOn;
    if (btnSceneIndustrial) btnSceneIndustrial.disabled = !reloadOn;
    if (inpAdminToken) inpAdminToken.disabled = !_reloadRequiresToken;
    if (btnSceneLoad) btnSceneLoad.disabled = !reloadOn;
    if (selScene) selScene.disabled = !reloadOn;
    if (opsTokenWrap) opsTokenWrap.classList.toggle("hidden", !_reloadRequiresToken);
    if (opsReloadHint) {
      opsReloadHint.classList.remove("mode-open", "mode-lock");
      if (_reloadRequiresToken) {
        opsReloadHint.classList.add("mode-lock");
        opsReloadHint.textContent =
          "Cambio scena protetto: il server chiede il token — incollalo nel campo sotto (stesso valore di ADMIN_TOKEN sul PC).";
      } else {
        opsReloadHint.classList.add("mode-open");
        opsReloadHint.textContent =
          "Cambio scena libero: nessun token — Applica / Def / Ind. funzionano subito. (Su LAN esposta: imposta ADMIN_TOKEN sul server per bloccare.)";
      }
    }
    const lite = bootLiteMeshes() ? "lite=1" : "mesh ok";
    const meshPart = _lastMeshOk ? `mesh×${_lastClientMeshCount}` : "mesh assenti";
    setHudStrip(`Viewer: ${meshPart} · ${lite} · scena ${lab}`);
    await refreshScenesSelect();
    try {
      if (selScene) {
        const sp = String(j.scene_path || j.scene || "");
        const base = sp.split(/[/\\]/).pop()?.replace(/\.xml$/i, "") || "";
        const keysNow = new Set([...selScene.options].map((o) => o.value));
        if (lab === "default" && keysNow.has("default")) selScene.value = "default";
        else if (lab === "industrial_light" && keysNow.has("industrial_light")) selScene.value = "industrial_light";
        else if (base && keysNow.has(base)) selScene.value = base;
      }
    } catch (_) {}
    try {
      const pathTip = String(j.scene_path || j.scene || "").slice(0, 180);
      if (opsSummaryEl && pathTip) opsSummaryEl.title = pathTip;
    } catch (_) {}
  } catch (e) {
    opsSummaryEl.innerHTML = `<span style="color:#f87171">× ${String(e.message || e)}</span>`;
    try {
      opsSummaryEl.removeAttribute("title");
    } catch (_) {}
    if (btnSceneDefault) btnSceneDefault.disabled = true;
    if (btnSceneIndustrial) btnSceneIndustrial.disabled = true;
    if (btnSceneLoad) btnSceneLoad.disabled = true;
    if (selScene) selScene.disabled = true;
    if (inpAdminToken) inpAdminToken.disabled = true;
    if (opsTokenWrap) opsTokenWrap.classList.remove("hidden");
    if (opsReloadHint) {
      opsReloadHint.classList.remove("mode-open", "mode-lock");
      opsReloadHint.textContent = "Stato server non disponibile — riprova con ↻";
    }
  }
}

async function refreshScenesSelect() {
  if (!selScene) return;
  const prev = selScene.value;
  try {
    const r = await fetchWithTimeout(`${API()}/api/scenes`, { method: "GET", cache: "no-store" }, 12000);
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.scenes)) return;
    selScene.innerHTML = "";
    for (const s of j.scenes) {
      const opt = document.createElement("option");
      opt.value = String(s.id || "");
      opt.textContent = s.builtin ? String(s.label || s.id) : String(s.label || s.id);
      selScene.appendChild(opt);
    }
    const keys = new Set([...selScene.options].map((o) => o.value));
    if (prev && keys.has(prev)) selScene.value = prev;
  } catch (_) {}
}

async function postReloadScene(sceneKey) {
  const tok = inpAdminToken?.value?.trim() || "";
  if (_reloadRequiresToken && !tok) {
    setStatus("Serve il token nel pannello Scena (ADMIN_TOKEN attivo sul server)");
    return;
  }
  const headers = { "Content-Type": "application/json" };
  if (tok) headers["X-Admin-Token"] = tok;
  try {
    const r = await fetchWithTimeout(
      `${API()}/api/sim/reload_scene`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ scene: sceneKey }),
      },
      60000,
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(`Reload: ${j.error || r.status}`);
      return;
    }
    setStatus(`OK · ${j.scene_label || sceneKey}`);
    const meshOk = await loadRobotMeshes();
    if (meshOk) await syncRobotPoseFromRest();
    const nMesh = robotMeshes.filter(Boolean).length;
    _lastClientMeshCount = nMesh;
    _lastMeshOk = meshOk;
    setStatus(meshOk ? `OK · ${j.scene_label || sceneKey} · G1×${nMesh}` : `OK scena · G1×0 (api mesh?)`);
    void refreshOpsPanel();
    scheduleOptionalUnitreeVizLoad();
    remoteLog("[ops] reload_scene", sceneKey, j.scene_path || "", "meshOk=" + meshOk, "n=" + nMesh);
  } catch (e) {
    setStatus(`Reload errore: ${String(e.message || e)}`);
  }
}

async function postHandFollowPelvis(enabled) {
  const tok = inpAdminToken?.value?.trim() || "";
  const headers = { "Content-Type": "application/json" };
  if (tok) headers["X-Admin-Token"] = tok;
  try {
    const r = await fetchWithTimeout(
      `${API()}/api/sim/hand_follow_pelvis`,
      { method: "POST", headers, body: JSON.stringify({ enabled: !!enabled }) },
      12000,
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(`hand_follow_pelvis: ${j.error || r.status}`);
      void refreshOpsPanel();
      return;
    }
    setStatus(`Server: mani seguono pelvis = ${j.hand_follow_pelvis}`);
    void refreshOpsPanel();
  } catch (e) {
    setStatus(`hand_follow_pelvis: ${String(e.message || e)}`);
    void refreshOpsPanel();
  }
}

function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { ...options, signal: ac.signal }).finally(() => clearTimeout(id));
}

async function raceTimeout(promise, ms, label = "op") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}

/** Meta Quest / Oculus Browser: meno GPU. */
function isQuestLikeClient() {
  const ua = navigator.userAgent || "";
  return /Quest|OculusBrowser|Oculus|Meta Quest|Pico|Standalone/i.test(ua);
}

/** Salta le ~49 mesh MuJoCo (memoria). Teleop WS funziona ma il G1 non si vede. URL: ?lite=1 */
function bootLiteMeshes() {
  try {
    return new URLSearchParams(window.location.search).get("lite") === "1";
  } catch {
    return false;
  }
}

/** Manichino leggero punti/linee (fallback visivo). Su Quest default mesh: disattivato; ?stick=1 forza, ?nostick=1 disattiva. */
function stickManikinWanted() {
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get("nostick") === "1") return false;
    if (p.get("stick") === "1") return true;
    if (_questPreferNoStick) return false;
    return isQuestLikeClient();
  } catch {
    return false;
  }
}

const BG_NORMAL = new THREE.Color(0x0a0f18);

/** Distanza usata per ancorare il gruppo tavolo mirror (world z del gruppo = -ROBOT_STAGE_DIST). */
const ROBOT_STAGE_DIST = 2.05;
/** Gruppo mirror in world: z = -ROBOT_STAGE_DIST. Il G1 sta tra te (z≈0+) e quel tavolo. */
const ROBOT_MIRROR_GROUP_Z = -ROBOT_STAGE_DIST;
const ROBOT_STAGE_POS_DEFAULT = new THREE.Vector3(0, 0.50, ROBOT_MIRROR_GROUP_Z + 0.62);
/** Yaw stanza (radianti): π/2 → fronte verso tavolo mirror (−Z). Teleop: reflect X prima di inv(roomFix). */
const ROBOT_STAGE_YAW_DEFAULT = Math.PI / 2;
const _ROBOT_REFLECT_X = new THREE.Matrix4().makeScale(-1, 1, 1);

const _headPos = new THREE.Vector3();
const _headRight = new THREE.Vector3();
const _headForward = new THREE.Vector3();
const _headBasisQuat = new THREE.Quaternion();
const _mirrorWork = new THREE.Vector3();
const _mirrorWork2 = new THREE.Vector3();
const _worldQuatTmp = new THREE.Quaternion();

function mirrorDeskInteractionWanted() {
  try {
    return new URLSearchParams(window.location.search).get("nomirror") !== "1";
  } catch {
    return true;
  }
}

/** Stessa geometria dello stick mirror (riflessione + mirrorscale) prima del mapping MJ. Disattiva con ?nohandmirrorpath=1 */
function teleopHandMirrorPath() {
  if (!mirrorDeskInteractionWanted()) return false;
  try {
    if (new URLSearchParams(window.location.search).get("nohandmirrorpath") === "1") return false;
  } catch (_) {}
  return true;
}

function _headBasisFromFrame(frame, refSpace) {
  if (!frame || !refSpace) return false;
  try {
    const vp = frame.getViewerPose(refSpace);
    if (!vp?.transform?.position) return false;
    const p = vp.transform.position;
    _headPos.set(p.x, p.y, p.z);
    const o = vp.transform.orientation;
    if (o && (o.x !== 0 || o.y !== 0 || o.z !== 0 || o.w !== 0)) {
      _headBasisQuat.set(o.x, o.y, o.z, o.w);
    } else if (vp.transform.matrix && vp.transform.matrix.length >= 16) {
      _matWorld.fromArray(vp.transform.matrix);
      _matWorld.decompose(_fbxDecompPos, _headBasisQuat, _fbxDecompScl);
    } else {
      _headBasisQuat.identity();
    }
    _headRight.set(1, 0, 0).applyQuaternion(_headBasisQuat);
    _headForward.set(0, 0, -1).applyQuaternion(_headBasisQuat);
    _headRight.normalize();
    _headForward.normalize();
    return true;
  } catch {
    return false;
  }
}

function getMirrorMotionScale() {
  try {
    const v = parseFloat(new URLSearchParams(window.location.search).get("mirrorscale") || "");
    if (Number.isFinite(v) && v >= 0.35 && v <= 1.4) return v;
  } catch (_) {}
  return 1.0;
}

/** Extra scale on lateral (head-right) hand motion after mirror reflection; helps arm spread match wide poses. */
function getHandLateralScale() {
  try {
    const v = parseFloat(new URLSearchParams(window.location.search).get("handlatscale") || "");
    if (Number.isFinite(v) && v >= 0.5 && v <= 2.0) return v;
  } catch (_) {}
  return 1.12;
}

/** Offset verticale (m) sommato a _headPos.y per l’ancora mirror (default 0). Query ?mirrory=-0.05 */
function getMirrorAnchorYOffset() {
  try {
    const v = parseFloat(new URLSearchParams(window.location.search).get("mirrory") || "");
    if (Number.isFinite(v) && v >= -1.2 && v <= 1.2) return v;
  } catch (_) {}
  return 0;
}

/** `forward` = specchio davanti (piano verticale verso il tavolo mirror); `right` = legacy (piano sagittale). */
function getMirrorPlaneMode() {
  try {
    if (new URLSearchParams(window.location.search).get("mirrorplane") === "right") return "right";
  } catch (_) {}
  return "forward";
}

/** `head` = ancora Y dalla testa; `table` = superficie tavolo mirror + mirrorhandlift. */
function getMirrorAnchorMode() {
  try {
    if (new URLSearchParams(window.location.search).get("mirroranchor") === "table") return "table";
  } catch (_) {}
  return "head";
}

/** Specchio sinistra/destra (riflessione rigida X) per le mesh G1 da geom_mat4. ?norobotmirror=1 disattiva. */
function robotPoseMirrorXEnabled() {
  try {
    if (new URLSearchParams(window.location.search).get("norobotmirror") === "1") return false;
  } catch (_) {}
  return true;
}

/** Lerp/slerp pose tra snapshot WS (~45 Hz) e render (~72–90 Hz). ?nosmooth=1 disattiva. */
function robotPoseSmoothEnabled() {
  try {
    if (new URLSearchParams(window.location.search).get("nosmooth") === "1") return false;
  } catch (_) {}
  return true;
}

/** Rigid body reflection across YZ (world x → −x): M' = S M S. */
function reflectRigidWorldMatrix(m) {
  m.multiply(_ROBOT_REFLECT_X);
  m.premultiply(_ROBOT_REFLECT_X);
}

/** MuJoCo geom world (Three) → stanza: roomFix * M. Mirror X sul parent `robotGroup` (non per-mesh) così i giunti non ruotano verso l'interno. */
function applyGeomRoomWorldTransform(mjWorldMat, outMat) {
  outMat.copy(_robotRoomFix).multiply(mjWorldMat);
}

function applyHandRoomMirrorReflect(v) {
  if (!robotPoseMirrorXEnabled()) return;
  v.x *= -1;
}

function syncRobotGroupMirrorScale() {
  const mx = robotPoseMirrorXEnabled() ? -1 : 1;
  robotGroup.scale.set(mx, 1, 1);
  robotGroup.rotation.set(0, 0, 0);
  robotGroup.updateMatrixWorld(true);
}

/**
 * Corpi GLB gerarchici: T * reflect(M), NON reflect(T*M) — altrimenti i parent-child si rompono
 * e i polsi finiscono lontani (es. sopra la testa).
 */
function applyBodyRoomWorldTransform(mjWorldMat, outMat) {
  outMat.copy(mjWorldMat);
  if (robotPoseMirrorXEnabled()) reflectRigidWorldMatrix(outMat);
  outMat.premultiply(_robotRoomFix);
}

/** Sopra il piano tavolo (solo con mirroranchor=table), metri. Default se assente: 0.08 */
function getMirrorHandLift() {
  try {
    const raw = new URLSearchParams(window.location.search).get("mirrorhandlift");
    if (raw != null && raw !== "") {
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v >= -0.3 && v <= 0.55) return v;
    }
  } catch (_) {}
  return getMirrorAnchorMode() === "table" ? 0.08 : 0;
}

/** Disattiva pinch/grab sui props (?nograb=1) per dataset solo dita. */
function grabInteractionWanted() {
  try {
    return new URLSearchParams(window.location.search).get("nograb") !== "1";
  } catch {
    return true;
  }
}

const MIRROR_DESK_TZ = -0.72;
const MIRROR_DESK_TY = 0.82;
const MIRROR_LOCAL_ANCHOR_Y = 0.92;
const MIRROR_TABLETOP_LOCAL_Y = MIRROR_DESK_TY - 0.0225;

const _mirrorAnchor = new THREE.Vector3();
const _mirrorDeskRefWorld = new THREE.Vector3();
const _mirrorReflectNorm = new THREE.Vector3();
const _pelvis = new THREE.Vector3();
const _hipL = new THREE.Vector3();
const _hipR = new THREE.Vector3();
const _mChest = new THREE.Vector3();
const _mPelvis = new THREE.Vector3();
const _mHipL = new THREE.Vector3();
const _mHipR = new THREE.Vector3();

/** Riflessione sul piano mirror (forward o sagittale) + ancora tavolo/testa; scala il movimento relativo alla testa. */
function _mirrorPointRefSpace(p, out) {
  _updateMirrorReflectNormal();
  _mirrorWork.copy(p).sub(_headPos);
  const d = _mirrorWork.dot(_mirrorReflectNorm);
  _mirrorWork.addScaledVector(_mirrorReflectNorm, -2 * d);
  _mirrorWork2.copy(_headPos).add(_mirrorWork);
  _mirrorWork.copy(_mirrorWork2).sub(_headPos);
  const ms = getMirrorMotionScale();
  const ls = getHandLateralScale();
  _mirrorWork.multiplyScalar(ms);
  if (ls !== 1.0) {
    const fwd = _mirrorWork.dot(_mirrorReflectNorm);
    const latX = _mirrorWork.x - _mirrorReflectNorm.x * fwd;
    const latZ = _mirrorWork.z - _mirrorReflectNorm.z * fwd;
    _mirrorWork.x += latX * (ls - 1.0);
    _mirrorWork.z += latZ * (ls - 1.0);
  }
  _getMirrorAnchorWorld(_mirrorAnchor);
  out.copy(_mirrorAnchor).add(_mirrorWork);
  return out;
}

const _matWorld = new THREE.Matrix4();
const _matInvRobotStage = new THREE.Matrix4();
/** Sposta il G1 dalla world MuJoCo (vicino origine) alla zona tavolo mirror. `robotStage` resta identità. */
const _robotRoomFix = new THREE.Matrix4();
const _robotRoomPos = new THREE.Vector3();
const _robotYawQuat = new THREE.Quaternion();
const _axisYUp = new THREE.Vector3(0, 1, 0);
const _oneScale = new THREE.Vector3(1, 1, 1);
/** Offset aggiuntivo (m) e yaw (gradi) sommati al punto calcolato sul tavolo mirror; persistito in localStorage. */
const _robotUserOffset = new THREE.Vector3();
let _robotUserYawExtraDeg = 0;
/** Ultimo geom_mat4 dal WS: per riapplicare subito offset da UI. */
let _lastGeomMat4Raw = null;

/** Limiti slider offset G1 (min/max/step): unica fonte per clamp e attributi range. */
const G1_OFF = {
  x: { min: -2, max: 2, step: 0.02 },
  y: { min: -1.65, max: 2, step: 0.02 },
  z: { min: -3.5, max: 2, step: 0.02 },
  yaw: { min: -120, max: 120, step: 1 },
};

function clampG1OffAxis(v, key) {
  const L = G1_OFF[key];
  if (!L || !Number.isFinite(v)) return 0;
  return Math.max(L.min, Math.min(L.max, v));
}

function configureG1OffsetSliders() {
  const set = (el, spec) => {
    if (!el || !spec) return;
    el.min = String(spec.min);
    el.max = String(spec.max);
    el.step = String(spec.step);
  };
  set(inpG1OffX, G1_OFF.x);
  set(inpG1OffY, G1_OFF.y);
  set(inpG1OffZ, G1_OFF.z);
  set(inpG1OffYaw, G1_OFF.yaw);
}

function syncG1OffsetLabelsFromSliders() {
  const xf = (el) => (el ? Number(el.value) : 0);
  if (elG1OffXVal && inpG1OffX) elG1OffXVal.textContent = `${xf(inpG1OffX).toFixed(2)} m`;
  if (elG1OffYVal && inpG1OffY) elG1OffYVal.textContent = `${xf(inpG1OffY).toFixed(2)} m`;
  if (elG1OffZVal && inpG1OffZ) elG1OffZVal.textContent = `${xf(inpG1OffZ).toFixed(2)} m`;
  if (elG1OffYawVal && inpG1OffYaw) elG1OffYawVal.textContent = `${Math.round(xf(inpG1OffYaw))}°`;
}

function loadRobotOffsetFromStorage() {
  try {
    const cx = parseFloat(localStorage.getItem("g1_room_off_x") || "0");
    const cy = parseFloat(localStorage.getItem("g1_room_off_y") || "0");
    const cz = parseFloat(localStorage.getItem("g1_room_off_z") || "0");
    const yw = parseFloat(localStorage.getItem("g1_room_off_yaw_deg") || "0");
    if (Number.isFinite(cx)) _robotUserOffset.x = clampG1OffAxis(cx, "x");
    if (Number.isFinite(cy)) _robotUserOffset.y = clampG1OffAxis(cy, "y");
    if (Number.isFinite(cz)) _robotUserOffset.z = clampG1OffAxis(cz, "z");
    _robotUserYawExtraDeg = Number.isFinite(yw) ? clampG1OffAxis(yw, "yaw") : 0;
  } catch (_) {}
}

function saveRobotOffsetToStorage() {
  try {
    localStorage.setItem("g1_room_off_x", String(_robotUserOffset.x));
    localStorage.setItem("g1_room_off_y", String(_robotUserOffset.y));
    localStorage.setItem("g1_room_off_z", String(_robotUserOffset.z));
    localStorage.setItem("g1_room_off_yaw_deg", String(_robotUserYawExtraDeg));
  } catch (_) {}
}

loadRobotOffsetFromStorage();
writeRobotOffsetInputsToDOM();

const _geomWTarget = [];
const _geomWSmooth = [];
let _geomWorldCount = 0;
let _geomSmoothPrimed = false;
let _lastRobotSmoothT = 0;
const _geomLerpPosS = new THREE.Vector3();
const _geomLerpPosT = new THREE.Vector3();
const _geomLerpQuatS = new THREE.Quaternion();
const _geomLerpQuatT = new THREE.Quaternion();
const _geomLerpSclS = new THREE.Vector3();
const _geomLerpSclT = new THREE.Vector3();
const _fbxTargetWorld = new THREE.Matrix4();
const _fbxParentInv = new THREE.Matrix4();
const _fbxLocalMat = new THREE.Matrix4();
const _fbxCalibTarget = new THREE.Matrix4();
const _fbxDecompPos = new THREE.Vector3();
const _fbxDecompQuat = new THREE.Quaternion();
const _fbxDecompScl = new THREE.Vector3();

const UNITREE_FBX_PATH = "/static/models/unitree/g1_29dof_rev_1_0.fbx";
const UNITREE_GLB_PATH = "/static/models/unitree/g1_29dof_rev_1_0.glb";
const G1_EXPECTED_HEIGHT = 1.32;

let unitreeVizRoot = null;
let useUnitreeViz = false;
let unitreeBodyNodeMap = null;
let unitreeNodeOrigScale = null;
let unitreeCalibOffset = null;

let ws = null;
let currentMode = "realtime";
/** Impostato a true solo a fine boot(): mesh (o lite), WS, XR setup. */
let bootReady = false;
let _renderErrorLogged = false;

function isVrGateOk() {
  return bootReady && ws && ws.readyState === WebSocket.OPEN;
}

function updateVrButtonEnabled() {
  if (!btnVr) return;
  btnVr.disabled = !(isVrGateOk() || (renderer.xr && renderer.xr.isPresenting));
}

const TELEOP_HAND_OFFSET_MJ = [0, 0, 0];

/** Inversa di `_robotRoomFix` per il frame corrente (aggiornata una volta per frame XR prima di readHands). */
const _matInvRobotRoomFix = new THREE.Matrix4();
const _handXrToMjScratch = new THREE.Vector3();
const _handMirrorPreMjScratch = new THREE.Vector3();
const _handMirrorPostScratch = new THREE.Vector3();
let _handTraceTick = 0;

/**
 * Punto XR (Y-up, scena Three) → world MuJoCo per IK (`server.py` usa `xpos` MJ nativo).
 * Mesh: robotGroup.scale(−1,1,1) @ roomFix @ M — inverso: reflect X(p) poi inv(roomFix).
 * `roomFix` include già lo yaw stanza; Ry extra (g1-teleop senza roomFix) rompe l’allineamento (~0.8 m).
 */
function mjWorldHandTargetFromXrPosition(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  _handXrToMjScratch.set(p.x, p.y, p.z);
  applyHandRoomMirrorReflect(_handXrToMjScratch);
  _handXrToMjScratch.applyMatrix4(_matInvRobotRoomFix);
  const tx = _handXrToMjScratch.x + TELEOP_HAND_OFFSET_MJ[0];
  const ty = _handXrToMjScratch.y + TELEOP_HAND_OFFSET_MJ[1];
  const tz = _handXrToMjScratch.z + TELEOP_HAND_OFFSET_MJ[2];
  return [tx, -tz, ty];
}

/** Inversa di `mjWorldHandTargetFromXrPosition`: MJ nativo → punto Three stanza (stesso spazio dell'input p). */
function mjHandTargetToThreeRoom(mj) {
  if (!mj || mj.length < 3) return null;
  const ox = TELEOP_HAND_OFFSET_MJ[0];
  const oy = TELEOP_HAND_OFFSET_MJ[1];
  const oz = TELEOP_HAND_OFFSET_MJ[2];
  _handXrToMjScratch.set(mj[0] - ox, mj[2] - oy, -mj[1] - oz);
  _handXrToMjScratch.applyMatrix4(_robotRoomFix);
  applyHandRoomMirrorReflect(_handXrToMjScratch);
  return _handXrToMjScratch.clone();
}

function _bodyTranslationFromMat4F(m) {
  if (!m || m.length < 16) return null;
  return new THREE.Vector3(Number(m[12]), Number(m[13]), Number(m[14]));
}

const _dbgWristWorldMat = new THREE.Matrix4();
const _dbgWristQuat = new THREE.Quaternion();
const _dbgWristScl = new THREE.Vector3();
/** Mesh STL polso yaw (nome → mesh) per handgrid verde — stessa matrixWorld del render. */
let _wristMeshByKey = null;

function cacheWristMeshesForHandGrid() {
  const m = new Map();
  for (const mesh of robotMeshes) {
    if (!mesh?.name) continue;
    const k = normalizeBodyKey(mesh.name);
    if (k.endsWith("_wrist_yaw_link")) m.set(k, mesh);
  }
  _wristMeshByKey = m;
}

/**
 * Polso robot in world Three per overlay handgrid (verde).
 * GLB: posizione world del nodo dopo applyBodiesToUnitreeViz (gerarchia + calib).
 * Mesh STL: matrixWorld del geom renderizzato (reflect(roomFix*M) via tickRobotGeomPoseSmooth).
 */
function robotWristWorldForHandGrid(wristName, out) {
  const key = normalizeBodyKey(wristName);
  if (useUnitreeViz && unitreeBodyNodeMap?.size) {
    const node = unitreeBodyNodeMap.get(key);
    if (node) {
      node.updateMatrixWorld(true);
      node.getWorldPosition(out);
      return true;
    }
  }
  const mesh = _wristMeshByKey?.get(key);
  if (mesh) {
    mesh.updateMatrixWorld(true);
    mesh.getWorldPosition(out);
    return true;
  }
  if (!useUnitreeViz && _wristMeshByKey?.size) {
    for (let i = 0; i < robotMeshes.length; i++) {
      const rm = robotMeshes[i];
      if (!rm || normalizeBodyKey(rm.name) !== key) continue;
      if (_geomWSmooth[i]) {
        _geomWSmooth[i].decompose(out, _dbgWristQuat, _dbgWristScl);
        return true;
      }
    }
  }
  return false;
}

function _findBodyMat4(bodies, name) {
  for (const b of bodies || []) {
    if (b?.name === name && b.mat4) return b.mat4;
  }
  return null;
}

// --- Overlay debug mani ↔ robot (?handgrid=1) ---
let _lastSimBodies = null;
let _handGridDebugGroup = null;
let _hgGrid = null;
/** 8 sfere: L raw mir mj rob, R raw mir mj rob */
let _hgSpheres = [];
let _hgLineGeom = null;
let _hgLine = null;

function ensureHandGridDebug() {
  if (_handGridDebugGroup) return;
  _handGridDebugGroup = new THREE.Group();
  _handGridDebugGroup.name = "HandTraceDebug";
  scene.add(_handGridDebugGroup);
  const colors = [0x22d3ee, 0xd946ef, 0xfacc15, 0x4ade80];
  for (let i = 0; i < 8; i++) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.034, 14, 10),
      new THREE.MeshBasicMaterial({ color: colors[i % 4], depthTest: true, transparent: true, opacity: 0.92 }),
    );
    mesh.visible = false;
    _handGridDebugGroup.add(mesh);
    _hgSpheres.push(mesh);
  }
  _hgGrid = new THREE.GridHelper(1.2, 12, 0x64748b, 0x334155);
  _hgGrid.visible = false;
  _handGridDebugGroup.add(_hgGrid);
  const lg = new THREE.BufferGeometry();
  const pos = new Float32Array(36);
  lg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  _hgLineGeom = lg;
  _hgLine = new THREE.Line(
    lg,
    new THREE.LineBasicMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.55, depthTest: true }),
  );
  _hgLine.visible = false;
  _handGridDebugGroup.add(_hgLine);
}

/**
 * Aggiorna overlay: ciano raw, magenta post-mirror, giallo MJ→stanza (inviato al server), verde polso sim.
 * @param {object} handsTeleop { left: mj[]|null, right: mj[]|null } payload WS (post-swap IK)
 * @param {object} fingersRaw { left?, right? } curl XR non swappato
 */
function _avgFingerCurl(fd) {
  if (!fd) return 0;
  const t = fd.thumb || [0, 0, 0];
  const i = fd.index || [0, 0];
  const m = fd.middle || [0, 0];
  return (t[0] + t[1] + t[2] + i[0] + i[1] + m[0] + m[1]) / 7;
}

function updateHandGridDebug(frame, refSpace, handsTeleop, fingersRaw) {
  if (!bootQueryFlag("handgrid")) {
    if (_handGridDebugGroup) _handGridDebugGroup.visible = false;
    return;
  }
  ensureHandGridDebug();
  _handGridDebugGroup.visible = true;
  if (!frame || !refSpace) {
    for (const m of _hgSpheres) m.visible = false;
    _hgGrid.visible = false;
    _hgLine.visible = false;
    return;
  }
  const session = frame.session;
  if (!session) return;

  const sides = [
    { key: "left", si: 0 },
    { key: "right", si: 4 },
  ];
  const linePos = _hgLineGeom.attributes.position.array;
  let li = 0;
  let gridCx = 0;
  let gridCy = 0;
  let gridCz = 0;
  let nCenter = 0;

  for (const { key, si } of sides) {
    const wristName = robotWristNameForXrSide(key);
    const teleopSide = xrSideToTeleopSide(key);
    let raw = null;
    let mir = null;
    let mjThree = null;
    const mj = handsTeleop?.[teleopSide];
    for (const src of session.inputSources) {
      if (src.handedness !== key || !src.hand) continue;
      const joint = src.hand.get("wrist") || src.hand.get("middle-finger-metacarpal");
      if (!joint) continue;
      try {
        const jp = frame.getJointPose(joint, refSpace);
        const p = jp?.transform?.position;
        if (!p) continue;
        raw = new THREE.Vector3(p.x, p.y, p.z);
        break;
      } catch (_) {}
    }
    if (raw) {
      _hgSpheres[si].position.copy(raw);
      _hgSpheres[si].visible = true;
      if (teleopHandMirrorPath() && _headBasisFromFrame(frame, refSpace)) {
        _mirrorPointRefSpace(raw, _handMirrorPostScratch);
        mir = _handMirrorPostScratch.clone();
        _hgSpheres[si + 1].position.copy(mir);
        _hgSpheres[si + 1].visible = true;
      } else {
        mir = raw.clone();
        _hgSpheres[si + 1].position.copy(raw);
        _hgSpheres[si + 1].visible = true;
      }
      if (mj && mj.length >= 3) {
        mjThree = mjHandTargetToThreeRoom(mj);
        if (mjThree) {
          _hgSpheres[si + 2].position.copy(mjThree);
          _hgSpheres[si + 2].visible = true;
          gridCx += mjThree.x + raw.x;
          gridCy += mjThree.y + raw.y;
          gridCz += mjThree.z + raw.z;
          nCenter += 2;
        } else {
          _hgSpheres[si + 2].visible = false;
        }
      } else {
        _hgSpheres[si + 2].visible = false;
      }
      if (mir) {
        linePos[li++] = raw.x;
        linePos[li++] = raw.y;
        linePos[li++] = raw.z;
        linePos[li++] = mir.x;
        linePos[li++] = mir.y;
        linePos[li++] = mir.z;
        if (mjThree) {
          linePos[li++] = mir.x;
          linePos[li++] = mir.y;
          linePos[li++] = mir.z;
          linePos[li++] = mjThree.x;
          linePos[li++] = mjThree.y;
          linePos[li++] = mjThree.z;
        }
      }
    } else {
      for (let j = 0; j < 3; j++) _hgSpheres[si + j].visible = false;
    }

    const rob = new THREE.Vector3();
    if (robotWristWorldForHandGrid(wristName, rob)) {
      _hgSpheres[si + 3].position.copy(rob);
      _hgSpheres[si + 3].visible = true;
      const curl = _avgFingerCurl(fingersRawForTeleopSide(fingersRaw, teleopSide));
      const s = 0.028 + curl * 0.022;
      _hgSpheres[si + 3].scale.setScalar(s / 0.034);
      const mat = _hgSpheres[si + 3].material;
      if (mat?.color) mat.color.setRGB(0.2 + curl * 0.6, 1 - curl * 0.55, 0.2);
      if (mjThree) {
        linePos[li++] = mjThree.x;
        linePos[li++] = mjThree.y;
        linePos[li++] = mjThree.z;
        linePos[li++] = rob.x;
        linePos[li++] = rob.y;
        linePos[li++] = rob.z;
      }
      gridCx += rob.x;
      gridCy += rob.y;
      gridCz += rob.z;
      nCenter++;
    } else {
      _hgSpheres[si + 3].visible = false;
    }
  }

  for (let k = li; k < linePos.length; k++) linePos[k] = 0;
  _hgLineGeom.setDrawRange(0, li / 3);
  _hgLineGeom.attributes.position.needsUpdate = true;
  _hgLine.visible = li >= 6;

  const gx = nCenter > 0 ? gridCx / nCenter : 0;
  const gy = nCenter > 0 ? gridCy / nCenter : 0;
  const gz = nCenter > 0 ? gridCz / nCenter : 0;
  _handGridDebugGroup.position.set(gx, gy, gz);
  _hgGrid.position.set(0, 0.02, 0);
  _hgGrid.visible = nCenter > 0;

  for (let i = 0; i < 8; i++) {
    if (_hgSpheres[i].visible) {
      _hgSpheres[i].position.sub(_handGridDebugGroup.position);
    }
  }
  if (_hgLine.visible) {
    for (let k = 0; k < li; k += 3) {
      linePos[k] -= gx;
      linePos[k + 1] -= gy;
      linePos[k + 2] -= gz;
    }
    _hgLineGeom.attributes.position.needsUpdate = true;
  }
}

// --- Remote logging (console + POST /api/client_log -> stdout e logs/client.log sul PC) ---
const _RL_QUEUE = [];
let _RL_TIMER = 0;
const _RL_BATCH_MS = 220;
const _RL_MAX_BATCH = 80;

function remoteLogFlush() {
  const batch = _RL_QUEUE.splice(0, _RL_MAX_BATCH);
  if (!batch.length) return;
  fetch(`${API()}/api/client_log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines: batch }),
    keepalive: true,
  }).catch(() => {});
}

function remoteLog(...args) {
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(line);
  _RL_QUEUE.push(line);
  if (!_RL_TIMER) {
    _RL_TIMER = setTimeout(() => {
      _RL_TIMER = 0;
      remoteLogFlush();
    }, _RL_BATCH_MS);
  }
}

window.addEventListener("pagehide", () => {
  const batch = _RL_QUEUE.splice(0, _RL_MAX_BATCH);
  if (!batch.length) return;
  const body = JSON.stringify({ lines: batch });
  if (navigator.sendBeacon) {
    const ok = navigator.sendBeacon(
      `${API()}/api/client_log`,
      new Blob([body], { type: "application/json" }),
    );
    if (!ok) remoteLogFlush();
  } else {
    remoteLogFlush();
  }
});

// --- WebSocket with auto-reconnect ---
let _wsBackoff = 500;
let _wsReconnTimer = 0;
let _wsAlive = false;
let _wsMsgCount = 0;

function connectWs() {
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsProto}//${location.host}/ws`;
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  _wsAlive = false;
  remoteLog("[ws] connecting to", url);
  ws = new WebSocket(url);

  ws.onopen = () => {
    _wsBackoff = 500;
    _wsAlive = true;
    _wsMsgCount = 0;
    remoteLog("[ws] opened");
    const cur = statusEl?.textContent || "";
    const tag = `WS OK (${location.protocol}//${location.host})`;
    setStatus(cur.includes(tag) ? cur : `${cur} | ${tag}`.replace(/^\s*\|\s*/, ""));
    ws.send(JSON.stringify({ type: "ready" }));
    // Allinea modalità server (es. dopo restart) e assicura REALTIME per controllo fisica G1.
    sendMode("realtime");
    updateVrButtonEnabled();
  };

  ws.onclose = (ev) => {
    _wsAlive = false;
    remoteLog("[ws] closed code=" + ev.code, "reason=" + ev.reason, "msgs=" + _wsMsgCount);
    updateVrButtonEnabled();
    _scheduleReconnect();
  };

  ws.onerror = (ev) => {
    remoteLog("[ws] error", ev?.message || "");
  };

  ws.onmessage = (ev) => {
    _wsMsgCount++;
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") {
        if (msg.sim?.bodies) _lastSimBodies = msg.sim.bodies;
        if (useUnitreeViz && unitreeVizRoot && msg.sim?.bodies) {
          applyBodiesToUnitreeViz(unitreeVizRoot, msg.sim.bodies);
        } else if (msg.sim?.geom_mat4) {
          ingestGeomTargetsFromWs(msg.sim.geom_mat4, false);
        }
        if (msg.mode && msg.mode !== currentMode) {
          currentMode = msg.mode;
          updateModeUI();
        }
        if (msg.rec_frames !== undefined && modeStatus) {
          modeStatus.textContent = `REC ${msg.rec_frames} frames`;
        }
        if (msg.playback_progress && modeStatus) {
          const p = msg.playback_progress;
          const pct = p.total > 0 ? Math.round((p.idx / p.total) * 100) : 0;
          modeStatus.textContent = `PLAY ${pct}% (${p.idx}/${p.total})`;
        }
      }
    } catch (_) {}
  };
}

function _scheduleReconnect() {
  if (_wsReconnTimer) return;
  const delay = Math.min(_wsBackoff, 8000);
  remoteLog("[ws] reconnect in", delay, "ms");
  setStatus(`WS disconnesso — riconnessione in ${(delay / 1000).toFixed(1)}s…`);
  _wsReconnTimer = setTimeout(() => {
    _wsReconnTimer = 0;
    _wsBackoff = Math.min(_wsBackoff * 1.5, 8000);
    connectWs();
  }, delay);
}

function setStatus(t) { if (statusEl) statusEl.textContent = t; }

function setHudDiag(t) {
  if (hudDiag) hudDiag.textContent = t || "";
}

function setHudStrip(text) {
  if (hudStrip) hudStrip.textContent = text || "";
}

let _sendCount = 0;
/** Ultimo payload dita inviato al server (re-inviato se un frame non ha chiavi dita). */
let _lastFingersSent = undefined;

function sendInput(axes, hands, fingers, head) {
  _sendCount++;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const inXr = renderer.xr?.isPresenting;
    const interval = inXr ? 300 : 600;
    if (_sendCount <= 3 || _sendCount % interval === 0) {
      remoteLog("[sendInput] ws not open, state=" + (ws ? ws.readyState : "null"), "frame=" + _sendCount);
    }
    return;
  }
  if (_sendCount <= 5 || _sendCount % 300 === 0) {
    remoteLog("[sendInput#" + _sendCount + "] hands=" + JSON.stringify(hands || {}).slice(0, 120));
  }
  const o = { type: "input", axes };
  if (hands !== undefined) o.hands = hands;
  if (fingers !== undefined) o.fingers = fingers;
  if (head !== undefined) o.head = head;
  ws.send(JSON.stringify(o));
}

function sendMode(mode) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "mode", mode }));
}

// --- Scene ---
const scene = new THREE.Scene();
scene.background = BG_NORMAL.clone();

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(1.5, 1.48, 0.45);
{
  const mirrorTableLocalZ = -0.72;
  const lookZ = (ROBOT_STAGE_POS_DEFAULT.z + ROBOT_MIRROR_GROUP_Z + mirrorTableLocalZ) * 0.5;
  camera.lookAt(0, 0.86, lookZ);
}

const _xrLiteGpu = isQuestLikeClient();
const renderer = new THREE.WebGLRenderer({
  antialias: !_xrLiteGpu,
  alpha: true,
  powerPreference: _xrLiteGpu ? "default" : "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, _xrLiteGpu ? 1 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

try {
  renderer.domElement.addEventListener(
    "webglcontextlost",
    (ev) => {
      try {
        ev.preventDefault();
        remoteLog("[webgl] contextlost", "defaultPrevented per consentire restore");
      } catch (_) {}
    },
    false,
  );
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    try {
      remoteLog("[webgl] contextrestored");
    } catch (_) {}
  });
} catch (_) {}

try {
  if (_xrLiteGpu && typeof renderer.xr.setFoveation === "function") {
    renderer.xr.setFoveation(0);
  }
} catch (_) {}

/** Prima di entrare in VR: scala framebuffer (mitiga artefatti / lente nera su Quest). Query ?xrfb=0.5–2 */
function applyXrFramebufferScaleEarly() {
  try {
    if (typeof renderer?.xr?.setFramebufferScaleFactor !== "function") return;
    const raw = new URLSearchParams(window.location.search).get("xrfb");
    if (raw != null && raw !== "") {
      const v = Math.min(2, Math.max(0.25, parseFloat(raw)));
      if (Number.isFinite(v)) {
        renderer.xr.setFramebufferScaleFactor(v);
        return;
      }
    }
    if (isQuestLikeClient()) {
      // Default più basso del massimo: riduce artefatti / occhio destro nero su alcuni firmware Quest.
      renderer.xr.setFramebufferScaleFactor(0.88);
    }
  } catch (_) {}
}
applyXrFramebufferScaleEarly();

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
scene.add(new THREE.HemisphereLight(0xc8d4e8, 0x1a1f2e, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(4, 12, 6);
scene.add(sun);

const gridHelper = new THREE.GridHelper(24, 48, 0x5a6b8c, 0x2a3548);
scene.add(gridHelper);

/** Punto di riferimento sul tavolo mirror (centro XZ, altezza TY) in world. */
function _mirrorDeskReferenceWorld(out) {
  const g = scene.getObjectByName("MirrorDeskRoot");
  const tz = MIRROR_DESK_TZ;
  if (!g) {
    out.set(0, MIRROR_DESK_TY, -(ROBOT_STAGE_DIST + tz));
    return;
  }
  g.updateMatrixWorld(true);
  out.set(0, MIRROR_DESK_TY, tz);
  g.localToWorld(out);
}

/** Normale unitaria del piano speculare: orizzontale verso il tavolo (forward) o _headRight (right). */
function _updateMirrorReflectNormal() {
  if (getMirrorPlaneMode() === "right") {
    _mirrorReflectNorm.copy(_headRight);
    return;
  }
  _mirrorDeskReferenceWorld(_mirrorDeskRefWorld);
  _mirrorReflectNorm.set(_mirrorDeskRefWorld.x - _headPos.x, 0, _mirrorDeskRefWorld.z - _headPos.z);
  if (_mirrorReflectNorm.lengthSq() < 1e-8) {
    _mirrorReflectNorm.set(_headForward.x, 0, _headForward.z);
    if (_mirrorReflectNorm.lengthSq() < 1e-8) _mirrorReflectNorm.set(0, 0, -1);
    else _mirrorReflectNorm.normalize();
  } else {
    _mirrorReflectNorm.normalize();
  }
}

/** Ancora mirror: XZ da geometria; Y da testa + mirrory oppure piano tavolo + lift + mirrory. */
function _getMirrorAnchorWorld(out) {
  const g = scene.getObjectByName("MirrorDeskRoot");
  const tz = MIRROR_DESK_TZ;
  const tableMode = getMirrorAnchorMode() === "table";
  const localY = tableMode ? MIRROR_TABLETOP_LOCAL_Y : MIRROR_LOCAL_ANCHOR_Y;
  if (!g) {
    out.set(0, localY, -(ROBOT_STAGE_DIST + tz));
    if (tableMode) out.y = out.y + getMirrorHandLift() + getMirrorAnchorYOffset();
    else out.y = _headPos.y + getMirrorAnchorYOffset();
    return;
  }
  g.updateMatrixWorld(true);
  out.set(0, localY, tz);
  g.localToWorld(out);
  if (tableMode) out.y = out.y + getMirrorHandLift() + getMirrorAnchorYOffset();
  else out.y = _headPos.y + getMirrorAnchorYOffset();
}

// --- Manichino XR (linee/punti, niente MeshStandard: riduce errori GL su Quest) ---
const STICK_MAX_LINE_FLOATS = 200;
const stickLinePos = new Float32Array(STICK_MAX_LINE_FLOATS);
const stickLineGeom = new THREE.BufferGeometry();
stickLineGeom.setAttribute("position", new THREE.BufferAttribute(stickLinePos, 3));
const stickLines = new THREE.LineSegments(
  stickLineGeom,
  new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: true, transparent: true, opacity: 0.92 }),
);
stickLines.frustumCulled = false;
const STICK_MAX_POINTS = 32;
const stickPointPos = new Float32Array(STICK_MAX_POINTS * 3);
const stickPointGeom = new THREE.BufferGeometry();
stickPointGeom.setAttribute("position", new THREE.BufferAttribute(stickPointPos, 3));
const stickPoints = new THREE.Points(
  stickPointGeom,
  new THREE.PointsMaterial({ color: 0xfbbf24, size: 0.028, sizeAttenuation: true, depthTest: true }),
);
stickPoints.frustumCulled = false;
const teleopStickGroup = new THREE.Group();
teleopStickGroup.visible = false;
teleopStickGroup.renderOrder = 10000;
teleopStickGroup.add(stickLines);
teleopStickGroup.add(stickPoints);
scene.add(teleopStickGroup);

const stickLineMirrorPos = new Float32Array(STICK_MAX_LINE_FLOATS);
const stickLineMirrorGeom = new THREE.BufferGeometry();
stickLineMirrorGeom.setAttribute("position", new THREE.BufferAttribute(stickLineMirrorPos, 3));
const stickLinesMirror = new THREE.LineSegments(
  stickLineMirrorGeom,
  new THREE.LineBasicMaterial({ color: 0xf472b6, depthTest: true, transparent: true, opacity: 0.9 }),
);
stickLinesMirror.frustumCulled = false;
const stickPointMirrorPos = new Float32Array(STICK_MAX_POINTS * 3);
const stickPointMirrorGeom = new THREE.BufferGeometry();
stickPointMirrorGeom.setAttribute("position", new THREE.BufferAttribute(stickPointMirrorPos, 3));
const stickPointsMirror = new THREE.Points(
  stickPointMirrorGeom,
  new THREE.PointsMaterial({ color: 0xa78bfa, size: 0.026, sizeAttenuation: true, depthTest: true }),
);
stickPointsMirror.frustumCulled = false;
const teleopStickMirrorGroup = new THREE.Group();
teleopStickMirrorGroup.visible = false;
teleopStickMirrorGroup.renderOrder = 10001;
teleopStickMirrorGroup.add(stickLinesMirror);
teleopStickMirrorGroup.add(stickPointsMirror);

const G1_MIRROR_SIL_FLOATS = 36;
const g1MirrorSilPos = new Float32Array(G1_MIRROR_SIL_FLOATS);
const g1MirrorSilGeom = new THREE.BufferGeometry();
g1MirrorSilGeom.setAttribute("position", new THREE.BufferAttribute(g1MirrorSilPos, 3));
const g1MirrorSilhouette = new THREE.LineSegments(
  g1MirrorSilGeom,
  new THREE.LineBasicMaterial({ color: 0x64748b, depthTest: true, transparent: true, opacity: 0.9 }),
);
g1MirrorSilhouette.frustumCulled = false;
g1MirrorSilhouette.renderOrder = 10002;
teleopStickMirrorGroup.add(g1MirrorSilhouette);

const g1MirrorAccentPos = new Float32Array(24);
const g1MirrorAccentGeom = new THREE.BufferGeometry();
g1MirrorAccentGeom.setAttribute("position", new THREE.BufferAttribute(g1MirrorAccentPos, 3));
const g1MirrorAccent = new THREE.LineSegments(
  g1MirrorAccentGeom,
  new THREE.LineBasicMaterial({ color: 0xea580c, depthTest: true, transparent: true, opacity: 0.92 }),
);
g1MirrorAccent.frustumCulled = false;
g1MirrorAccent.renderOrder = 10003;
teleopStickMirrorGroup.add(g1MirrorAccent);

scene.add(teleopStickMirrorGroup);

const _stickLw = new THREE.Vector3();
const _stickLm = new THREE.Vector3();
const _stickRw = new THREE.Vector3();
const _stickRm = new THREE.Vector3();
const _stickShL = new THREE.Vector3();
const _stickElL = new THREE.Vector3();
const _stickShR = new THREE.Vector3();
const _stickElR = new THREE.Vector3();
const _stickHead = new THREE.Vector3();
const _stickChest = new THREE.Vector3();
const _stickDir = new THREE.Vector3();
const _stickLineVerts = [];

function _pushSeg(ax, ay, az, bx, by, bz) {
  _stickLineVerts.push(ax, ay, az, bx, by, bz);
}

function updateStickManikin(frame, refSpace) {
  if (!stickManikinWanted() || !frame || !refSpace) {
    teleopStickGroup.visible = false;
    teleopStickMirrorGroup.visible = false;
    return;
  }
  const session = frame.session;
  if (!session) {
    teleopStickGroup.visible = false;
    teleopStickMirrorGroup.visible = false;
    return;
  }
  _stickLineVerts.length = 0;
  let pi = 0;
  const pushPt = (v) => {
    if (pi >= STICK_MAX_POINTS) return;
    stickPointPos[pi * 3] = v.x;
    stickPointPos[pi * 3 + 1] = v.y;
    stickPointPos[pi * 3 + 2] = v.z;
    pi++;
  };

  let haveL = false;
  let haveR = false;
  for (const src of session.inputSources) {
    if (!src.hand) continue;
    const h = src.hand;
    if (src.handedness === "left") {
      if (_getJointPos(frame, h, "wrist", refSpace, _stickLw) && _getJointPos(frame, h, "index-finger-metacarpal", refSpace, _stickLm)) {
        haveL = true;
      }
    } else if (src.handedness === "right") {
      if (_getJointPos(frame, h, "wrist", refSpace, _stickRw) && _getJointPos(frame, h, "index-finger-metacarpal", refSpace, _stickRm)) {
        haveR = true;
      }
    }
  }

  const armChain = (wrist, meta, shOut, elOut) => {
    _stickDir.copy(meta).sub(wrist);
    const len = _stickDir.length();
    if (len < 1e-4) return false;
    _stickDir.multiplyScalar(1 / len);
    elOut.copy(wrist).addScaledVector(_stickDir, Math.min(0.26, len * 0.55));
    shOut.copy(wrist).addScaledVector(_stickDir, Math.min(0.52, len * 1.1));
    _pushSeg(shOut.x, shOut.y, shOut.z, elOut.x, elOut.y, elOut.z);
    _pushSeg(elOut.x, elOut.y, elOut.z, wrist.x, wrist.y, wrist.z);
    pushPt(shOut);
    pushPt(elOut);
    pushPt(wrist);
    return true;
  };

  let okL = false;
  let okR = false;
  if (haveL) okL = armChain(_stickLw, _stickLm, _stickShL, _stickElL);
  if (haveR) okR = armChain(_stickRw, _stickRm, _stickShR, _stickElR);

  try {
    const vp = frame.getViewerPose(refSpace);
    if (vp?.transform?.position) {
      _stickHead.set(vp.transform.position.x, vp.transform.position.y, vp.transform.position.z);
      pushPt(_stickHead);
      if (okL && okR) {
        _stickChest.copy(_stickLm).add(_stickRm).multiplyScalar(0.5);
        _stickChest.y -= 0.07;
        pushPt(_stickChest);
        _pushSeg(_stickHead.x, _stickHead.y, _stickHead.z, _stickChest.x, _stickChest.y, _stickChest.z);
        _pushSeg(_stickChest.x, _stickChest.y, _stickChest.z, _stickShL.x, _stickShL.y, _stickShL.z);
        _pushSeg(_stickChest.x, _stickChest.y, _stickChest.z, _stickShR.x, _stickShR.y, _stickShR.z);
      } else if (okL) {
        _pushSeg(_stickHead.x, _stickHead.y, _stickHead.z, _stickLm.x, _stickLm.y, _stickLm.z);
      } else if (okR) {
        _pushSeg(_stickHead.x, _stickHead.y, _stickHead.z, _stickRm.x, _stickRm.y, _stickRm.z);
      }
    }
  } catch (_) {}

  const nFloats = Math.min(_stickLineVerts.length, STICK_MAX_LINE_FLOATS);
  const nLineVerts = Math.floor(nFloats / 3);
  for (let i = 0; i < nFloats; i++) stickLinePos[i] = _stickLineVerts[i];
  stickLineGeom.attributes.position.needsUpdate = true;
  stickLineGeom.setDrawRange(0, nLineVerts);

  for (let i = pi * 3; i < STICK_MAX_POINTS * 3; i++) stickPointPos[i] = 0;
  stickPointGeom.attributes.position.needsUpdate = true;
  stickPointGeom.setDrawRange(0, pi);

  const any = nFloats > 0 || pi > 0;
  teleopStickGroup.visible = renderer.xr.isPresenting && any;

  let mirrorAny = false;
  if (mirrorDeskInteractionWanted() && any && _headBasisFromFrame(frame, refSpace)) {
    for (let i = 0; i < nFloats; i += 3) {
      _mirrorWork.set(stickLinePos[i], stickLinePos[i + 1], stickLinePos[i + 2]);
      _mirrorPointRefSpace(_mirrorWork, _mirrorWork2);
      stickLineMirrorPos[i] = _mirrorWork2.x;
      stickLineMirrorPos[i + 1] = _mirrorWork2.y;
      stickLineMirrorPos[i + 2] = _mirrorWork2.z;
    }
    stickLineMirrorGeom.attributes.position.needsUpdate = true;
    stickLineMirrorGeom.setDrawRange(0, nLineVerts);
    let pm = 0;
    for (let j = 0; j < pi; j++) {
      _mirrorWork.set(stickPointPos[j * 3], stickPointPos[j * 3 + 1], stickPointPos[j * 3 + 2]);
      _mirrorPointRefSpace(_mirrorWork, _mirrorWork2);
      stickPointMirrorPos[pm * 3] = _mirrorWork2.x;
      stickPointMirrorPos[pm * 3 + 1] = _mirrorWork2.y;
      stickPointMirrorPos[pm * 3 + 2] = _mirrorWork2.z;
      pm++;
    }
    for (let i = pm * 3; i < STICK_MAX_POINTS * 3; i++) stickPointMirrorPos[i] = 0;
    stickPointMirrorGeom.attributes.position.needsUpdate = true;
    stickPointMirrorGeom.setDrawRange(0, pm);
    mirrorAny = true;
    if (okL && okR) {
      _pelvis.copy(_stickChest);
      _pelvis.y -= 0.22;
      _hipL.copy(_stickShL);
      _hipL.y -= 0.1;
      _hipR.copy(_stickShR);
      _hipR.y -= 0.1;
      _mirrorPointRefSpace(_stickChest, _mChest);
      _mirrorPointRefSpace(_pelvis, _mPelvis);
      _mirrorPointRefSpace(_hipL, _mHipL);
      _mirrorPointRefSpace(_hipR, _mHipR);
      g1MirrorSilPos[0] = _mChest.x; g1MirrorSilPos[1] = _mChest.y; g1MirrorSilPos[2] = _mChest.z;
      g1MirrorSilPos[3] = _mPelvis.x; g1MirrorSilPos[4] = _mPelvis.y; g1MirrorSilPos[5] = _mPelvis.z;
      g1MirrorSilGeom.attributes.position.needsUpdate = true;
      g1MirrorSilGeom.setDrawRange(0, 2);
      g1MirrorAccentPos[0] = _mPelvis.x; g1MirrorAccentPos[1] = _mPelvis.y; g1MirrorAccentPos[2] = _mPelvis.z;
      g1MirrorAccentPos[3] = _mHipL.x; g1MirrorAccentPos[4] = _mHipL.y; g1MirrorAccentPos[5] = _mHipL.z;
      g1MirrorAccentPos[6] = _mPelvis.x; g1MirrorAccentPos[7] = _mPelvis.y; g1MirrorAccentPos[8] = _mPelvis.z;
      g1MirrorAccentPos[9] = _mHipR.x; g1MirrorAccentPos[10] = _mHipR.y; g1MirrorAccentPos[11] = _mHipR.z;
      g1MirrorAccentGeom.attributes.position.needsUpdate = true;
      g1MirrorAccentGeom.setDrawRange(0, 4);
      g1MirrorSilhouette.visible = true;
      g1MirrorAccent.visible = true;
    } else {
      g1MirrorSilGeom.setDrawRange(0, 0);
      g1MirrorAccentGeom.setDrawRange(0, 0);
      g1MirrorSilhouette.visible = false;
      g1MirrorAccent.visible = false;
    }
  } else {
    stickLineMirrorGeom.setDrawRange(0, 0);
    stickPointMirrorGeom.setDrawRange(0, 0);
    g1MirrorSilGeom.setDrawRange(0, 0);
    g1MirrorAccentGeom.setDrawRange(0, 0);
  }
  teleopStickMirrorGroup.visible = renderer.xr.isPresenting && mirrorAny;
}

const deskGroup = new THREE.Group();
deskGroup.position.set(0, 0, 0);
scene.add(deskGroup);

const TABLE_Z = -0.72;
const TABLE_TOP_Y = 0.72;
const tableTop = new THREE.Mesh(
  new THREE.BoxGeometry(1.35, 0.045, 0.88),
  new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.88, metalness: 0.05 }),
);
tableTop.position.set(0, TABLE_TOP_Y - 0.0225, TABLE_Z);
tableTop.receiveShadow = true;
deskGroup.add(tableTop);

const deskLight = new THREE.PointLight(0xfff4e6, 14, 4.5, 1.2);
deskLight.position.set(0, TABLE_TOP_Y + 0.55, TABLE_Z);
deskGroup.add(deskLight);

const grabbables = [];
const mirrorGrabbables = [];
const pinchState = {
  left: { mesh: null, grabVel: new THREE.Vector3(), prevGrabMid: new THREE.Vector3(), prevGrabT: 0, wristQuat: new THREE.Quaternion(), grabQuatOff: new THREE.Quaternion(), prevWristQuat: new THREE.Quaternion(), prevWristT: 0, grabAngVel: new THREE.Vector3() },
  right: { mesh: null, grabVel: new THREE.Vector3(), prevGrabMid: new THREE.Vector3(), prevGrabT: 0, wristQuat: new THREE.Quaternion(), grabQuatOff: new THREE.Quaternion(), prevWristQuat: new THREE.Quaternion(), prevWristT: 0, grabAngVel: new THREE.Vector3() },
};
const _vThumb = new THREE.Vector3();
const _vIndex = new THREE.Vector3();
const _vMid = new THREE.Vector3();
const _vGrabDelta = new THREE.Vector3();
const _vAngDelta = new THREE.Vector3();
const _qAngDel = new THREE.Quaternion();
const _qAngPrevInv = new THREE.Quaternion();
const _grabMirrorMid = new THREE.Vector3();

const pinchStateMirror = {
  left: { mesh: null, grabVel: new THREE.Vector3(), prevGrabMid: new THREE.Vector3(), prevGrabT: 0, wristQuat: new THREE.Quaternion(), grabQuatOff: new THREE.Quaternion(), prevWristQuat: new THREE.Quaternion(), prevWristT: 0, grabAngVel: new THREE.Vector3() },
  right: { mesh: null, grabVel: new THREE.Vector3(), prevGrabMid: new THREE.Vector3(), prevGrabT: 0, wristQuat: new THREE.Quaternion(), grabQuatOff: new THREE.Quaternion(), prevWristQuat: new THREE.Quaternion(), prevWristT: 0, grabAngVel: new THREE.Vector3() },
};

let xrRefSpaceResetCleanup = null;
let deskPhysicsRestSnapshot = [];
let mirrorDeskPhysicsRestSnapshot = [];

function captureDeskPhysicsRestState() {
  if (!deskPhysics?.world?.bodies) return;
  deskPhysicsRestSnapshot = deskPhysics.world.bodies.map((b) => ({
    px: b.position.x, py: b.position.y, pz: b.position.z,
    qx: b.quaternion.x, qy: b.quaternion.y, qz: b.quaternion.z, qw: b.quaternion.w,
    vx: b.velocity.x, vy: b.velocity.y, vz: b.velocity.z,
    ax: b.angularVelocity.x, ay: b.angularVelocity.y, az: b.angularVelocity.z,
  }));
}

function captureMirrorDeskPhysicsRestState() {
  if (!mirrorDeskPhysics?.world?.bodies) return;
  mirrorDeskPhysicsRestSnapshot = mirrorDeskPhysics.world.bodies.map((b) => ({
    px: b.position.x, py: b.position.y, pz: b.position.z,
    qx: b.quaternion.x, qy: b.quaternion.y, qz: b.quaternion.z, qw: b.quaternion.w,
    vx: b.velocity.x, vy: b.velocity.y, vz: b.velocity.z,
    ax: b.angularVelocity.x, ay: b.angularVelocity.y, az: b.angularVelocity.z,
  }));
}

function restoreDeskXRLayoutToDefaults() {
  deskGroup.position.set(0, 0, 0);
  deskGroup.quaternion.set(0, 0, 0, 1);
  deskGroup.scale.set(1, 1, 1);
  deskGroup.updateMatrixWorld(true);
  pinchState.left.mesh = pinchState.right.mesh = null;
  resetGrabTracking(pinchState.left);
  resetGrabTracking(pinchState.right);
  for (const o of grabbables) { o.userData.heldBy = null; releaseBody(o, null, null); }
  if (deskPhysics?.world?.bodies?.length && deskPhysicsRestSnapshot.length === deskPhysics.world.bodies.length) {
    const bodies = deskPhysics.world.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i], s = deskPhysicsRestSnapshot[i];
      b.position.set(s.px, s.py, s.pz);
      b.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      b.velocity.set(s.vx, s.vy, s.vz);
      b.angularVelocity.set(s.ax, s.ay, s.az);
      if (b.mass > 0) { b.wakeUp(); if (typeof b.updateMassProperties === "function") b.updateMassProperties(); }
    }
    for (const m of grabbables) {
      const b = m.userData.cannonBody;
      if (!b) continue;
      m.position.set(b.position.x, b.position.y, b.position.z);
      m.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    }
  }

  pinchStateMirror.left.mesh = pinchStateMirror.right.mesh = null;
  resetGrabTracking(pinchStateMirror.left);
  resetGrabTracking(pinchStateMirror.right);
  for (const o of mirrorGrabbables) { o.userData.heldBy = null; releaseBodyMirror(o, null, null); }
  if (mirrorDeskPhysics?.world?.bodies?.length && mirrorDeskPhysicsRestSnapshot.length === mirrorDeskPhysics.world.bodies.length) {
    const mbodies = mirrorDeskPhysics.world.bodies;
    for (let i = 0; i < mbodies.length; i++) {
      const b = mbodies[i], s = mirrorDeskPhysicsRestSnapshot[i];
      b.position.set(s.px, s.py, s.pz);
      b.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      b.velocity.set(s.vx, s.vy, s.vz);
      b.angularVelocity.set(s.ax, s.ay, s.az);
      if (b.mass > 0) { b.wakeUp(); if (typeof b.updateMassProperties === "function") b.updateMassProperties(); }
    }
    robotMirrorDeskGroup.updateMatrixWorld(true);
    for (const m of mirrorGrabbables) {
      const b = m.userData.cannonBody;
      if (!b) continue;
      _mirrorWork.set(b.position.x, b.position.y, b.position.z);
      robotMirrorDeskGroup.worldToLocal(_mirrorWork);
      m.position.copy(_mirrorWork);
      m.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    }
  }
}

function addGrabbable(mesh) { mesh.userData.heldBy = null; grabbables.push(mesh); deskGroup.add(mesh); }

function makeProp(geom, color, x, y, z, physicsSpec) {
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.35 });
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.userData.physicsSpec = physicsSpec;
  addGrabbable(m);
  return m;
}

makeProp(new THREE.SphereGeometry(0.055, 28, 20), 0xf97316, -0.32, TABLE_TOP_Y + 0.055, TABLE_Z + 0.06, { type: "sphere", radius: 0.055 });
makeProp(new THREE.BoxGeometry(0.11, 0.11, 0.11), 0x22d3ee, 0.02, TABLE_TOP_Y + 0.055, TABLE_Z - 0.04, { type: "box", hx: 0.055, hy: 0.055, hz: 0.055 });
makeProp(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 24), 0xeab308, 0.32, TABLE_TOP_Y + 0.06, TABLE_Z + 0.05, { type: "cylinder", r: 0.045, h: 0.12 });
makeProp(new THREE.TorusGeometry(0.055, 0.018, 12, 28), 0xd946ef, -0.08, TABLE_TOP_Y + 0.055, TABLE_Z - 0.12, { type: "box", hx: 0.075, hy: 0.04, hz: 0.075 });

let deskPhysics = null;
let lastPhysTime = performance.now();

async function initDeskPhysics() {
  let World, Body, Box, Sphere, Cylinder, Vec3, Quaternion, Material, ContactMaterial;
  try {
    const C = await import("cannon-es");
    World = C.World; Body = C.Body; Box = C.Box; Sphere = C.Sphere; Cylinder = C.Cylinder;
    Vec3 = C.Vec3; Quaternion = C.Quaternion; Material = C.Material; ContactMaterial = C.ContactMaterial;
  } catch (e) { console.warn("cannon-es:", e); return; }

  const world = new World({ gravity: new Vec3(0, -9.82, 0) });
  world.allowSleep = true;
  const mat = new Material("desk");
  world.addContactMaterial(new ContactMaterial(mat, mat, { friction: 0.52, restitution: 0.07 }));
  const ground = new Body({ mass: 0, material: mat });
  ground.addShape(new Box(new Vec3(24, 0.04, 24)), new Vec3(0, -0.04, 0));
  world.addBody(ground);
  const tableBody = new Body({ mass: 0, material: mat });
  tableBody.addShape(new Box(new Vec3(1.35 / 2, 0.045 / 2, 0.88 / 2)), new Vec3(0, TABLE_TOP_Y - 0.0225, TABLE_Z));
  world.addBody(tableBody);
  for (const mesh of grabbables) {
    const spec = mesh.userData.physicsSpec;
    if (!spec) continue;
    const body = new Body({ mass: 0.38, material: mat, linearDamping: 0.12, angularDamping: 0.18 });
    if (spec.type === "sphere") body.addShape(new Sphere(spec.radius));
    else if (spec.type === "box") body.addShape(new Box(new Vec3(spec.hx, spec.hy, spec.hz)));
    else if (spec.type === "cylinder") {
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

let mirrorDeskPhysics = null;

const robotMirrorDeskGroup = new THREE.Group();
robotMirrorDeskGroup.name = "MirrorDeskRoot";
robotMirrorDeskGroup.position.set(0, 0, -ROBOT_STAGE_DIST);
scene.add(robotMirrorDeskGroup);

let mirrorDeskTableTop = null;

const robotStage = new THREE.Group();
scene.add(robotStage);

const robotGroup = new THREE.Group();
robotStage.add(robotGroup);

/** World MuJoCo → world stanza: posa fissa davanti al tavolo mirror (non si annulla con inv(robotStage)). */
function layoutRobotStageFromMirrorDesk() {
  robotMirrorDeskGroup.updateMatrixWorld(true);
  let px = ROBOT_STAGE_POS_DEFAULT.x;
  let py = ROBOT_STAGE_POS_DEFAULT.y;
  let pz = ROBOT_STAGE_POS_DEFAULT.z;
  let yaw = ROBOT_STAGE_YAW_DEFAULT;
  if (mirrorDeskTableTop) {
    mirrorDeskTableTop.getWorldPosition(_mirrorWork2);
    const offsetFromTable = 1.12;
    px = _mirrorWork2.x;
    py = Math.max(0.42, _mirrorWork2.y - 0.30);
    pz = _mirrorWork2.z + offsetFromTable;
  }
  robotStage.position.set(0, 0, 0);
  robotStage.rotation.set(0, 0, 0);
  robotStage.scale.set(1, 1, 1);
  try {
    const p = new URLSearchParams(window.location.search);
    const rz = parseFloat(p.get("robotz") || "");
    if (Number.isFinite(rz) && rz > -6 && rz < 3) pz = rz;
    const ry = parseFloat(p.get("roboty") || "");
    if (Number.isFinite(ry) && ry > -1.7 && ry < 2.9) py = ry;
    const yw = parseFloat(p.get("robotyaw") || "");
    if (Number.isFinite(yw) && Math.abs(yw) < 12) yaw = yw;
  } catch (_) {}
  _robotRoomPos.set(px, py, pz);
  _robotRoomPos.add(_robotUserOffset);
  yaw += THREE.MathUtils.degToRad(_robotUserYawExtraDeg);
  _robotYawQuat.setFromAxisAngle(_axisYUp, yaw);
  _robotRoomFix.compose(_robotRoomPos, _robotYawQuat, _oneScale);
  syncRobotGroupMirrorScale();
  remoteLog(
    "[robot-layout] roomFix (MuJoCo→stanza)",
    _robotRoomPos.x.toFixed(2),
    _robotRoomPos.y.toFixed(2),
    _robotRoomPos.z.toFixed(2),
    "yaw=" + yaw.toFixed(2),
    "mirrorScale=" + robotGroup.scale.x + "," + robotGroup.scale.y + "," + robotGroup.scale.z,
  );
}

function writeRobotOffsetInputsToDOM() {
  configureG1OffsetSliders();
  if (inpG1OffX) inpG1OffX.value = String(clampG1OffAxis(_robotUserOffset.x, "x"));
  if (inpG1OffY) inpG1OffY.value = String(clampG1OffAxis(_robotUserOffset.y, "y"));
  if (inpG1OffZ) inpG1OffZ.value = String(clampG1OffAxis(_robotUserOffset.z, "z"));
  if (inpG1OffYaw) inpG1OffYaw.value = String(clampG1OffAxis(_robotUserYawExtraDeg, "yaw"));
  syncG1OffsetLabelsFromSliders();
}

function readRobotOffsetInputsFromDOM() {
  const px = parseFloat(inpG1OffX?.value || "0");
  const py = parseFloat(inpG1OffY?.value || "0");
  const pz = parseFloat(inpG1OffZ?.value || "0");
  const yd = parseFloat(inpG1OffYaw?.value || "0");
  _robotUserOffset.x = clampG1OffAxis(px, "x");
  _robotUserOffset.y = clampG1OffAxis(py, "y");
  _robotUserOffset.z = clampG1OffAxis(pz, "z");
  _robotUserYawExtraDeg = clampG1OffAxis(yd, "yaw");
}

function commitG1OffsetFromUI(opts = {}) {
  readRobotOffsetInputsFromDOM();
  applyRobotRoomFixFromUI();
  saveRobotOffsetToStorage();
  if (opts.silent) return;
  const line = `xyz(${ _robotUserOffset.x.toFixed(2) }, ${ _robotUserOffset.y.toFixed(2) }, ${ _robotUserOffset.z.toFixed(2) }) m · yaw ${ Math.round(_robotUserYawExtraDeg) }°`;
  const prefix = opts.prefix != null ? String(opts.prefix) : "G1 offset salvato";
  setStatus(`${ prefix }: ${ line }`);
}

function applyRobotRoomFixFromUI() {
  layoutRobotStageFromMirrorDesk();
  if (useUnitreeViz && unitreeVizRoot && _lastSimBodies?.length) {
    applyBodiesToUnitreeViz(unitreeVizRoot, _lastSimBodies);
  } else if (_lastGeomMat4Raw?.length) {
    ingestGeomTargetsFromWs(_lastGeomMat4Raw, true);
    _lastRobotSmoothT = performance.now();
    tickRobotGeomPoseSmooth(performance.now());
  }
}

function initRobotOffsetUI() {
  if (!btnG1OffApply || !btnG1OffReset || !inpG1OffX) return;
  writeRobotOffsetInputsToDOM();
  const onSliderInput = () => syncG1OffsetLabelsFromSliders();
  const onSliderChange = () => commitG1OffsetFromUI({ prefix: "G1 offset (slider)" });
  for (const el of [inpG1OffX, inpG1OffY, inpG1OffZ, inpG1OffYaw]) {
    el?.addEventListener("input", onSliderInput);
    el?.addEventListener("change", onSliderChange);
  }
  btnG1OffApply.addEventListener("click", () => {
    commitG1OffsetFromUI({ prefix: "Applica e salva" });
  });
  btnG1OffReset.addEventListener("click", () => {
    _robotUserOffset.set(0, 0, 0);
    _robotUserYawExtraDeg = 0;
    try {
      localStorage.removeItem("g1_room_off_x");
      localStorage.removeItem("g1_room_off_y");
      localStorage.removeItem("g1_room_off_z");
      localStorage.removeItem("g1_room_off_yaw_deg");
    } catch (_) {}
    writeRobotOffsetInputsToDOM();
    applyRobotRoomFixFromUI();
    setStatus("G1 offset azzerato e salvato");
  });
}

function addMirrorGrabbable(mesh) {
  mesh.userData.heldBy = null;
  mirrorGrabbables.push(mesh);
  robotMirrorDeskGroup.add(mesh);
}

function makeMirrorProp(geom, color, x, y, z, physicsSpec) {
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.35 });
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.userData.physicsSpec = physicsSpec;
  addMirrorGrabbable(m);
  return m;
}

(function buildRobotMirrorDesk() {
  const TZ = -0.72;
  const TY = 0.82;
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a3525, roughness: 0.9, metalness: 0.04 });
  const topMat = bootQueryFlag("mirrorglass")
    ? new THREE.MeshPhysicalMaterial({
        color: 0x3d2b1f,
        roughness: 0.22,
        metalness: 0.52,
        clearcoat: 0.45,
        clearcoatRoughness: 0.32,
      })
    : wood;
  mirrorDeskTableTop = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.045, 0.88), topMat);
  mirrorDeskTableTop.position.set(0, TY - 0.0225, TZ);
  mirrorDeskTableTop.receiveShadow = true;
  robotMirrorDeskGroup.add(mirrorDeskTableTop);
  const pl = new THREE.PointLight(0xffeedd, 9, 3.2, 1.25);
  pl.position.set(0, TY + 0.48, TZ);
  robotMirrorDeskGroup.add(pl);
  makeMirrorProp(new THREE.SphereGeometry(0.055, 28, 20), 0xf97316, -0.32, TY + 0.055, TZ + 0.06, { type: "sphere", radius: 0.055 });
  makeMirrorProp(new THREE.BoxGeometry(0.11, 0.11, 0.11), 0x22d3ee, 0.02, TY + 0.055, TZ - 0.04, { type: "box", hx: 0.055, hy: 0.055, hz: 0.055 });
  makeMirrorProp(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 24), 0xeab308, 0.32, TY + 0.06, TZ + 0.05, { type: "cylinder", r: 0.045, h: 0.12 });
  makeMirrorProp(new THREE.TorusGeometry(0.055, 0.018, 12, 28), 0xd946ef, -0.08, TY + 0.055, TZ - 0.12, { type: "box", hx: 0.075, hy: 0.04, hz: 0.075 });
  layoutRobotStageFromMirrorDesk();
})();

async function initMirrorDeskPhysics() {
  if (!mirrorGrabbables.length) return;
  let World, Body, Box, Sphere, Cylinder, Vec3, Quaternion, Material, ContactMaterial;
  try {
    const C = await import("cannon-es");
    World = C.World; Body = C.Body; Box = C.Box; Sphere = C.Sphere; Cylinder = C.Cylinder;
    Vec3 = C.Vec3; Quaternion = C.Quaternion; Material = C.Material; ContactMaterial = C.ContactMaterial;
  } catch (e) { console.warn("mirror cannon-es:", e); return; }

  const world = new World({ gravity: new Vec3(0, -9.82, 0) });
  world.allowSleep = true;
  const mat = new Material("mirrorDesk");
  world.addContactMaterial(new ContactMaterial(mat, mat, { friction: 0.52, restitution: 0.07 }));
  const ground = new Body({ mass: 0, material: mat });
  ground.addShape(new Box(new Vec3(24, 0.04, 24)), new Vec3(0, -0.04, 0));
  world.addBody(ground);

  robotMirrorDeskGroup.updateMatrixWorld(true);
  if (mirrorDeskTableTop) {
    mirrorDeskTableTop.updateMatrixWorld(true);
    mirrorDeskTableTop.getWorldPosition(_mirrorWork2);
    const tableBody = new Body({ mass: 0, material: mat });
    tableBody.addShape(new Box(new Vec3(1.35 / 2, 0.045 / 2, 0.88 / 2)), new Vec3(_mirrorWork2.x, _mirrorWork2.y, _mirrorWork2.z));
    world.addBody(tableBody);
  }

  for (const mesh of mirrorGrabbables) {
    const spec = mesh.userData.physicsSpec;
    if (!spec) continue;
    mesh.updateMatrixWorld(true);
    mesh.getWorldPosition(_mirrorWork);
    mesh.getWorldQuaternion(_worldQuatTmp);
    const body = new Body({ mass: 0.38, material: mat, linearDamping: 0.12, angularDamping: 0.18 });
    if (spec.type === "sphere") body.addShape(new Sphere(spec.radius));
    else if (spec.type === "box") body.addShape(new Box(new Vec3(spec.hx, spec.hy, spec.hz)));
    else if (spec.type === "cylinder") {
      const q = new Quaternion().setFromAxisAngle(new Vec3(1, 0, 0), Math.PI / 2);
      body.addShape(new Cylinder(spec.r, spec.r, spec.h, 10), new Vec3(0, 0, 0), q);
    } else continue;
    body.position.set(_mirrorWork.x, _mirrorWork.y, _mirrorWork.z);
    body.quaternion.set(_worldQuatTmp.x, _worldQuatTmp.y, _worldQuatTmp.z, _worldQuatTmp.w);
    world.addBody(body);
    mesh.userData.cannonBody = body;
  }
  mirrorDeskPhysics = { world, Body };
  captureMirrorDeskPhysicsRestState();
}
void initMirrorDeskPhysics();

let robotMeshes = [];

let passthroughWanted = false;
let _xrBlendMode = "opaque";

/** Solo `immersive-ar` va composto con alpha; in `immersive-vr` il clear trasparente rompe spesso una lente (Quest). */
function isImmersiveArSession() {
  try {
    return renderer.xr?.getSession?.()?.mode === "immersive-ar";
  } catch {
    return false;
  }
}

function applyPassthroughVisuals() {
  const presenting = !!renderer.xr?.isPresenting;
  const ar = presenting && isImmersiveArSession();
  if (ar) {
    gridHelper.visible = false;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
  } else if (presenting) {
    gridHelper.visible = true;
    scene.background = BG_NORMAL.clone();
    renderer.setClearColor(0x000000, 1);
  } else {
    gridHelper.visible = true;
    scene.background = BG_NORMAL.clone();
    renderer.setClearColor(0x000000, 1);
  }
  deskGroup.visible = true;
  robotStage.visible = true;
  robotGroup.visible = true;
  robotMirrorDeskGroup.visible = true;
  try {
    if (stickLines?.material) stickLines.material.opacity = ar ? 1 : 0.92;
    if (stickLinesMirror?.material) stickLinesMirror.material.opacity = ar ? 0.98 : 0.9;
    if (stickPoints?.material) stickPoints.material.size = ar ? 0.032 : 0.028;
    if (stickPointsMirror?.material) stickPointsMirror.material.size = ar ? 0.03 : 0.026;
  } catch (_) {}
}
chkPassthrough?.addEventListener("change", () => { passthroughWanted = !!chkPassthrough.checked; applyPassthroughVisuals(); });

function tuneHandMeshMaterial(o) {
  if (!o.isMesh || !o.material) return;
  if (o.isSkinnedMesh) {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.skinning = true;
      m.needsUpdate = true;
    }
    o.frustumCulled = false;
    return;
  }
  const prev = Array.isArray(o.material) ? o.material[0] : o.material;
  const mat = new THREE.MeshStandardMaterial({
    color: prev.color?.getHex?.() ?? 0xc4b8a8,
    roughness: 0.42,
    metalness: 0.12,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -0.5,
  });
  if (prev.map?.image) mat.map = prev.map;
  o.material = Array.isArray(o.material) ? [mat] : mat;
  o.castShadow = true;
  o.receiveShadow = true;
}

class XrHandVisualShell extends THREE.Object3D {
  constructor(controller) {
    super();
    this.controller = controller;
    this.motionController = null;
  }
  updateMatrixWorld(force) {
    super.updateMatrixWorld(force);
    if (!this.motionController) return;
    try {
      this.motionController.updateMesh();
    } catch (_) {}
  }
}

let _xrHandFactory = null;
const _xrHandModelBySide = { left: null, right: null };

function _xrHandIndexForHandedness(handedness) {
  if (handedness === "left") return 0;
  if (handedness === "right") return 1;
  return -1;
}

function syncXrHandVisibility(session) {
  if (!session?.inputSources) return;
  for (let i = 0; i < 2; i++) {
    try {
      renderer.xr.getHand(i).visible = false;
    } catch (_) {}
  }
  for (const src of session.inputSources) {
    if (!src.hand) continue;
    const idx = _xrHandIndexForHandedness(src.handedness);
    if (idx < 0) continue;
    try {
      const hand = renderer.xr.getHand(idx);
      hand.visible = true;
    } catch (_) {}
  }
}

function onXrInputSourcesChange(session, ev) {
  const added = [...(ev?.added || [])].map((s) => ({ hand: s.handedness, hasHand: !!s.hand, profiles: s.profiles }));
  const removed = [...(ev?.removed || [])].map((s) => ({ hand: s.handedness }));
  remoteLog("[xr] inputsourceschange added=" + JSON.stringify(added), "removed=" + JSON.stringify(removed));
  syncXrHandVisibility(session);
}

async function setupXrInteraction() {
  try {
    for (let i = 0; i < 2; i++) {
      const xrCtrl = renderer.xr.getController(i);
      const rayGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -0.28),
      ]);
      const rayLine = new THREE.Line(
        rayGeom,
        new THREE.LineBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.88 }),
      );
      rayLine.name = "xrControllerRayHint";
      rayLine.frustumCulled = false;
      rayLine.visible = true;
      xrCtrl.add(rayLine);
      scene.add(xrCtrl);
      const grip = renderer.xr.getControllerGrip(i);
      scene.add(grip);
      const hand = renderer.xr.getHand(i);
      scene.add(hand);
      hand.scale.setScalar(1.04);
    }

    const { XRHandModelFactory } = await import("three/addons/webxr/XRHandModelFactory.js");
    _xrHandFactory = new XRHandModelFactory().setPath("/static/hand-xr/");
    const questHands = isQuestLikeClient();
    const handProfile = questHands ? "mesh" : "spheres";

    for (let i = 0; i < 2; i++) {
      const hand = renderer.xr.getHand(i);
      const side = i === 0 ? "left" : "right";
      const handModel = _xrHandFactory.createHandModel(hand, handProfile);
      hand.add(handModel);
      _xrHandModelBySide[side] = handModel;
      hand.addEventListener("disconnected", () => {
        hand.visible = false;
      });
    }
    for (let i = 0; i < 2; i++) {
      try {
        renderer.xr.getController(i).visible = false;
        renderer.xr.getControllerGrip(i).visible = false;
      } catch (_) {}
    }
    remoteLog("[xr] mani:", questHands ? "mesh hand-xr GLB" : "primitive spheres", "path=/static/hand-xr/");
  } catch (e) {
    console.warn("XR modelli (opzionale):", e);
    remoteLog("[xr] setupXrInteraction error", String(e?.message || e));
  }
}

/** One-shot: enable GPU skinning on hand-xr GLB SkinnedMesh; do not touch bind pose or materials. */
function polishXrHandMeshes() {
  try {
    for (let i = 0; i < 2; i++) {
      renderer.xr.getHand(i).traverse((o) => {
        if (!o.isSkinnedMesh || o.userData._handPolish) return;
        o.userData._handPolish = true;
        o.frustumCulled = false;
        o.renderOrder = 15;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          m.skinning = true;
          m.needsUpdate = true;
        }
      });
    }
  } catch (e) {
    remoteLog("[xr] polishXrHandMeshes", String(e?.message || e));
  }
}

function meshEntryToGeometry(m) {
  const name = m.name || "?";
  const vSrc = m.v;
  if (!vSrc || !Array.isArray(vSrc) || vSrc.length < 9 || vSrc.length % 3 !== 0) {
    throw new Error(`mesh ${name}: position invalid (len=${vSrc?.length})`);
  }
  const pos = new Float32Array(vSrc.length);
  for (let i = 0; i < vSrc.length; i++) {
    const x = Number(vSrc[i]);
    if (!Number.isFinite(x)) throw new Error(`mesh ${name}: non-finite vertex @${i}`);
    pos[i] = x;
  }
  const nVerts = pos.length / 3;
  const raw = Array.isArray(m?.i?.[0]) ? m.i.flat() : Array.isArray(m.i) ? m.i : [];
  if (raw.length === 0 || raw.length % 3 !== 0) {
    throw new Error(`mesh ${name}: index invalid (len=${raw.length})`);
  }
  let maxI = 0;
  for (let j = 0; j < raw.length; j++) {
    const ix = raw[j] | 0;
    if (ix < 0 || ix >= nVerts) {
      throw new Error(`mesh ${name}: index OOB j=${j} ix=${ix} nVerts=${nVerts}`);
    }
    if (ix > maxI) maxI = ix;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const ia = maxI > 65535 ? Uint32Array.from(raw) : Uint16Array.from(raw);
  // setIndex(TypedArray) lascia index come raw array: WebGLAttributes.createBuffer legge .array → undefined → byteLength crash.
  g.setIndex(
    maxI > 65535 ? new THREE.Uint32BufferAttribute(ia, 1) : new THREE.Uint16BufferAttribute(ia, 1),
  );
  g.computeVertexNormals();
  return g;
}

function _robotMeshMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xb8c8d8,
    emissive: 0x334155,
    emissiveIntensity: 0.55,
    roughness: 0.5,
    metalness: 0.18,
    side: THREE.DoubleSide,
  });
}

function _disposeThreeSubtree(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    try {
      o.geometry?.dispose?.();
    } catch (_) {}
    const mat = o.material;
    if (Array.isArray(mat)) {
      for (const m of mat) {
        try {
          m?.dispose?.();
        } catch (_) {}
      }
    } else {
      try {
        mat?.dispose?.();
      } catch (_) {}
    }
  });
}

/** Svuota robotGroup (mesh MuJoCo + eventuale GLB/FBX), resetta cache pose Unitree. */
function disposeRobotMeshesAndClearGroup() {
  while (robotGroup.children.length > 0) {
    const c = robotGroup.children[0];
    robotGroup.remove(c);
    _disposeThreeSubtree(c);
  }
  robotMeshes = [];
  unitreeVizRoot = null;
  useUnitreeViz = false;
  unitreeBodyNodeMap = null;
  unitreeNodeOrigScale = null;
  unitreeCalibOffset = null;
  _wristMeshByKey = null;
  _geomWorldCount = 0;
  _geomSmoothPrimed = false;
  _lastRobotSmoothT = 0;
  _lastGeomMat4Raw = null;
}

/** Come main: 1 sola richiesta (OK su Quest). Forza vecchio metodo con ?pieces=1 o ?meshmode=piece */
async function loadRobotMeshes() {
  disposeRobotMeshesAndClearGroup();

  let forcePieces = false;
  try {
    const p = new URLSearchParams(window.location.search);
    forcePieces = p.get("pieces") === "1" || p.get("meshmode") === "piece";
  } catch (_) {}

  if (!forcePieces) {
    try {
      setStatus("Carico mesh G1 (scarico unico, come main)…");
      const bulkTimeoutMs = isQuestLikeClient() ? 90000 : 120000;
      const r = await fetchWithTimeout(`${API()}/api/g1_viz_meshes`, {}, bulkTimeoutMs);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      const list = data.meshes || [];
      if (!list.length) throw new Error("meshes vuoto");
      const mat = _robotMeshMaterial();
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        try {
          const geom = meshEntryToGeometry(m);
          const mesh = new THREE.Mesh(geom, mat.clone());
          mesh.matrixAutoUpdate = false;
          mesh.frustumCulled = false;
          mesh.matrix.identity();
          mesh.name = m.name || `g1_${i}`;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          robotGroup.add(mesh);
          robotMeshes.push(mesh);
        } catch (e) {
          console.warn("mesh", i, e);
          remoteLog("[mesh] SKIP", i, m?.name, String(e?.message || e));
          robotMeshes.push(null);
        }
      }
      const okMeshes = robotMeshes.filter(Boolean).length;
      remoteLog("[mesh] g1_viz_meshes list=" + list.length + " built=" + okMeshes);
      if (okMeshes > 0) {
        cacheWristMeshesForHandGrid();
        return true;
      }
      if (list.length > 0) {
        remoteLog("[mesh] bulk: 0 mesh valide, fallback pezzi");
        robotMeshes = [];
      }
    } catch (e) {
      console.warn("g1_viz_meshes", e);
      remoteLog("[mesh] bulk fallito, uso pezzi", String(e?.message || e));
      robotMeshes = [];
      if (isQuestLikeClient()) {
        setStatus("G1: scarico unico fallito — provo a pezzi (Quest)…");
      }
    }
  }

  try {
    setStatus("Carico G1 a pezzi (49 richieste, lento su Quest)…");
    const rc = await fetchWithTimeout(`${API()}/api/g1_mesh_count`, {}, 20000);
    if (!rc.ok) throw new Error(`HTTP ${rc.status}`);
    const cj = await rc.json();
    const count = cj.count ?? 0;
    if (!count || cj.error) throw new Error(cj.error || "count 0");
    setStatus(`G1: ${count} parti…`);
    const mat = _robotMeshMaterial();
    for (let idx = 0; idx < count; idx++) {
      const pr = await fetchWithTimeout(`${API()}/api/g1_mesh_piece/${idx}`, {}, 60000);
      if (!pr.ok) throw new Error(`piece ${idx} HTTP ${pr.status}`);
      const m = await pr.json();
      if (m.error) throw new Error(m.error);
      try {
        const geom = meshEntryToGeometry(m);
        const mesh = new THREE.Mesh(geom, mat.clone());
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        mesh.matrix.identity();
        mesh.name = m.name || `g1_${idx}`;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        robotGroup.add(mesh);
        robotMeshes.push(mesh);
      } catch (e) {
        console.warn("piece", idx, e);
        remoteLog("[mesh] SKIP piece", idx, m?.name, String(e?.message || e));
        robotMeshes.push(null);
      }
      if (idx % 6 === 0) setStatus(`G1: ${idx + 1}/${count}…`);
      if (idx % 2 === 1) await new Promise((res) => setTimeout(res, 0));
    }
    const builtPieces = robotMeshes.filter(Boolean).length;
    remoteLog("[mesh] piece path built=" + builtPieces + "/" + count);
    if (builtPieces > 0) cacheWristMeshesForHandGrid();
    return builtPieces > 0;
  } catch (e) {
    console.warn("g1_mesh_piece", e);
    setStatus(`G1: ${e.message || e} — tavoli e scena attivi.`);
    return false;
  }
}

function meshMatrixFromWorldGeom(worldMat, outMat) {
  outMat.multiplyMatrices(_matInvRobotStage, worldMat);
}

function ingestGeomTargetsFromWs(geomMat4List, snapSmooth) {
  if (!geomMat4List?.length) return;
  _lastGeomMat4Raw = geomMat4List.map((row) => Array.from(row));
  const n = geomMat4List.length;
  while (_geomWTarget.length < n) {
    _geomWTarget.push(new THREE.Matrix4());
    _geomWSmooth.push(new THREE.Matrix4());
  }
  if (_geomWTarget.length > n) {
    _geomWTarget.length = n;
    _geomWSmooth.length = n;
    _geomSmoothPrimed = false;
  }
  _geomWorldCount = n;
  for (let i = 0; i < n; i++) {
    _matWorld.fromArray(geomMat4List[i]);
    applyGeomRoomWorldTransform(_matWorld, _geomWTarget[i]);
  }
  if (snapSmooth || !_geomSmoothPrimed) {
    for (let i = 0; i < n; i++) _geomWSmooth[i].copy(_geomWTarget[i]);
    _geomSmoothPrimed = true;
  }
}

function tickRobotGeomPoseSmooth(timeMs) {
  if (useUnitreeViz || !robotMeshes.length || !_geomWorldCount) return;
  const now = typeof timeMs === "number" && timeMs > 0 ? timeMs : performance.now();
  if (!_lastRobotSmoothT) _lastRobotSmoothT = now;
  const dt = Math.min(0.08, Math.max(0, (now - _lastRobotSmoothT) / 1000));
  _lastRobotSmoothT = now;
  if (!robotPoseSmoothEnabled()) {
    for (let i = 0; i < _geomWorldCount; i++) _geomWSmooth[i].copy(_geomWTarget[i]);
  } else {
    const alpha = 1 - Math.exp(-dt * 14);
    for (let i = 0; i < _geomWorldCount; i++) {
      _geomWSmooth[i].decompose(_geomLerpPosS, _geomLerpQuatS, _geomLerpSclS);
      _geomWTarget[i].decompose(_geomLerpPosT, _geomLerpQuatT, _geomLerpSclT);
      _geomLerpPosS.lerp(_geomLerpPosT, alpha);
      _geomLerpQuatS.slerp(_geomLerpQuatT, alpha);
      _geomWSmooth[i].compose(_geomLerpPosS, _geomLerpQuatS, _geomLerpSclT);
    }
  }
  robotStage.updateWorldMatrix(true, false);
  _matInvRobotStage.copy(robotStage.matrixWorld).invert();
  const n = Math.min(_geomWorldCount, robotMeshes.length);
  for (let i = 0; i < n; i++) {
    const mesh = robotMeshes[i];
    if (!mesh) continue;
    meshMatrixFromWorldGeom(_geomWSmooth[i], mesh.matrix);
    mesh.updateMatrixWorld(true);
  }
}

async function syncRobotPoseFromRest() {
  try {
    const r = await fetchWithTimeout(`${API()}/api/sim_state`, {}, 15000);
    const data = await r.json();
    if (useUnitreeViz && unitreeVizRoot && data.sim?.bodies) {
      applyBodiesToUnitreeViz(unitreeVizRoot, data.sim.bodies);
    } else if (data.sim?.geom_mat4) {
      applyRobotMatrices(data.sim.geom_mat4);
    }
  } catch (e) { console.warn("sim_state", e); }
}

function applyRobotMatrices(geomMat4List) {
  if (!geomMat4List?.length || !robotMeshes.length) return;
  ingestGeomTargetsFromWs(geomMat4List, true);
  robotStage.updateWorldMatrix(true, false);
  _matInvRobotStage.copy(robotStage.matrixWorld).invert();
  const n = Math.min(_geomWorldCount, robotMeshes.length);
  for (let i = 0; i < n; i++) {
    const mesh = robotMeshes[i];
    if (!mesh) continue;
    meshMatrixFromWorldGeom(_geomWSmooth[i], mesh.matrix);
    mesh.updateMatrixWorld(true);
  }
  _lastRobotSmoothT = performance.now();
}

function normalizeBodyKey(name) {
  return String(name).replace(/^[\w.-]+:/, "").trim().toLowerCase();
}

function buildBodyMatMap(bodiesArr) {
  const m = new Map();
  for (const b of bodiesArr || []) {
    if (!b?.name || !b?.mat4) continue;
    m.set(normalizeBodyKey(b.name), b.mat4);
  }
  return m;
}

async function runUnitreeVizMenagerieAudit(vizRoot, nodeMap, bodyNamesSet) {
  try {
    const r = await fetch(`${API()}/api/mujoco_bodies`);
    const d = await r.json();
    const menagerie = (d.bodies || []).map(normalizeBodyKey).filter(Boolean);
    const all = new Set(menagerie);
    const inViz = new Set(nodeMap.keys());
    const missingInViz = menagerie.filter((k) => !inViz.has(k));
    if (missingInViz.length) {
      console.warn(
        `[UnitreeViz-audit] ${missingInViz.length} corpi Menagerie senza nodo asset (primi 50):`,
        missingInViz.slice(0, 50).join(", ")
      );
    }
    const robotLike = /link|joint|hand|wrist|finger|thumb|shoulder|elbow|pelvis|torso|waist|knee|ankle|hip/i;
    const orphanViz = [];
    vizRoot.updateMatrixWorld(true);
    vizRoot.traverse((o) => {
      const nm = o.name;
      if (!nm || !robotLike.test(nm)) return;
      const k = normalizeBodyKey(nm);
      if (all.has(k)) return;
      if (!orphanViz.includes(nm)) orphanViz.push(nm);
    });
    if (orphanViz.length) {
      console.warn("[UnitreeViz-audit] Oggetti asset robot-like non in elenco Menagerie (max 40):", orphanViz.slice(0, 40).join(", "));
    }
    const snapUnmatched = [...bodyNamesSet].filter((k) => !inViz.has(k));
    if (snapUnmatched.length) {
      console.warn("[UnitreeViz-audit] Body nello snapshot attuale senza match:", snapUnmatched.join(", "));
    }
    remoteLog(
      "[UnitreeViz-audit] menagerieBodies=" + menagerie.length,
      "vizMatched=" + nodeMap.size,
      "missingInViz=" + missingInViz.length
    );
  } catch (e) {
    console.warn("[UnitreeViz-audit] /api/mujoco_bodies:", e);
  }
}

function cacheUnitreeBodyNodes(vizRoot, bodiesArr) {
  if (unitreeBodyNodeMap) return;
  const bodyNames = new Set();
  for (const b of bodiesArr) {
    if (b?.name) bodyNames.add(normalizeBodyKey(b.name));
  }

  vizRoot.updateMatrixWorld(true);

  const nodeMap = new Map();
  const scaleMap = new Map();
  const restWorldMap = new Map();
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();

  vizRoot.traverse((o) => {
    const key = normalizeBodyKey(o.name);
    if (bodyNames.has(key) && !nodeMap.has(key)) {
      nodeMap.set(key, o);
      o.matrix.decompose(_p, _q, _s);
      scaleMap.set(key, _s.clone());
      restWorldMap.set(key, o.matrixWorld.clone());
    }
  });

  unitreeBodyNodeMap = nodeMap;
  unitreeNodeOrigScale = scaleMap;

  const mjMap = buildBodyMatMap(bodiesArr);
  const calibMap = new Map();
  const _mj = new THREE.Matrix4(), _mjInv = new THREE.Matrix4();

  for (const [key, vizW] of restWorldMap) {
    const mjArr = mjMap.get(key);
    if (!mjArr) continue;
    _mj.fromArray(mjArr);
    _mjInv.copy(_mj).invert();
    calibMap.set(key, new THREE.Matrix4().multiplyMatrices(_mjInv, vizW));
  }
  unitreeCalibOffset = calibMap;

  console.log(`[UnitreeViz] Cache: ${nodeMap.size} nodes matched, ${calibMap.size} calibrated`);
  const unmatched = [...bodyNames].filter((k) => !nodeMap.has(k));
  if (unmatched.length) console.log(`[UnitreeViz] Unmatched MuJoCo bodies:`, unmatched.join(", "));
  void runUnitreeVizMenagerieAudit(vizRoot, nodeMap, bodyNames);
}

function applyBodiesToUnitreeViz(vizRoot, bodiesArr) {
  if (!vizRoot || !bodiesArr?.length) return;
  if (!unitreeBodyNodeMap) cacheUnitreeBodyNodes(vizRoot, bodiesArr);
  if (!unitreeBodyNodeMap?.size) return;

  const map = buildBodyMatMap(bodiesArr);
  if (!map.size) return;

  for (const [key, node] of unitreeBodyNodeMap) {
    const arr = map.get(key);
    if (!arr) continue;

    _fbxTargetWorld.fromArray(arr);

    const offset = unitreeCalibOffset?.get(key);
    if (offset) {
      _fbxCalibTarget.multiplyMatrices(_fbxTargetWorld, offset);
    } else {
      _fbxCalibTarget.copy(_fbxTargetWorld);
    }
    applyBodyRoomWorldTransform(_fbxCalibTarget, _fbxCalibTarget);

    if (node.parent) {
      node.parent.updateMatrixWorld(true);
      _fbxParentInv.copy(node.parent.matrixWorld).invert();
      _fbxLocalMat.multiplyMatrices(_fbxParentInv, _fbxCalibTarget);
    } else {
      _fbxLocalMat.copy(_fbxCalibTarget);
    }

    _fbxLocalMat.decompose(_fbxDecompPos, _fbxDecompQuat, _fbxDecompScl);
    const origScale = unitreeNodeOrigScale?.get(key) || _fbxDecompScl;

    node.matrix.compose(_fbxDecompPos, _fbxDecompQuat, origScale);
    node.matrixAutoUpdate = false;
    node.updateMatrixWorld(true);
  }
}

function _prepareUnitreeVizMeshes(model) {
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    o.castShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (mat?.isMeshStandardMaterial) {
        mat.side = THREE.DoubleSide;
        mat.needsUpdate = true;
      }
    }
  });
}

function _unitreeVizAutoScale(model, label) {
  const rawBox = new THREE.Box3().setFromObject(model);
  const rawSz = new THREE.Vector3();
  rawBox.getSize(rawSz);
  const rawHeight = rawSz.y;
  console.log(`[${label}] Raw BBox: ${rawSz.x.toFixed(2)} x ${rawSz.y.toFixed(2)} x ${rawSz.z.toFixed(2)}`);
  if (rawHeight > 3) {
    const autoScale = G1_EXPECTED_HEIGHT / rawHeight;
    model.scale.setScalar(autoScale);
    console.log(`[${label}] Auto-scale: ${autoScale.toFixed(5)} (raw height ${rawHeight.toFixed(1)} → ${G1_EXPECTED_HEIGHT}m)`);
  } else {
    console.log(`[${label}] Height ${rawHeight.toFixed(3)}m looks correct, no auto-scale`);
  }
}

async function tryLoadUnitreeGlb() {
  try {
    const probe = await fetch(`${API()}${UNITREE_GLB_PATH}`, { method: "HEAD" });
    if (!probe.ok) return false;
  } catch {
    return false;
  }
  try {
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    setStatus("Caricamento GLB Unitree G1…");
    const gltf = await new Promise((resolve, reject) => {
      loader.load(`${API()}${UNITREE_GLB_PATH}`, resolve, undefined, reject);
    });
    const model = gltf.scene;
    _unitreeVizAutoScale(model, "GLB");
    _prepareUnitreeVizMeshes(model);
    robotGroup.add(model);
    unitreeVizRoot = model;
    unitreeBodyNodeMap = null;
    unitreeNodeOrigScale = null;
    unitreeCalibOffset = null;
    let nodeCount = 0, meshCount = 0;
    model.traverse((o) => { nodeCount++; if (o.isMesh) meshCount++; });
    console.log(`[GLB] ${nodeCount} nodes, ${meshCount} meshes`);
    return true;
  } catch (e) {
    console.warn("Unitree GLB:", e);
    unitreeVizRoot = null;
    return false;
  }
}

async function tryLoadUnitreeFbx() {
  try {
    const probe = await fetch(`${API()}${UNITREE_FBX_PATH}`, { method: "HEAD" });
    if (!probe.ok) return false;
  } catch {
    return false;
  }
  try {
    const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
    const loader = new FBXLoader();
    setStatus("Caricamento FBX Unitree G1 (file grande, attendere)…");
    const model = await new Promise((resolve, reject) => {
      loader.load(`${API()}${UNITREE_FBX_PATH}`, resolve, undefined, reject);
    });
    _unitreeVizAutoScale(model, "FBX");
    _prepareUnitreeVizMeshes(model);
    robotGroup.add(model);
    unitreeVizRoot = model;
    unitreeBodyNodeMap = null;
    unitreeNodeOrigScale = null;
    unitreeCalibOffset = null;
    let nodeCount = 0, meshCount = 0;
    model.traverse((o) => { nodeCount++; if (o.isMesh) meshCount++; });
    console.log(`[FBX] ${nodeCount} nodes, ${meshCount} meshes`);
    return true;
  } catch (e) {
    console.warn("Unitree FBX:", e);
    unitreeVizRoot = null;
    return false;
  }
}

/**
 * L/R per server IK: con mirror X attivo (default) scambia le etichette così la mano fisica
 * guida il braccio visivamente corretto. ?noswaphands=1 disattiva.
 */
function swapHandsLrForTeleop(hands) {
  if (!hands || !robotPoseMirrorXEnabled() || bootQueryFlag("noswaphands")) return hands || {};
  return { left: hands.right ?? null, right: hands.left ?? null };
}

/** Mirror IK swaps hand labels; finger actuators stay anatomical (robotGroup mirror already flips visuals). */
function teleopLrSwapActive() {
  return robotPoseMirrorXEnabled() && !bootQueryFlag("noswaphands");
}

/** XR physical side → server teleop label (left/right in WS payload). */
function xrSideToTeleopSide(xrSide) {
  if (!teleopLrSwapActive()) return xrSide;
  return xrSide === "left" ? "right" : "left";
}

/** Raw XR finger curl for one server teleop side. */
function fingersRawForTeleopSide(fingersRaw, teleopSide) {
  if (!fingersRaw) return null;
  if (teleopLrSwapActive()) {
    return teleopSide === "left" ? fingersRaw.right ?? null : fingersRaw.left ?? null;
  }
  return fingersRaw[teleopSide] ?? null;
}

function robotWristNameForXrSide(xrSide) {
  const teleopSide = xrSideToTeleopSide(xrSide);
  return teleopSide === "left" ? "left_wrist_yaw_link" : "right_wrist_yaw_link";
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

function quatDeltaToAngVel(qPrev, qCurr, dt, outVec3) {
  if (dt < 1e-4) { outVec3.set(0, 0, 0); return; }
  _qAngPrevInv.copy(qPrev).invert();
  _qAngDel.multiplyQuaternions(qCurr, _qAngPrevInv);
  let w = _qAngDel.w, x = _qAngDel.x, y = _qAngDel.y, z = _qAngDel.z;
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const s = Math.max(1e-8, w);
  const k = (2 / s) / dt;
  outVec3.set(x * k, y * k, z * k);
}

function syncHeldBody(mesh, mid, quat) {
  const b = mesh.userData.cannonBody;
  if (!b || !deskPhysics) return;
  b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
  b.type = deskPhysics.Body.KINEMATIC;
  b.position.set(mid.x, mid.y, mid.z);
  if (quat) b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
}

function syncHeldBodyMirror(mesh, worldPos, quat) {
  const b = mesh.userData.cannonBody;
  if (!b || !mirrorDeskPhysics) return;
  b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
  b.type = mirrorDeskPhysics.Body.KINEMATIC;
  b.position.set(worldPos.x, worldPos.y, worldPos.z);
  if (quat) b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
  _mirrorWork.copy(worldPos);
  robotMirrorDeskGroup.worldToLocal(_mirrorWork);
  mesh.position.copy(_mirrorWork);
  if (quat) mesh.quaternion.copy(quat);
}

function releaseBodyMirror(mesh, throwVel = null, throwAngVel = null) {
  const b = mesh.userData.cannonBody;
  if (!b || !mirrorDeskPhysics) return;
  b.type = mirrorDeskPhysics.Body.DYNAMIC;
  if (throwVel) {
    const maxV = 7;
    const sp = Math.hypot(throwVel.x, throwVel.y, throwVel.z);
    const s = sp > maxV ? maxV / sp : 1;
    b.velocity.set(throwVel.x * s, throwVel.y * s, throwVel.z * s);
  } else b.velocity.set(0, 0, 0);
  if (throwAngVel) {
    const maxW = 22;
    const sp = Math.hypot(throwAngVel.x, throwAngVel.y, throwAngVel.z);
    const s = sp > maxW ? maxW / sp : 1;
    b.angularVelocity.set(throwAngVel.x * s, throwAngVel.y * s, throwAngVel.z * s);
  } else b.angularVelocity.set(0, 0, 0);
  b.wakeUp();
}

function releaseBody(mesh, throwVel = null, throwAngVel = null) {
  const b = mesh.userData.cannonBody;
  if (!b || !deskPhysics) return;
  b.type = deskPhysics.Body.DYNAMIC;
  if (throwVel) {
    const maxV = 7;
    const sp = Math.hypot(throwVel.x, throwVel.y, throwVel.z);
    const s = sp > maxV ? maxV / sp : 1;
    b.velocity.set(throwVel.x * s, throwVel.y * s, throwVel.z * s);
  } else b.velocity.set(0, 0, 0);
  if (throwAngVel) {
    const maxW = 22;
    const sp = Math.hypot(throwAngVel.x, throwAngVel.y, throwAngVel.z);
    const s = sp > maxW ? maxW / sp : 1;
    b.angularVelocity.set(throwAngVel.x * s, throwAngVel.y * s, throwAngVel.z * s);
  } else b.angularVelocity.set(0, 0, 0);
  b.wakeUp();
}

function resetGrabTracking(st) {
  st.prevGrabT = 0; st.grabVel.set(0, 0, 0);
  st.prevWristT = 0; st.grabAngVel.set(0, 0, 0);
}

function updatePinchGrab(frame, refSpace) {
  if (!grabInteractionWanted() || !frame || !refSpace) return;
  const session = frame.session;
  const PINCH = 0.048, GRAB_R = 0.13;
  for (const side of ["left", "right"]) {
    const st = pinchState[side];
    if (!st.mesh) continue;
    let stillPinch = false;
    for (const src of session.inputSources) {
      if (handSide(src) !== side || !src.hand) continue;
      const thumb = src.hand.get("thumb-tip"), index = src.hand.get("index-finger-tip");
      if (!thumb || !index) continue;
      const pt = frame.getJointPose(thumb, refSpace), pi = frame.getJointPose(index, refSpace);
      if (!pt?.transform?.position || !pi?.transform?.position) continue;
      _vThumb.set(pt.transform.position.x, pt.transform.position.y, pt.transform.position.z);
      _vIndex.set(pi.transform.position.x, pi.transform.position.y, pi.transform.position.z);
      if (_vThumb.distanceTo(_vIndex) >= PINCH) continue;
      stillPinch = true;
      _vMid.copy(_vThumb).add(_vIndex).multiplyScalar(0.5);
      const now = performance.now();
      if (st.prevGrabT > 0) {
        const dt = (now - st.prevGrabT) / 1000;
        if (dt > 1e-4 && dt < 0.12) { _vGrabDelta.copy(_vMid).sub(st.prevGrabMid).divideScalar(dt); st.grabVel.lerp(_vGrabDelta, 0.55); }
      }
      st.prevGrabMid.copy(_vMid); st.prevGrabT = now;
      break;
    }
    if (stillPinch) {
      st.mesh.position.copy(_vMid);
      if (readWristQuaternion(frame, refSpace, side, st.wristQuat)) {
        st.mesh.quaternion.copy(st.wristQuat).multiply(st.grabQuatOff);
        const nowW = performance.now();
        if (st.prevWristT > 0) {
          const dtW = (nowW - st.prevWristT) / 1000;
          if (dtW > 1e-4 && dtW < 0.12) { quatDeltaToAngVel(st.prevWristQuat, st.wristQuat, dtW, _vAngDelta); st.grabAngVel.lerp(_vAngDelta, 0.5); }
        }
        st.prevWristQuat.copy(st.wristQuat); st.prevWristT = nowW;
      }
      syncHeldBody(st.mesh, _vMid, st.mesh.quaternion);
    }
    if (!stillPinch) {
      releaseBody(st.mesh, st.grabVel, st.grabAngVel);
      resetGrabTracking(st); st.mesh.userData.heldBy = null; st.mesh = null;
    }
  }
  for (const src of session.inputSources) {
    const side = handSide(src);
    if (!side || !src.hand) continue;
    if (pinchState[side].mesh) continue;
    const thumb = src.hand.get("thumb-tip"), index = src.hand.get("index-finger-tip");
    if (!thumb || !index) continue;
    const pt = frame.getJointPose(thumb, refSpace), pi = frame.getJointPose(index, refSpace);
    if (!pt?.transform?.position || !pi?.transform?.position) continue;
    _vThumb.set(pt.transform.position.x, pt.transform.position.y, pt.transform.position.z);
    _vIndex.set(pi.transform.position.x, pi.transform.position.y, pi.transform.position.z);
    if (_vThumb.distanceTo(_vIndex) >= PINCH) continue;
    _vMid.copy(_vThumb).add(_vIndex).multiplyScalar(0.5);
    let best = null, bestD = GRAB_R;
    for (const obj of grabbables) {
      if (obj.userData.heldBy && obj.userData.heldBy !== side) continue;
      const d = _vMid.distanceTo(obj.position);
      if (d < bestD) { bestD = d; best = obj; }
    }
    if (best) {
      best.userData.heldBy = side;
      const st = pinchState[side];
      resetGrabTracking(st); st.mesh = best;
      best.position.copy(_vMid); st.prevGrabMid.copy(_vMid); st.prevGrabT = performance.now();
      if (readWristQuaternion(frame, refSpace, side, st.wristQuat)) {
        st.grabQuatOff.copy(st.wristQuat).invert().multiply(best.quaternion);
        st.prevWristQuat.copy(st.wristQuat); st.prevWristT = performance.now();
        best.quaternion.copy(st.wristQuat).multiply(st.grabQuatOff);
      } else st.grabQuatOff.identity();
      syncHeldBody(best, _vMid, best.quaternion);
    }
  }
}

function updatePinchGrabMirror(frame, refSpace) {
  if (!grabInteractionWanted() || !mirrorDeskInteractionWanted() || !mirrorDeskPhysics?.world || !frame || !refSpace) return;
  if (!_headBasisFromFrame(frame, refSpace)) return;
  const session = frame.session;
  const PINCH = 0.048, GRAB_R = 0.13;
  for (const side of ["left", "right"]) {
    const st = pinchStateMirror[side];
    if (!st.mesh) continue;
    let stillPinch = false;
    for (const src of session.inputSources) {
      if (handSide(src) !== side || !src.hand) continue;
      const thumb = src.hand.get("thumb-tip"), index = src.hand.get("index-finger-tip");
      if (!thumb || !index) continue;
      const pt = frame.getJointPose(thumb, refSpace), pi = frame.getJointPose(index, refSpace);
      if (!pt?.transform?.position || !pi?.transform?.position) continue;
      _vThumb.set(pt.transform.position.x, pt.transform.position.y, pt.transform.position.z);
      _vIndex.set(pi.transform.position.x, pi.transform.position.y, pi.transform.position.z);
      if (_vThumb.distanceTo(_vIndex) >= PINCH) continue;
      stillPinch = true;
      _vMid.copy(_vThumb).add(_vIndex).multiplyScalar(0.5);
      _mirrorPointRefSpace(_vMid, _grabMirrorMid);
      const now = performance.now();
      if (st.prevGrabT > 0) {
        const dt = (now - st.prevGrabT) / 1000;
        if (dt > 1e-4 && dt < 0.12) { _vGrabDelta.copy(_grabMirrorMid).sub(st.prevGrabMid).divideScalar(dt); st.grabVel.lerp(_vGrabDelta, 0.55); }
      }
      st.prevGrabMid.copy(_grabMirrorMid); st.prevGrabT = now;
      break;
    }
    if (stillPinch) {
      if (readWristQuaternion(frame, refSpace, side, st.wristQuat)) {
        st.mesh.quaternion.copy(st.wristQuat).multiply(st.grabQuatOff);
        const nowW = performance.now();
        if (st.prevWristT > 0) {
          const dtW = (nowW - st.prevWristT) / 1000;
          if (dtW > 1e-4 && dtW < 0.12) { quatDeltaToAngVel(st.prevWristQuat, st.wristQuat, dtW, _vAngDelta); st.grabAngVel.lerp(_vAngDelta, 0.5); }
        }
        st.prevWristQuat.copy(st.wristQuat); st.prevWristT = nowW;
      }
      syncHeldBodyMirror(st.mesh, _grabMirrorMid, st.mesh.quaternion);
    }
    if (!stillPinch) {
      releaseBodyMirror(st.mesh, st.grabVel, st.grabAngVel);
      resetGrabTracking(st); st.mesh.userData.heldBy = null; st.mesh = null;
    }
  }
  for (const src of session.inputSources) {
    const side = handSide(src);
    if (!side || !src.hand) continue;
    if (pinchStateMirror[side].mesh) continue;
    const thumb = src.hand.get("thumb-tip"), index = src.hand.get("index-finger-tip");
    if (!thumb || !index) continue;
    const pt = frame.getJointPose(thumb, refSpace), pi = frame.getJointPose(index, refSpace);
    if (!pt?.transform?.position || !pi?.transform?.position) continue;
    _vThumb.set(pt.transform.position.x, pt.transform.position.y, pt.transform.position.z);
    _vIndex.set(pi.transform.position.x, pi.transform.position.y, pi.transform.position.z);
    if (_vThumb.distanceTo(_vIndex) >= PINCH) continue;
    _vMid.copy(_vThumb).add(_vIndex).multiplyScalar(0.5);
    _mirrorPointRefSpace(_vMid, _grabMirrorMid);
    let best = null, bestD = GRAB_R;
    for (const obj of mirrorGrabbables) {
      if (obj.userData.heldBy && obj.userData.heldBy !== side) continue;
      obj.getWorldPosition(_mirrorWork);
      const d = _grabMirrorMid.distanceTo(_mirrorWork);
      if (d < bestD) { bestD = d; best = obj; }
    }
    if (best) {
      best.userData.heldBy = side;
      const st = pinchStateMirror[side];
      resetGrabTracking(st); st.mesh = best;
      st.prevGrabMid.copy(_grabMirrorMid); st.prevGrabT = performance.now();
      if (readWristQuaternion(frame, refSpace, side, st.wristQuat)) {
        st.grabQuatOff.copy(st.wristQuat).invert().multiply(best.quaternion);
        st.prevWristQuat.copy(st.wristQuat); st.prevWristT = performance.now();
        best.quaternion.copy(st.wristQuat).multiply(st.grabQuatOff);
      } else st.grabQuatOff.identity();
      syncHeldBodyMirror(best, _grabMirrorMid, best.quaternion);
    }
  }
}

function stepDeskPhysics(timeMs) {
  const dt = Math.min(0.05, (timeMs - lastPhysTime) / 1000);
  lastPhysTime = timeMs;
  if (deskPhysics?.world) deskPhysics.world.step(1 / 60, dt, 5);
  if (mirrorDeskPhysics?.world) mirrorDeskPhysics.world.step(1 / 60, dt, 5);
  for (const m of grabbables) {
    if (m.userData.heldBy) continue;
    const b = m.userData.cannonBody;
    if (!b) continue;
    m.position.set(b.position.x, b.position.y, b.position.z);
    m.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  }
  robotMirrorDeskGroup.updateMatrixWorld(true);
  for (const m of mirrorGrabbables) {
    if (m.userData.heldBy) continue;
    const b = m.userData.cannonBody;
    if (!b) continue;
    _mirrorWork.set(b.position.x, b.position.y, b.position.z);
    robotMirrorDeskGroup.worldToLocal(_mirrorWork);
    m.position.copy(_mirrorWork);
    m.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  }
}

// =============== Finger tracking ===============

const _jPos = new THREE.Vector3();
const _jPosB = new THREE.Vector3();
const _jPosC = new THREE.Vector3();

function _getJointPos(frame, hand, jointName, refSpace, out) {
  const joint = hand.get(jointName);
  if (!joint) return false;
  const pose = frame.getJointPose(joint, refSpace);
  if (!pose?.transform?.position) return false;
  out.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
  return true;
}

function _angleBetweenSegments(a, b, c) {
  const ab = _jPosB.copy(b).sub(a);
  const bc = _jPosC.copy(c).sub(b);
  const dot = ab.dot(bc);
  const la = ab.length(), lb = bc.length();
  if (la < 1e-6 || lb < 1e-6) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (la * lb)));
  return Math.acos(cos);
}

function _curlNormalized(angle) {
  return Math.min(1.0, Math.max(0.0, angle / (Math.PI * 0.55)));
}

/** 0=open pinch, 1=closed — thumb-tip ↔ index-tip distance. */
function _pinchCurlNormalized(frame, hand, refSpace) {
  if (!_getJointPos(frame, hand, "thumb-tip", refSpace, _vThumb) ||
      !_getJointPos(frame, hand, "index-finger-tip", refSpace, _vIndex)) return 0;
  const dist = _vThumb.distanceTo(_vIndex);
  const PINCH_CLOSE = 0.022;
  const PINCH_OPEN = 0.095;
  if (dist >= PINCH_OPEN) return 0;
  if (dist <= PINCH_CLOSE) return 1;
  return 1 - (dist - PINCH_CLOSE) / (PINCH_OPEN - PINCH_CLOSE);
}

function _boostCurlForPinch(cur, pinch, gain = 0.9) {
  if (pinch <= 0) return cur;
  return Math.min(1, Math.max(cur, cur + pinch * gain * (1 - cur)));
}

function readFingers(frame, refSpace) {
  const out = {};
  if (!frame || !refSpace) return out;
  const session = frame.session;
  for (const src of session.inputSources) {
    const side = handSide(src);
    if (!side || !src.hand) continue;
    const h = src.hand;
    const fingerData = { thumb: [0, 0, 0], index: [0, 0], middle: [0, 0] };

    const pw = new THREE.Vector3();
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), p3 = new THREE.Vector3();

    // Thumb: wrist→MC→prox, MC→prox→dist, prox→dist→tip
    if (_getJointPos(frame, h, "wrist", refSpace, pw) &&
        _getJointPos(frame, h, "thumb-metacarpal", refSpace, p0) &&
        _getJointPos(frame, h, "thumb-phalanx-proximal", refSpace, p1)) {
      fingerData.thumb[0] = _curlNormalized(_angleBetweenSegments(pw, p0, p1));
    }
    if (_getJointPos(frame, h, "thumb-metacarpal", refSpace, p0) &&
        _getJointPos(frame, h, "thumb-phalanx-proximal", refSpace, p1) &&
        _getJointPos(frame, h, "thumb-phalanx-distal", refSpace, p2)) {
      fingerData.thumb[1] = _curlNormalized(_angleBetweenSegments(p0, p1, p2));
    }
    if (_getJointPos(frame, h, "thumb-phalanx-proximal", refSpace, p1) &&
        _getJointPos(frame, h, "thumb-phalanx-distal", refSpace, p2) &&
        _getJointPos(frame, h, "thumb-tip", refSpace, p3)) {
      fingerData.thumb[2] = _curlNormalized(_angleBetweenSegments(p1, p2, p3));
    }

    // Index: 2 curl values (each segment independent)
    if (_getJointPos(frame, h, "index-finger-metacarpal", refSpace, p0) &&
        _getJointPos(frame, h, "index-finger-phalanx-proximal", refSpace, p1) &&
        _getJointPos(frame, h, "index-finger-phalanx-intermediate", refSpace, p2)) {
      fingerData.index[0] = _curlNormalized(_angleBetweenSegments(p0, p1, p2));
    }
    if (_getJointPos(frame, h, "index-finger-phalanx-proximal", refSpace, p1) &&
        _getJointPos(frame, h, "index-finger-phalanx-intermediate", refSpace, p2) &&
        _getJointPos(frame, h, "index-finger-phalanx-distal", refSpace, p3)) {
      fingerData.index[1] = _curlNormalized(_angleBetweenSegments(p1, p2, p3));
    }

    // Middle + ring + pinky averaged into "middle" for Dex3-1
    let mProx = 0, mDist = 0, mCount = 0;
    for (const finger of ["middle-finger", "ring-finger", "pinky-finger"]) {
      let fp = 0, fd = 0, fc = 0;
      if (_getJointPos(frame, h, `${finger}-metacarpal`, refSpace, p0) &&
          _getJointPos(frame, h, `${finger}-phalanx-proximal`, refSpace, p1) &&
          _getJointPos(frame, h, `${finger}-phalanx-intermediate`, refSpace, p2)) {
        fp = _curlNormalized(_angleBetweenSegments(p0, p1, p2));
        fc++;
      }
      if (_getJointPos(frame, h, `${finger}-phalanx-proximal`, refSpace, p1) &&
          _getJointPos(frame, h, `${finger}-phalanx-intermediate`, refSpace, p2) &&
          _getJointPos(frame, h, `${finger}-phalanx-distal`, refSpace, p3)) {
        fd = _curlNormalized(_angleBetweenSegments(p1, p2, p3));
        fc++;
      }
      if (fc > 0) {
        mProx += fp;
        mDist += fd;
        mCount++;
      }
    }
    if (mCount > 0) {
      fingerData.middle[0] = mProx / mCount;
      fingerData.middle[1] = mDist / mCount;
    }

    const pinch = _pinchCurlNormalized(frame, h, refSpace);
    if (pinch > 0) {
      fingerData.thumb[1] = _boostCurlForPinch(fingerData.thumb[1], pinch);
      fingerData.thumb[2] = _boostCurlForPinch(fingerData.thumb[2], pinch);
      fingerData.index[0] = _boostCurlForPinch(fingerData.index[0], pinch);
      fingerData.index[1] = _boostCurlForPinch(fingerData.index[1], pinch);
    }

    out[side] = fingerData;
  }
  return out;
}

/** Merge dita (XR raw) con ultimo frame / pose aperta — allineate a `handsTeleop`, non swap doppio. */
function buildFingersPayload(fingersRaw, handsTeleop) {
  const payload = {};
  let any = false;
  const openPose = () => ({ thumb: [0, 0, 0], index: [0, 0], middle: [0, 0] });
  for (const side of ["left", "right"]) {
    if (handsTeleop?.[side] == null) continue;
    const fd = fingersRawForTeleopSide(fingersRaw, side);
    if (fd) {
      payload[side] = {
        thumb: [...fd.thumb],
        index: [...fd.index],
        middle: [...fd.middle],
      };
    } else {
      payload[side] = _lastFingersSent?.[side]
        ? {
            thumb: [..._lastFingersSent[side].thumb],
            index: [..._lastFingersSent[side].index],
            middle: [..._lastFingersSent[side].middle],
          }
        : openPose();
    }
    any = true;
  }
  return any ? payload : null;
}

// =============== Head tracking ===============

function readHeadPose(frame, refSpace) {
  if (!frame || !refSpace) return undefined;
  try {
    const viewerPose = frame.getViewerPose(refSpace);
    if (!viewerPose?.transform) return undefined;
    const p = viewerPose.transform.position;
    const o = viewerPose.transform.orientation;
    const mj = mjWorldHandTargetFromXrPosition(p);
    if (!mj) return undefined;
    return [mj[0], mj[1], mj[2], o.x, o.y, o.z, o.w];
  } catch (_) {
    return undefined;
  }
}

// =============== Mode UI ===============

function updateModeUI() {
  if (!modeStatus) return;
  const labels = { idle: "IDLE", realtime: "REALTIME", recording: "REC", playback: "PLAY" };
  modeStatus.textContent = labels[currentMode] || currentMode;
  modeStatus.className = `mode-${currentMode}`;
  if (btnRealtime) btnRealtime.classList.toggle("active", currentMode === "realtime");
  if (btnRecord) btnRecord.classList.toggle("active", currentMode === "recording");
  if (btnStop) btnStop.classList.toggle("active", currentMode === "idle");
  if (btnPlayback) btnPlayback.classList.toggle("active", currentMode === "playback");
}

async function refreshRecordingList() {
  if (!selRecording) return;
  try {
    const r = await fetchWithTimeout(`${API()}/api/recordings`, {}, 10000);
    const data = await r.json();
    const files = data.recordings || [];
    selRecording.innerHTML = "";
    if (!files.length) {
      const opt = document.createElement("option");
      opt.textContent = "(—)";
      opt.value = "";
      selRecording.appendChild(opt);
      return;
    }
    for (const f of files) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f.replace(".jsonl", "");
      selRecording.appendChild(opt);
    }
  } catch (e) { console.warn("recordings list:", e); }
}

btnRealtime?.addEventListener("click", async () => {
  sendMode("realtime");
});

btnRecord?.addEventListener("click", async () => {
  sendMode("recording");
});

btnStop?.addEventListener("click", async () => {
  if (currentMode === "recording") {
    await fetch(`${API()}/api/recording/stop`, { method: "POST" });
    await refreshRecordingList();
  }
  sendMode("idle");
});

btnPlayback?.addEventListener("click", async () => {
  const name = selRecording?.value;
  if (!name) { alert("Seleziona una registrazione!"); return; }
  try {
    const r = await fetch(`${API()}/api/playback/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await r.json();
    if (data.error) alert(data.error);
  } catch (e) { console.warn("playback start:", e); }
});

btnDeleteRec?.addEventListener("click", async () => {
  const name = selRecording?.value;
  if (!name) return;
  if (!confirm(`Eliminare ${name}?`)) return;
  try {
    await fetch(`${API()}/api/recordings/${encodeURIComponent(name)}`, { method: "DELETE" });
    await refreshRecordingList();
  } catch (e) { console.warn("delete:", e); }
});

chkLoop?.addEventListener("change", async () => {
  try {
    await fetch(`${API()}/api/playback/loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loop: !!chkLoop.checked }),
    });
  } catch (e) { console.warn("loop:", e); }
});

// =============== XR session ===============

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
    try { ar = await navigator.xr.isSessionSupported("immersive-ar"); } catch { ar = false; }
    const vrS = vr ? "si" : "no (usa Quest Browser o collega visore)";
    const arS = ar ? "si" : "no";
    return `immersive-vr: ${vrS} | immersive-ar: ${arS}`;
  } catch (e) { return `WebXR: ${e.message || e}`; }
}

function mergeSessionInit(init, useDomOverlay) {
  const feats = [...(init.optionalFeatures || [])];
  const out = { optionalFeatures: feats };
  if (useDomOverlay && modePanel) {
    if (!feats.includes("dom-overlay")) feats.push("dom-overlay");
    out.domOverlay = { root: modePanel };
  }
  return out;
}

async function enterVr() {
  if (renderer.xr.isPresenting) {
    const s = renderer.xr.getSession();
    if (s) await s.end();
    return;
  }
  if (!isVrGateOk()) {
    setStatus("Attendi boot + WS");
    remoteLog("[xr] enterVr blocked bootReady=" + bootReady, "ws=" + (ws ? ws.readyState : "null"));
    return;
  }
  if (!("xr" in navigator)) { setStatus("No WebXR"); return; }
  if (!localSecureEnough()) { setStatus("Serve HTTPS"); return; }
  remoteLog("[xr] three revision", THREE.REVISION || "?", "domOverlay Quest default=" + (isQuestLikeClient() ? "off" : "on") + " use ?dom=1");
  passthroughWanted = !!chkPassthrough?.checked;
  let allowAr = passthroughWanted;
  try {
    if (new URLSearchParams(window.location.search).get("ar") === "0") allowAr = false;
  } catch (_) {}
  let arSupported = false;
  if (allowAr && navigator.xr?.isSessionSupported) {
    try { arSupported = await navigator.xr.isSessionSupported("immersive-ar"); } catch { arSupported = false; }
  }
  const vrTries = [
    { ref: "local-floor", init: { optionalFeatures: ["local-floor", "hand-tracking"] } },
    { ref: "local", init: { optionalFeatures: ["hand-tracking", "local-floor"] } },
    { ref: "local", init: { optionalFeatures: ["hand-tracking"] } },
    { ref: "local-floor", init: { optionalFeatures: ["local-floor"] } },
    { ref: "local", init: { optionalFeatures: ["local-floor", "bounded-floor"] } },
    { ref: "local", init: {} },
  ];
  if (!isQuestLikeClient()) {
    vrTries.push({ ref: "local-floor", init: { optionalFeatures: ["local-floor", "hand-tracking", "layers"] } });
  }
  const arTries = [
    { ref: "local-floor", init: { optionalFeatures: ["local-floor", "hand-tracking"] } },
    { ref: "local-floor", init: { optionalFeatures: ["local-floor"] } },
    { ref: "local", init: { optionalFeatures: ["hand-tracking", "local-floor"] } },
    { ref: "local", init: { optionalFeatures: ["hand-tracking"] } },
    { ref: "local", init: {} },
  ];
  const tries = [];
  if (allowAr && arSupported) {
    for (const t of arTries) tries.push({ mode: "immersive-ar", ...t });
  }
  for (const t of vrTries) tries.push({ mode: "immersive-vr", ...t });
  let last = null;
  let vrDomOverlayUsed = false;
  for (const { mode, ref, init } of tries) {
    renderer.xr.setReferenceSpaceType(ref);
    const useDom =
      mode === "immersive-vr" &&
      !!modePanel &&
      !vrDomOverlayUsed &&
      !bootQueryFlag("nodom") &&
      (bootQueryFlag("dom") || !isQuestLikeClient());
    try {
      const session = await navigator.xr.requestSession(mode, mergeSessionInit(init, useDom));
      await renderer.xr.setSession(session);
      if (mode === "immersive-vr" && useDom) vrDomOverlayUsed = true;
      if (mode === "immersive-ar" && isQuestLikeClient()) {
        try {
          const rawXrfb = new URLSearchParams(window.location.search).get("xrfb");
          if ((rawXrfb == null || rawXrfb === "") && typeof renderer.xr.setFramebufferScaleFactor === "function") {
            renderer.xr.setFramebufferScaleFactor(0.88);
          }
        } catch (_) {}
      }
      const feats = session.enabledFeatures?.join?.(", ") ?? "";
      const blend = session.environmentBlendMode ?? "opaque";
      _xrBlendMode = blend;
      remoteLog("[xr] session started mode=" + mode, "features=" + feats, "blend=" + blend);
      applyPassthroughVisuals();
      try {
        const dos = session.domOverlayState;
        if (dos) remoteLog("[xr] domOverlayState", dos.type || dos);
      } catch (_) {}

      session.addEventListener("inputsourceschange", (ev) => {
        onXrInputSourcesChange(session, ev);
      });
      syncXrHandVisibility(session);

      lastXrSessionReport = `${session.mode} · ${blend}`;
      const fullDiag = `session.mode=${session.mode} environmentBlendMode=${blend} features=${feats || "—"}`;
      remoteLog("[xr] foot detail", fullDiag, isQuestLikeClient() ? "Quest: xrfb/nodom/mesh in barra pulsanti" : "");
      const htShort = feats.includes("hand-tracking") ? "HT" : "noHT";
      const lineShort = `${session.mode} · ${blend} · ${htShort}`;
      queueMicrotask(() => {
        setStatus(lineShort);
        if (xrFoot) {
          xrFoot.dataset.sessionLine = lineShort;
          xrFoot.textContent = lineShort;
          xrFoot.classList.add("on");
        }
        try {
          refreshSetupPanel();
        } catch (_) {}
      });
      sendMode("realtime");
      return;
    } catch (e) { last = e; }
  }
  setStatus(last ? String(last.message || last) : "VR no");
}

btnVr?.addEventListener("click", () => { enterVr().catch((e) => setStatus(String(e.message || e))); });

renderer.xr.addEventListener("sessionstart", () => {
  for (let i = 0; i < 2; i++) {
    try {
      renderer.xr.getController(i).visible = true;
      renderer.xr.getControllerGrip(i).visible = true;
    } catch (_) {}
  }
  hud?.classList.add("vr-hidden");
  vrTools?.classList.add("vr-hidden");
  modePanel?.classList.add("mode-panel-xr");
  if (modePanel) modePanel.style.display = "block";
  if (btnVr) {
    btnVr.textContent = "×";
    btnVr.title = "Esci VR";
  }
  updateVrButtonEnabled();
  passthroughWanted = !!chkPassthrough?.checked;
  applyPassthroughVisuals();
  try {
    if (isQuestLikeClient() && typeof renderer.xr.setFoveation === "function") {
      renderer.xr.setFoveation(0);
    }
  } catch (_) {}
  try {
    if (isQuestLikeClient() && !bootQueryFlag("xrtonemap")) {
      _xrToneRestore = { mapping: renderer.toneMapping, exposure: renderer.toneMappingExposure };
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1.0;
    }
  } catch (_) {}
  queueMicrotask(() => {
    try {
      restoreDeskXRLayoutToDefaults();
      xrRefSpaceResetCleanup?.();
      const rs = renderer.xr.getReferenceSpace();
      if (!rs?.addEventListener) return;
      const onReset = () => restoreDeskXRLayoutToDefaults();
      rs.addEventListener("reset", onReset);
      xrRefSpaceResetCleanup = () => { rs.removeEventListener("reset", onReset); xrRefSpaceResetCleanup = null; };
    } catch (_) {}
  });
});

renderer.xr.addEventListener("sessionend", () => {
  remoteLog("[xr] sessionend");
  _xrBlendMode = "opaque";
  lastXrSessionReport = "—";
  try {
    renderErrorBanner?.classList.remove("on");
    if (renderErrorBanner) renderErrorBanner.textContent = "";
  } catch (_) {}
  try {
    refreshSetupPanel();
  } catch (_) {}
  teleopStickGroup.visible = false;
  teleopStickMirrorGroup.visible = false;
  _animDiag = 0;
  _xrLensDiag = 0;
  _sendCount = 0;
  xrRefSpaceResetCleanup?.();
  hud?.classList.remove("vr-hidden");
  vrTools?.classList.remove("vr-hidden");
  modePanel?.classList.remove("mode-panel-xr");
  updateVrButtonEnabled();
  if (xrFoot) {
    xrFoot.textContent = "";
    delete xrFoot.dataset.sessionLine;
    xrFoot.classList.remove("on");
  }
  if (btnVr) {
    btnVr.textContent = "VR";
    btnVr.title = "Entra in VR";
  }
  pinchState.left.mesh = pinchState.right.mesh = null;
  resetGrabTracking(pinchState.left); resetGrabTracking(pinchState.right);
  for (const o of grabbables) { o.userData.heldBy = null; releaseBody(o, null, null); }
  pinchStateMirror.left.mesh = pinchStateMirror.right.mesh = null;
  resetGrabTracking(pinchStateMirror.left); resetGrabTracking(pinchStateMirror.right);
  for (const o of mirrorGrabbables) { o.userData.heldBy = null; releaseBodyMirror(o, null, null); }
  gridHelper.visible = true;
  scene.background = BG_NORMAL.clone();
  renderer.setClearColor(0x000000, 1);
  deskGroup.visible = true;
  robotStage.visible = true;
  robotGroup.visible = true;
  robotMirrorDeskGroup.visible = true;
  try {
    if (_xrToneRestore) {
      renderer.toneMapping = _xrToneRestore.mapping;
      renderer.toneMappingExposure = _xrToneRestore.exposure;
      _xrToneRestore = null;
    }
  } catch (_) {}
  sendInput({ lx: 0, ly: 0, rx: 0, ry: 0, left_trig: 0, right_trig: 0 }, { left: null, right: null });
  for (let i = 0; i < 2; i++) {
    try {
      renderer.xr.getController(i).visible = false;
      renderer.xr.getControllerGrip(i).visible = false;
      renderer.xr.getHand(i).visible = false;
    } catch (_) {}
  }
});

// =============== Boot (pipeline a fasi) ===============

function scheduleOptionalUnitreeVizLoad() {
  const wantGlb = bootQueryFlag("glb");
  const wantFbx = bootQueryFlag("fbx");
  if (!wantGlb && !wantFbx) return;
  const run = async () => {
    const stripViz = (s) =>
      String(s || "")
        .replace(/\s*\|\s*GLB…\s*$/, "")
        .replace(/\s*\|\s*FBX…\s*$/, "")
        .trim();

    let ok = false;
    let tag = "";

    if (wantGlb) {
      remoteLog("[load] optional GLB post-core");
      const prev = stripViz(statusEl?.textContent);
      setStatus(prev ? `${prev} | GLB…` : "GLB…");
      ok = await tryLoadUnitreeGlb();
      if (ok) tag = "GLB OK";
      else remoteLog("[load] GLB assente o errore");
    }

    if (!ok && wantFbx) {
      remoteLog("[load] optional FBX post-core");
      const prev = stripViz(statusEl?.textContent);
      setStatus(prev ? `${prev} | FBX…` : "FBX…");
      ok = await tryLoadUnitreeFbx();
      if (ok) tag = "FBX OK";
      else remoteLog("[load] FBX assente o errore");
    }

    if (ok) {
      useUnitreeViz = true;
      for (const m of robotMeshes) {
        if (m) m.visible = false;
      }
      try {
        await syncRobotPoseFromRest();
      } catch (_) {}
      remoteLog("[load] Unitree viz ok, mesh STL nascoste");
      const cur = stripViz(statusEl?.textContent);
      setStatus(cur ? `${cur} | ${tag}` : tag);
    } else {
      setStatus(stripViz(statusEl?.textContent));
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => void run(), { timeout: 5000 });
  } else {
    setTimeout(() => void run(), 600);
  }
}

async function boot() {
  const pipelineProgress = (phase, ev, ms, err) => {
    if (bootQueryFlag("debugLoad") && ev === "start") setStatus(`[${phase}]…`);
    if (ev === "ok") remoteLog("[load]", phase, `${ms ?? 0}ms`);
    if (ev === "fail") remoteLog("[load]", phase, "FAIL", `${ms ?? 0}ms`, String(err?.message || err));
  };

  remoteLog("[boot] start", location.href, (navigator.userAgent || "").slice(0, 160));
  setStatus("Avvio app…");
  connectWs();

  let ok = false;
  let loadErrorText = null;
  useUnitreeViz = false;

  if (bootLiteMeshes()) {
    setStatus("Lite (no mesh G1)");
    remoteLog("[boot] lite=1 skip loadRobotMeshes");
  } else {
    const meshRes = await runPhase("RobotMesh", () => loadRobotMeshes(), {
      timeoutMs: 180000,
      onProgress: pipelineProgress,
    });
    ok = meshRes.ok === true && meshRes.value === true;
    if (!meshRes.ok) {
      loadErrorText = `Caricamento: ${meshRes.error?.message || meshRes.error} (?lite=1)`;
      remoteLog("[boot] RobotMesh", loadErrorText);
    } else if (!ok) {
      loadErrorText = "Mesh G1 non disponibili";
    }
    if (ok && robotMeshes.length) {
      const syncRes = await runPhase("SimSync", () => syncRobotPoseFromRest(), {
        timeoutMs: 20000,
        onProgress: pipelineProgress,
      });
      if (!syncRes.ok) remoteLog("[boot] SimSync", String(syncRes.error?.message || syncRes.error));
    }
  }

  const loaded = robotMeshes.filter(Boolean).length;
  _lastClientMeshCount = loaded;
  _lastMeshOk = ok && !bootLiteMeshes();
  _questPreferNoStick = isQuestLikeClient() && _lastMeshOk;
  if (_questPreferNoStick) {
    remoteLog("[boot] Quest+mesh OK: stick manikin off di default (?stick=1 per skeletro)");
  }
  let logLine = bootLiteMeshes()
    ? "lite=1 | no mesh G1 | WS"
    : ok
      ? `G1 mesh×${loaded} | tavoli | davanti mirror z≈${ROBOT_STAGE_POS_DEFAULT.z.toFixed(2)} | ?robotz= ?norobotmirror=1 | ?glb=1`
      : "tavoli OK | G1 mesh assente";
  if (loadErrorText) logLine = `${loadErrorText} | ${logLine}`;
  try {
    const sec = window.isSecureContext ? "secure" : "!secure";
    const xr = await Promise.race([
      probeXr(),
      new Promise((resolve) => setTimeout(() => resolve("XR timeout"), 2500)),
    ]);
    logLine = `${sec} | ${xr} | ${logLine}`;
  } catch (_) {}
  remoteLog("[boot] status", logLine);
  const short = bootLiteMeshes()
    ? "Lite"
    : ok
      ? `Ready · ${loaded}p`
      : loadErrorText
        ? "Ready · mesh×"
        : "Ready · noG1";
  setStatus(bootQueryFlag("debugLoad") ? `${short} · dbg` : short);
  await applyBootHealthHints(loaded, ok, bootLiteMeshes());

  const xrRes = await runPhase("XrSetup", () => setupXrInteraction(), {
    timeoutMs: 20000,
    onProgress: pipelineProgress,
  });
  if (!xrRes.ok) remoteLog("[boot] XrSetup", String(xrRes.error?.message || xrRes.error));

  const recRes = await runPhase("RecordingUI", () => refreshRecordingList(), {
    timeoutMs: 10000,
    onProgress: pipelineProgress,
  });
  if (!recRes.ok) console.warn("refreshRecordingList", recRes.error);

  updateModeUI();
  scheduleOptionalUnitreeVizLoad();

  bootReady = true;
  updateVrButtonEnabled();
  if (modePanel) {
    modePanel.style.display = "block";
    modePanel.setAttribute("aria-hidden", "false");
  }
  remoteLog("[boot] ready for VR", "ws=" + (ws && ws.readyState === WebSocket.OPEN ? "OPEN" : String(ws?.readyState ?? "null")));
  refreshSetupPanel();
  void refreshOpsPanel();
  initRobotOffsetUI();
}

window.addEventListener("error", (ev) => {
  try {
    remoteLog("[window.error]", String(ev.message), ev.filename || "", String(ev.lineno || ""));
  } catch (_) {}
});
window.addEventListener("unhandledrejection", (ev) => {
  try {
    remoteLog("[unhandledrejection]", String(ev.reason?.message || ev.reason || ""));
  } catch (_) {}
});

updateVrButtonEnabled();

document.getElementById("btn-setup-lite")?.addEventListener("click", () => mergeUrlParam("lite", "1"));
document.getElementById("btn-setup-ar0")?.addEventListener("click", () => mergeUrlParam("ar", "0"));
document.getElementById("btn-setup-xrfb")?.addEventListener("click", () => mergeUrlParam("xrfb", "0.85"));
document.getElementById("btn-setup-xrfb-75")?.addEventListener("click", () => mergeUrlParam("xrfb", "0.75"));
document.getElementById("btn-setup-xrfb-65")?.addEventListener("click", () => mergeUrlParam("xrfb", "0.65"));
document.getElementById("btn-setup-clear")?.addEventListener("click", () => {
  try {
    sessionStorage.removeItem("xr_auto_lite");
  } catch (_) {}
  location.href = location.pathname + location.hash;
});
document.getElementById("btn-setup-nodom")?.addEventListener("click", () => mergeUrlParam("nodom", "1"));
document.getElementById("btn-setup-dom")?.addEventListener("click", () => mergeUrlParam("dom", "1"));
document.getElementById("btn-setup-tonemap")?.addEventListener("click", () => mergeUrlParam("xrtonemap", "1"));
document.getElementById("btn-setup-meshpiece")?.addEventListener("click", () => mergeUrlParam("meshmode", "piece"));
document.getElementById("btn-setup-copy")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus("URL ok");
  } catch {
    setStatus("URL no clipboard");
  }
});
refreshSetupPanel();

opsToggle?.addEventListener("click", () => {
  const c = opsBody?.classList.toggle("collapsed");
  if (opsToggle) {
    opsToggle.textContent = c ? "▶" : "▼";
    opsToggle.setAttribute("aria-expanded", c ? "false" : "true");
  }
});

btnOpsRefresh?.addEventListener("click", () => void refreshOpsPanel());
chkHandFollowPelvis?.addEventListener("change", () => {
  void postHandFollowPelvis(!!chkHandFollowPelvis?.checked);
});
btnSceneDefault?.addEventListener("click", () => void postReloadScene("default"));
btnSceneIndustrial?.addEventListener("click", () => void postReloadScene("industrial_light"));
btnSceneLoad?.addEventListener("click", () => {
  const key = selScene?.value?.trim();
  if (key) void postReloadScene(key);
});

void boot();

// =============== Keyboard + Render loop ===============

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function readStick(gp) {
  if (!gp?.axes?.length) return [0, 0];
  let x = gp.axes[0] || 0, y = gp.axes[1] || 0;
  if (Math.hypot(x, y) < 0.05 && gp.axes.length >= 4) { x = gp.axes[2] || 0; y = gp.axes[3] || 0; }
  return [x, y];
}
function trig(gp) { const v = gp?.buttons?.[0]?.value; return typeof v === "number" ? v : 0; }

function readPads(frame) {
  const out = { lx: 0, ly: 0, rx: 0, ry: 0, left_trig: 0, right_trig: 0 };
  const session = frame?.session ?? renderer.xr.getSession();
  if (!session) return out;
  const src = [...session.inputSources].filter((s) => s.gamepad);
  let L = src.find((s) => s.handedness === "left");
  let R = src.find((s) => s.handedness === "right");
  if (!L && !R && src.length >= 2) { L = src[0]; R = src[1]; }
  else { if (!L && src.length) L = src[0]; if (!R && src.length > 1) R = src.find((s) => s !== L) || src[1]; }
  if (L?.gamepad) { [out.lx, out.ly] = readStick(L.gamepad); out.left_trig = trig(L.gamepad); }
  if (R?.gamepad) { [out.rx, out.ry] = readStick(R.gamepad); out.right_trig = trig(R.gamepad); }
  return out;
}

/**
 * Posa XR polso/grip target MJ. Con teleopHandMirrorPath applica _mirrorPointRefSpace come lo stick.
 */
function _mjFromXrHandTransform(t, frame, refSpace) {
  if (!t?.position) return null;
  const pos = t.position;
  if (!teleopHandMirrorPath() || !frame || !refSpace) {
    return mjWorldHandTargetFromXrPosition(pos);
  }
  if (!_headBasisFromFrame(frame, refSpace)) {
    return mjWorldHandTargetFromXrPosition(pos);
  }
  _handMirrorPreMjScratch.set(pos.x, pos.y, pos.z);
  _mirrorPointRefSpace(_handMirrorPreMjScratch, _handMirrorPostScratch);
  return mjWorldHandTargetFromXrPosition(_handMirrorPostScratch);
}

let _lastHandLeft = null;
let _lastHandRight = null;
let _lastHandLeftT = 0;
let _lastHandRightT = 0;
const HAND_STALE_MS = 500;

function readHands(frame, refSpace) {
  const out = {};
  if (!frame || !refSpace) return out;
  const session = frame.session;
  if (!session) return out;
  const now = performance.now();

  for (const src of session.inputSources) {
    let mj = null;
    if (src.hand) {
      for (const jn of ["wrist", "middle-finger-metacarpal", "index-finger-metacarpal"]) {
        const joint = src.hand.get(jn);
        if (!joint) continue;
        try {
          const jp = frame.getJointPose(joint, refSpace);
          mj = _mjFromXrHandTransform(jp?.transform, frame, refSpace);
          if (mj) break;
        } catch (_) {}
      }
    }
    if (!mj && src.gripSpace) {
      try {
        const gp = frame.getPose(src.gripSpace, refSpace);
        mj = _mjFromXrHandTransform(gp?.transform, frame, refSpace);
      } catch (_) {}
    }
    if (!mj && src.targetRaySpace) {
      try {
        const tp = frame.getPose(src.targetRaySpace, refSpace);
        mj = _mjFromXrHandTransform(tp?.transform, frame, refSpace);
      } catch (_) {}
    }
    if (!mj) continue;
    const side = src.handedness;
    if (side === "left") { out.left = mj; _lastHandLeft = mj; _lastHandLeftT = now; }
    else if (side === "right") { out.right = mj; _lastHandRight = mj; _lastHandRightT = now; }
  }

  if (!out.left && _lastHandLeft && (now - _lastHandLeftT) < HAND_STALE_MS) {
    out.left = _lastHandLeft;
  }
  if (!out.right && _lastHandRight && (now - _lastHandRightT) < HAND_STALE_MS) {
    out.right = _lastHandRight;
  }

  if (bootQueryFlag("handtrace") && frame && refSpace) {
    _handTraceTick++;
    if (_handTraceTick % 28 === 0) {
      try {
        for (const s of session.inputSources) {
          if (!s.hand || s.handedness !== "right") continue;
          const joint = s.hand.get("wrist");
          if (!joint) break;
          const jp = frame.getJointPose(joint, refSpace);
          const pos = jp?.transform?.position;
          if (!pos) break;
          const raw = `[${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}]`;
          let mir = raw;
          if (_headBasisFromFrame(frame, refSpace)) {
            _handMirrorPreMjScratch.set(pos.x, pos.y, pos.z);
            _mirrorPointRefSpace(_handMirrorPreMjScratch, _handMirrorPostScratch);
            mir = `[${_handMirrorPostScratch.x.toFixed(2)},${_handMirrorPostScratch.y.toFixed(2)},${_handMirrorPostScratch.z.toFixed(2)}]`;
          }
          const mj = out.right;
          const mjS = mj ? `[${mj[0].toFixed(2)},${mj[1].toFixed(2)},${mj[2].toFixed(2)}]` : "?";
          remoteLog(
            "[handtrace] R raw=" + raw + " mir=" + mir + " mj=" + mjS,
            "mirrorPath=" + (teleopHandMirrorPath() ? "1" : "0"),
            "ms=" + getMirrorMotionScale().toFixed(2),
          );
          break;
        }
      } catch (_) {}
    }
  }

  return out;
}

const keys = {};
window.addEventListener("keydown", (e) => { keys[e.code] = true; });
window.addEventListener("keyup", (e) => { keys[e.code] = false; });

let _animDiag = 0;
let _fingerDebugTick = 0;
/** Contatore frame XR per log diagnostici (mode, blend, numero view / occhi). */
let _xrLensDiag = 0;
let _xrHandHintFrames = 0;

function _xrAnyHandTracked(session) {
  if (!session?.inputSources) return false;
  for (const s of session.inputSources) {
    if (s.hand) return true;
  }
  return false;
}
const XR_LENS_DIAG_FRAMES = 30;
function animate(time, frame) {
  tickRobotGeomPoseSmooth(time);
  if (renderer.xr.isPresenting) {
    const xrFrame = frame ?? renderer.xr.getFrame?.() ?? null;
    const refSpace = renderer.xr.getReferenceSpace();

    if (xrFrame && refSpace) {
      _xrLensDiag++;
      if (_xrLensDiag <= XR_LENS_DIAG_FRAMES || _xrLensDiag % 1200 === 0) {
        try {
          const sess = xrFrame.session;
          const pose = xrFrame.getViewerPose(refSpace);
          const nViews = pose?.views?.length ?? 0;
          remoteLog(
            "[xr-lens#" + _xrLensDiag + "]",
            "mode=" + (sess?.mode ?? "?"),
            "blend=" + (sess?.environmentBlendMode ?? "?"),
            "views=" + nViews,
            "passthroughChk=" + (chkPassthrough?.checked ? "1" : "0"),
            "clearARpath=" + (isImmersiveArSession() ? "yes" : "no"),
          );
        } catch (e) {
          remoteLog("[xr-lens] pose error", String(e?.message || e));
        }
      }
    }

    _animDiag++;
    if (_animDiag <= 3 || _animDiag % 1200 === 0) {
      const session = xrFrame?.session;
      const srcs = session ? [...session.inputSources] : [];
      const srcInfo = srcs.map(s => ({
        hand: s.handedness,
        hasHand: !!s.hand,
        handSize: s.hand?.size ?? 0,
        hasGrip: !!s.gripSpace,
        hasTarget: !!s.targetRaySpace,
        profiles: s.profiles,
      }));
      remoteLog("[animate#" + _animDiag + "] frame=" + !!xrFrame, "refSpace=" + !!refSpace,
        "inputSources=" + srcs.length, JSON.stringify(srcInfo));
    }

    _matInvRobotRoomFix.copy(_robotRoomFix).invert();
    const ax = readPads(xrFrame);
    const handsRaw = readHands(xrFrame, refSpace);
    const fingers = readFingers(xrFrame, refSpace);
    const handsTeleop = swapHandsLrForTeleop(handsRaw);
    const head = readHeadPose(xrFrame, refSpace);
    const fingersPayload = buildFingersPayload(fingers, handsTeleop);
    if (fingersPayload) _lastFingersSent = fingersPayload;
    if (bootQueryFlag("fingerdebug")) {
      _fingerDebugTick++;
      if (_fingerDebugTick % 45 === 0) {
        remoteLog(
          "[fingerdebug]",
          fingersPayload ? JSON.stringify(fingersPayload).slice(0, 280) : "(nessun payload dita)",
        );
      }
    }
    sendInput(
      ax,
      { left: handsTeleop.left ?? null, right: handsTeleop.right ?? null },
      fingersPayload ?? undefined,
      head,
    );
    updateHandGridDebug(xrFrame, refSpace, handsTeleop, fingers);
    updatePinchGrab(xrFrame, refSpace);
    updatePinchGrabMirror(xrFrame, refSpace);
    polishXrHandMeshes();
    try {
      const sess = xrFrame?.session ?? renderer.xr.getSession();
      syncXrHandVisibility(sess);
    } catch (_) {}
    updateStickManikin(xrFrame, refSpace);
    try {
      const sess = xrFrame?.session ?? renderer.xr.getSession();
      if (sess) {
        const showRays = !_xrAnyHandTracked(sess);
        for (let i = 0; i < 2; i++) {
          const line = renderer.xr.getController(i)?.getObjectByName?.("xrControllerRayHint");
          if (line) line.visible = showRays;
        }
      }
    } catch (_) {}
    _xrHandHintFrames++;
    if (_xrHandHintFrames % 90 === 0) {
      try {
        const sess = xrFrame?.session ?? renderer.xr.getSession();
        const feats = sess?.enabledFeatures ? [...sess.enabledFeatures] : [];
        const ht = feats.includes("hand-tracking");
        const anyH = _xrAnyHandTracked(sess);
        if (!ht) {
          setHudDiag("Mani: sessione senza hand-tracking — abilita «Mani» negli esperimenti WebXR (browser Quest).");
        } else if (!anyH) {
          setHudDiag("Mani: hand-tracking attivo ma nessuna mano rilevata — resta nel campo visivo.");
        } else {
          setHudDiag("");
        }
      } catch (_) {}
    }
  } else {
    _lastFingersSent = undefined;
    teleopStickGroup.visible = false;
    teleopStickMirrorGroup.visible = false;
    if (_handGridDebugGroup) _handGridDebugGroup.visible = false;
    if (_xrHandHintFrames !== 0) {
      _xrHandHintFrames = 0;
      setHudDiag("");
    }
    try {
      for (let i = 0; i < 2; i++) {
        const line = renderer.xr.getController(i)?.getObjectByName?.("xrControllerRayHint");
        if (line) line.visible = false;
      }
    } catch (_) {}
  }
  const t = typeof time === "number" && time > 0 ? time : performance.now();
  stepDeskPhysics(t);
  try {
    renderer.render(scene, camera);
  } catch (e) {
    if (!_renderErrorLogged) {
      _renderErrorLogged = true;
      const sm = renderer.xr?.isPresenting ? renderer.xr.getSession?.()?.mode : null;
      remoteLog("[render] error (once)", String(e?.message || e), sm != null ? "xrSession.mode=" + sm : "desktop");
    }
    try {
      if (renderErrorBanner) {
        renderErrorBanner.textContent =
          "Errore WebGL/render. Su Quest: esci da VR, prova pulsante «Lite» o aggiungi ?lite=1 manualmente se serve ridurre GPU (niente reload automatico). Poi Clr URL.";
        renderErrorBanner.classList.add("on");
      }
      setStatus(`Render: ${String(e?.message || e).slice(0, 120)}`);
    } catch (_) {}
  }
}
renderer.setAnimationLoop(animate);

setInterval(() => {
  if (renderer.xr.isPresenting) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  let lx = 0, ly = 0, rx = 0;
  if (keys.KeyA) lx -= 1;
  if (keys.KeyD) lx += 1;
  if (keys.KeyW) ly += 1;
  if (keys.KeyS) ly -= 1;
  if (keys.KeyQ) rx -= 1;
  if (keys.KeyE) rx += 1;
  // Invio continuo (anche tutti zeri): così il server azzera CMD e non resta l’ultimo stick “incollato”.
  sendInput({ lx, ly, rx, ry: 0, left_trig: 0, right_trig: 0 }, { left: null, right: null });
}, 40);
