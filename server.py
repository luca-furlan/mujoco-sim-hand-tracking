"""
G1 (Menagerie) in MuJoCo + WebSocket teleop + WebXR (mesh corpo intero + hand tracking opzionale).

Default: UNA sola porta HTTPS 8443 (WebXR richiede contesto sicuro; due Uvicorn in thread su Windows
spesso lasciava 8443 morta). Apri sempre https://127.0.0.1:8443/ sul PC e sul Quest.

Solo debug senza SSL: imposta HTTP_ONLY=1 → http://127.0.0.1:8000 (su IP LAN non avrai WebXR).
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import struct
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from pathlib import Path
from typing import Any

import mujoco
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
SCENE = (ROOT / "vendor" / "mujoco_menagerie" / "unitree_g1" / "scene.xml").resolve()

MODEL: mujoco.MjModel | None = None
DATA: mujoco.MjData | None = None
SIM_LOCK = asyncio.Lock()
FREE_QVEL_START: int | None = None
FREE_QVEL_END: int | None = None
REF_CTRL: Any = None
VIZ_GEOM_INDICES: list[int] = []

# Polso target mondo (MuJoCo z-up), None = non aggiornare braccio
HAND_LEFT: np.ndarray | None = None
HAND_RIGHT: np.ndarray | None = None
_HAND_SMOOTH = float(os.environ.get("HAND_SMOOTH", "0.28"))
_ARM_REACH = float(os.environ.get("ARM_REACH", "0.52"))
_IK_ITERS = int(os.environ.get("IK_ITERS", "7"))
_HAND_OFF = np.array(
    [
        float(os.environ.get("HAND_OFF_X", "0")),
        float(os.environ.get("HAND_OFF_Y", "0")),
        float(os.environ.get("HAND_OFF_Z", "0")),
    ],
    dtype=np.float64,
)
VIZ_MESH_CACHE: list[dict[str, Any]] | None = None

LEFT_ARM_JOINTS = [
    "left_shoulder_pitch_joint",
    "left_shoulder_roll_joint",
    "left_shoulder_yaw_joint",
    "left_elbow_joint",
    "left_wrist_roll_joint",
    "left_wrist_pitch_joint",
    "left_wrist_yaw_joint",
]
RIGHT_ARM_JOINTS = [
    "right_shoulder_pitch_joint",
    "right_shoulder_roll_joint",
    "right_shoulder_yaw_joint",
    "right_elbow_joint",
    "right_wrist_roll_joint",
    "right_wrist_pitch_joint",
    "right_wrist_yaw_joint",
]

_MJ_TO_THREE_B = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]], dtype=np.float64)

CMD = {
    "lx": 0.0, "ly": 0.0, "rx": 0.0, "ry": 0.0,
    "left_trig": 0.0, "right_trig": 0.0,
}


def _find_free_joint() -> None:
    global FREE_QVEL_START, FREE_QVEL_END
    assert MODEL is not None
    FREE_QVEL_START = FREE_QVEL_END = None
    for j in range(MODEL.njnt):
        if MODEL.jnt_type[j] == mujoco.mjtJoint.mjJNT_FREE:
            vadr = int(MODEL.jnt_dofadr[j])
            FREE_QVEL_START = vadr
            FREE_QVEL_END = vadr + 6
            return


def load_model() -> None:
    global MODEL, DATA, REF_CTRL
    if MODEL is not None:
        return
    if not SCENE.is_file():
        raise FileNotFoundError(f"Manca MJCF. Esegui SETUP.ps1: {SCENE}")
    MODEL = mujoco.MjModel.from_xml_path(str(SCENE))
    DATA = mujoco.MjData(MODEL)
    _find_free_joint()
    mujoco.mj_resetDataKeyframe(MODEL, DATA, 0)
    REF_CTRL = DATA.ctrl.copy()
    global VIZ_GEOM_INDICES, VIZ_MESH_CACHE
    VIZ_GEOM_INDICES = _robot_visual_mesh_geom_indices(MODEL)
    VIZ_MESH_CACHE = None
    mujoco.mj_forward(MODEL, DATA)


def _robot_visual_mesh_geom_indices(M: mujoco.MjModel) -> list[int]:
    """Tutte le geom mesh di sola visual (gruppo 2 nel MJCF Menagerie G1): corpo intero, no collision."""
    out: list[int] = []
    seen: set[tuple[Any, ...]] = set()
    for gi in range(M.ngeom):
        if M.geom_type[gi] != mujoco.mjtGeom.mjGEOM_MESH:
            continue
        if int(M.geom_group[gi]) != 2:
            continue
        bi = int(M.geom_bodyid[gi])
        mid = int(M.geom_dataid[gi])
        if not mujoco.mj_id2name(M, mujoco.mjtObj.mjOBJ_MESH, mid):
            continue
        pos = M.geom_pos[gi]
        quat = M.geom_quat[gi]
        key = (bi, mid, float(pos[0]), float(pos[1]), float(pos[2]), float(quat[0]), float(quat[1]), float(quat[2]), float(quat[3]))
        if key in seen:
            continue
        seen.add(key)
        out.append(gi)
    return out


def _T_mesh_to_world(M: mujoco.MjModel, d: mujoco.MjData, gi: int) -> np.ndarray:
    mid = int(M.geom_dataid[gi])
    pos_m = np.asarray(M.mesh_pos[mid], dtype=np.float64)
    quat_m = np.asarray(M.mesh_quat[mid], dtype=np.float64)
    scale = np.asarray(M.mesh_scale[mid], dtype=np.float64)
    R9 = np.zeros(9, dtype=np.float64)
    mujoco.mju_quat2Mat(R9, quat_m)
    Rm = R9.reshape(3, 3)
    T_mg = np.eye(4, dtype=np.float64)
    T_mg[:3, :3] = Rm @ np.diag(scale)
    T_mg[:3, 3] = pos_m
    R_g = np.asarray(d.geom_xmat[gi], dtype=np.float64).reshape(3, 3)
    t_g = np.asarray(d.geom_xpos[gi], dtype=np.float64)
    T_gw = np.eye(4, dtype=np.float64)
    T_gw[:3, :3] = R_g
    T_gw[:3, 3] = t_g
    return T_gw @ T_mg


def snapshot() -> dict[str, Any]:
    assert MODEL is not None and DATA is not None
    names, pos, quat = [], [], []
    for i in range(MODEL.nbody):
        names.append(mujoco.mj_id2name(MODEL, mujoco.mjtObj.mjOBJ_BODY, i) or f"body_{i}")
        p = DATA.xpos[i]
        q = DATA.xquat[i]
        pos.append([float(p[0]), float(p[1]), float(p[2])])
        quat.append([float(q[0]), float(q[1]), float(q[2]), float(q[3])])
    out: dict[str, Any] = {
        "names": names,
        "pos": pos,
        "quat": quat,
        "time": float(DATA.time),
    }
    if VIZ_GEOM_INDICES:
        gm: list[list[float]] = []
        for gi in VIZ_GEOM_INDICES:
            T_mw = _T_mesh_to_world(MODEL, DATA, gi)
            R_w = T_mw[:3, :3]
            t_w = T_mw[:3, 3]
            Rt = _MJ_TO_THREE_B @ R_w
            tt = (_MJ_TO_THREE_B @ t_w).tolist()
            M4 = np.eye(4, dtype=np.float64)
            M4[:3, :3] = Rt
            M4[:3, 3] = tt
            gm.append(M4.flatten("F").tolist())
        out["geom_mat4"] = gm
    return out


def apply_teleop(dt: float) -> None:
    if MODEL is None or DATA is None or FREE_QVEL_START is None:
        return
    lx, ly, rx = CMD["lx"], CMD["ly"], CMD["rx"]
    brake = 0.25 * (CMD["left_trig"] + CMD["right_trig"])
    v_max = 0.8 * (1.0 - min(1.0, brake))
    w_max = 1.2 * (1.0 - min(1.0, brake))
    vx, vy, wy = -ly * v_max, lx * v_max, -rx * w_max
    v = DATA.qvel
    s = slice(FREE_QVEL_START, FREE_QVEL_END)
    v[s.start + 0] = v[s.start + 1] = 0.0
    v[s.start + 2] = wy
    v[s.start + 3] = vx
    v[s.start + 4] = vy
    v[s.start + 5] = 0.0


def _arm_actuator_and_qpos(model: mujoco.MjModel, joint_names: list[str]) -> tuple[list[int], list[int], list[int]]:
    aids, qadrs, dof_ids = [], [], []
    for name in joint_names:
        jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
        if jid < 0:
            raise RuntimeError(f"joint {name!r} missing")
        aid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, name)
        if aid < 0:
            raise RuntimeError(f"actuator {name!r} missing")
        aids.append(int(aid))
        qadrs.append(int(model.jnt_qposadr[jid]))
        dof_ids.append(int(model.jnt_dofadr[jid]))
    return aids, qadrs, dof_ids


def _ik_arm_to_target_clean(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    wrist_bid: int,
    shoulder_bid: int,
    joint_names: list[str],
    dof_ids: list[int],
    qadrs: list[int],
    aids: list[int],
    target_world: np.ndarray,
) -> None:
    q_backup = data.qpos.copy()
    try:
        sh = data.xpos[shoulder_bid]
        v = target_world - sh
        d = float(np.linalg.norm(v))
        if d < 1e-4:
            return
        v = v / d * min(d, _ARM_REACH)
        tgt = sh + v
        jac = np.zeros((3, model.nv), dtype=np.float64)
        dof_idx = np.array(dof_ids, dtype=np.int32)
        for _ in range(_IK_ITERS):
            err = tgt - data.xpos[wrist_bid]
            if float(np.linalg.norm(err)) < 0.006:
                break
            mujoco.mj_jacBody(model, data, jac, None, wrist_bid)
            J = jac[:, dof_idx]
            try:
                dq = np.linalg.pinv(J) @ err
            except np.linalg.LinAlgError:
                break
            dq = np.clip(dq, -0.12, 0.12)
            for k, dqk in enumerate(dq):
                adr = qadrs[k]
                jn = joint_names[k]
                jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, jn)
                lo, hi = model.jnt_range[jid]
                if lo == 0.0 and hi == 0.0:
                    data.qpos[adr] += float(0.4 * dqk)
                else:
                    data.qpos[adr] = float(np.clip(data.qpos[adr] + 0.4 * dqk, lo, hi))
            mujoco.mj_forward(model, data)
        for k, aid in enumerate(aids):
            data.ctrl[aid] = float(data.qpos[qadrs[k]])
    finally:
        data.qpos[:] = q_backup
        mujoco.mj_forward(model, data)


def _smooth_vec(cur: np.ndarray | None, nxt: np.ndarray, alpha: float) -> np.ndarray:
    if cur is None:
        return nxt.copy()
    return (1.0 - alpha) * cur + alpha * nxt


def _apply_hand_msg(h: Any) -> None:
    global HAND_LEFT, HAND_RIGHT
    if not isinstance(h, dict):
        return
    a = _HAND_SMOOTH
    for side in ("left", "right"):
        if side not in h:
            continue
        raw = h.get(side)
        if raw is None:
            if side == "left":
                HAND_LEFT = None
            else:
                HAND_RIGHT = None
            continue
        if not isinstance(raw, (list, tuple)) or len(raw) < 3:
            continue
        tgt = (
            np.array([float(raw[0]), float(raw[1]), float(raw[2])], dtype=np.float64) + _HAND_OFF
        )
        if side == "left":
            HAND_LEFT = _smooth_vec(HAND_LEFT, tgt, a)
        else:
            HAND_RIGHT = _smooth_vec(HAND_RIGHT, tgt, a)


def viz_meshes_payload() -> list[dict[str, Any]]:
    global VIZ_MESH_CACHE
    if VIZ_MESH_CACHE is not None:
        if len(VIZ_MESH_CACHE) > 0 and "name" not in VIZ_MESH_CACHE[0]:
            VIZ_MESH_CACHE = None
        else:
            return VIZ_MESH_CACHE
    assert MODEL is not None
    M = MODEL
    out: list[dict[str, Any]] = []
    for gi in VIZ_GEOM_INDICES:
        mid = int(M.geom_dataid[gi])
        va = int(M.mesh_vertadr[mid])
        vn = int(M.mesh_vertnum[mid])
        verts = np.asarray(M.mesh_vert[va : va + 3 * vn], dtype=np.float64).tolist()
        fa = int(M.mesh_faceadr[mid])
        fn = int(M.mesh_facenum[mid])
        # mesh_face e' (N,3): una riga per triangolo, NON un vettore lungo 3*fn.
        faces = np.asarray(M.mesh_face[fa : fa + fn], dtype=np.int32).reshape(-1).tolist()
        mname = mujoco.mj_id2name(M, mujoco.mjtObj.mjOBJ_MESH, mid) or ""
        out.append({"v": verts, "i": faces, "name": mname})
    VIZ_MESH_CACHE = out
    return out


def apply_hands_ik() -> None:
    if MODEL is None or DATA is None or REF_CTRL is None:
        return
    DATA.ctrl[:] = REF_CTRL
    M, d = MODEL, DATA
    l_wrist = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_BODY, "left_wrist_yaw_link")
    l_sh = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_BODY, "left_shoulder_pitch_link")
    r_wrist = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_BODY, "right_wrist_yaw_link")
    r_sh = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_BODY, "right_shoulder_pitch_link")
    la, lq, ld = _arm_actuator_and_qpos(M, LEFT_ARM_JOINTS)
    ra, rq, rd = _arm_actuator_and_qpos(M, RIGHT_ARM_JOINTS)
    if HAND_LEFT is not None:
        _ik_arm_to_target_clean(M, d, l_wrist, l_sh, LEFT_ARM_JOINTS, ld, lq, la, HAND_LEFT)
    if HAND_RIGHT is not None:
        _ik_arm_to_target_clean(M, d, r_wrist, r_sh, RIGHT_ARM_JOINTS, rd, rq, ra, HAND_RIGHT)


def step_sim(dt: float) -> None:
    assert MODEL is not None and DATA is not None
    if REF_CTRL is not None:
        DATA.ctrl[:] = REF_CTRL
    apply_hands_ik()
    apply_teleop(dt)
    mujoco.mj_step(MODEL, DATA)


app = FastAPI()


@app.middleware("http")
async def _xr_headers(request: Request, call_next) -> Response:
    r = await call_next(request)
    r.headers.setdefault("Permissions-Policy", "xr-spatial-tracking=(self)")
    return r


@app.on_event("startup")
def _startup() -> None:
    load_model()


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(
        STATIC / "index.html",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@app.get("/api/health")
async def health() -> dict[str, Any]:
    https_port = int(os.environ.get("HTTPS_PORT", "8443"))
    plain_port = int(os.environ.get("PORT", "8000"))
    http_only = os.environ.get("HTTP_ONLY", "").lower() in ("1", "true", "yes")
    port = plain_port if http_only else https_port
    return {
        "ok": True,
        "model_loaded": MODEL is not None,
        "scene": str(SCENE),
        "http_only": http_only,
        "listen_port": port,
        "hint": f"WebXR: https://<IP>:{https_port}/ (cert. autofirmato). HTTP_ONLY=1 -> http://<IP>:{plain_port}/ senza VR su LAN.",
    }


@app.get("/api/sim_state")
async def sim_state() -> dict[str, Any]:
    async with SIM_LOCK:
        if MODEL is None:
            return {"error": "no model"}
        return {"sim": snapshot()}


async def _drain_ws(ws: WebSocket) -> None:
    while True:
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=0)
        except asyncio.TimeoutError:
            break
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("type") != "input":
            continue
        ax = msg.get("axes") or {}
        CMD["lx"] = float(ax.get("lx", 0.0))
        CMD["ly"] = float(ax.get("ly", 0.0))
        CMD["rx"] = float(ax.get("rx", 0.0))
        CMD["ry"] = float(ax.get("ry", 0.0))
        CMD["left_trig"] = float(ax.get("left_trig", 0.0))
        CMD["right_trig"] = float(ax.get("right_trig", 0.0))
        if "hands" in msg:
            _apply_hand_msg(msg.get("hands"))


@app.get("/api/g1_viz_meshes")
async def g1_viz_meshes() -> dict[str, Any]:
    async with SIM_LOCK:
        if MODEL is None:
            return {"error": "no model", "meshes": []}
        return {"meshes": viz_meshes_payload()}


@app.get("/api/g1_arm_meshes")
async def g1_arm_meshes() -> dict[str, Any]:
    """Alias storico: ora include tutto il corpo (stesso payload di /api/g1_viz_meshes)."""
    return await g1_viz_meshes()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    hz = float(os.environ.get("WS_HZ", "60"))
    try:
        while True:
            await _drain_ws(ws)
            async with SIM_LOCK:
                if MODEL is None or DATA is None:
                    await asyncio.sleep(1.0 / hz)
                    continue
                dt = float(MODEL.opt.timestep)
                sub = max(1, int(round(1.0 / (hz * dt))))
                for _ in range(sub):
                    step_sim(dt)
                snap = snapshot()
            await ws.send_text(json.dumps({"type": "state", "sim": snap}))
            await asyncio.sleep(1.0 / hz)
    except WebSocketDisconnect:
        return


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


def _primary_ipv4() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def _host_ips() -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    p = _primary_ipv4()
    if p and not p.startswith("127."):
        seen.add(p)
        out.append(p)
    try:
        for name in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = name[4][0]
            if ip.startswith("127.") or ip in seen:
                continue
            seen.add(ip)
            out.append(ip)
    except OSError:
        pass
    return out


def ensure_certs() -> tuple[str, str]:
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    d = ROOT / "certs"
    d.mkdir(parents=True, exist_ok=True)
    key_p, cert_p = d / "dev.key", d / "dev.crt"
    if key_p.is_file() and cert_p.is_file():
        return str(cert_p), str(key_p)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048, backend=default_backend())
    sub = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "g1-local")])
    san = [x509.DNSName("localhost"), x509.IPAddress(ip_address("127.0.0.1"))]
    for ip in _host_ips():
        try:
            san.append(x509.IPAddress(ip_address(ip)))
        except ValueError:
            pass
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(sub)
        .issuer_name(sub)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .sign(key, hashes.SHA256(), default_backend())
    )
    key_p.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_p.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return str(cert_p), str(key_p)


def main() -> None:
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    http_only = os.environ.get("HTTP_ONLY", "").lower() in ("1", "true", "yes")
    print(f"Scene: {SCENE}", flush=True)

    if http_only:
        port = int(os.environ.get("PORT", "8000"))
        print("HTTP_ONLY=1 - niente HTTPS (WebXR non funziona su http://<IP-LAN>).", flush=True)
        print(f"  http://127.0.0.1:{port}/", flush=True)
        for ip in _host_ips():
            print(f"  http://{ip}:{port}/", flush=True)
        uvicorn.run(app, host=host, port=port, log_level="info")
        return

    https_port = int(os.environ.get("HTTPS_PORT", "8443"))
    cert, key = ensure_certs()
    print("Apri nel browser (HTTPS - necessario per WebXR su Quest e wss://):", flush=True)
    print(f"  https://127.0.0.1:{https_port}/", flush=True)
    for ip in _host_ips():
        print(f"  https://{ip}:{https_port}/", flush=True)
    print("Certificato autofirmato: Avanzate -> Continua verso sito (o equivalente).", flush=True)
    uvicorn.run(
        app,
        host=host,
        port=https_port,
        ssl_certfile=cert,
        ssl_keyfile=key,
        log_level="info",
    )


if __name__ == "__main__":
    main()
