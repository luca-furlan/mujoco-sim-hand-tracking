"""
G1 con mani Dex3-1 (Menagerie) — MuJoCo + WebSocket teleop + WebXR.

Modalita':
  - realtime : VR guida il G1 in tempo reale (braccia IK + dita + locomozione)
  - recording: come realtime, ma registra qpos/ctrl ogni tick
  - playback : ignora input VR, riproduce una registrazione salvata
  - idle     : simulazione ferma in posa di partenza

Default: HTTPS 8443.  HTTP_ONLY=1 -> http://127.0.0.1:8000 (no WebXR su LAN).
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import socket
import time as _time
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from pathlib import Path
from typing import Any

import mujoco
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
RECORDINGS_DIR = ROOT / "recordings"
SCENE = (ROOT / "vendor" / "mujoco_menagerie" / "unitree_g1" / "scene_with_hands.xml").resolve()

MODEL: mujoco.MjModel | None = None
DATA: mujoco.MjData | None = None
SIM_LOCK = asyncio.Lock()
FREE_QVEL_START: int | None = None
FREE_QVEL_END: int | None = None
REF_CTRL: Any = None
VIZ_GEOM_INDICES: list[int] = []
VIZ_MESH_CACHE: list[dict[str, Any]] | None = None

HAND_LEFT: np.ndarray | None = None
HAND_RIGHT: np.ndarray | None = None
_HAND_SMOOTH = float(os.environ.get("HAND_SMOOTH", "0.35"))
_HAND_FOLLOW_PELVIS = os.environ.get("HAND_FOLLOW_PELVIS", "0").lower() in ("1", "true", "yes")
_PELVIS_HOME: np.ndarray | None = None
_ARM_REACH = float(os.environ.get("ARM_REACH", "0.65"))
_IK_ITERS = int(os.environ.get("IK_ITERS", "14"))
_HAND_OFF = np.array(
    [
        float(os.environ.get("HAND_OFF_X", "0")),
        float(os.environ.get("HAND_OFF_Y", "0")),
        float(os.environ.get("HAND_OFF_Z", "0")),
    ],
    dtype=np.float64,
)

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
LEFT_HAND_JOINTS = [
    "left_hand_thumb_0_joint",
    "left_hand_thumb_1_joint",
    "left_hand_thumb_2_joint",
    "left_hand_index_0_joint",
    "left_hand_index_1_joint",
    "left_hand_middle_0_joint",
    "left_hand_middle_1_joint",
]
RIGHT_HAND_JOINTS = [
    "right_hand_thumb_0_joint",
    "right_hand_thumb_1_joint",
    "right_hand_thumb_2_joint",
    "right_hand_index_0_joint",
    "right_hand_index_1_joint",
    "right_hand_middle_0_joint",
    "right_hand_middle_1_joint",
]
WAIST_JOINTS = [
    "waist_yaw_joint",
    "waist_roll_joint",
    "waist_pitch_joint",
]

_MJ_TO_THREE_B = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]], dtype=np.float64)
_MJ_TO_THREE_BT = _MJ_TO_THREE_B.T.copy()

CMD: dict[str, float] = {
    "lx": 0.0, "ly": 0.0, "rx": 0.0, "ry": 0.0,
    "left_trig": 0.0, "right_trig": 0.0,
}

# --- Finger curl targets (0=open, 1=closed), smoothed ---
FINGERS_LEFT: np.ndarray | None = None   # 7 values: thumb(3) + index(2) + middle(2)
FINGERS_RIGHT: np.ndarray | None = None
_FINGER_SMOOTH = float(os.environ.get("FINGER_SMOOTH", "0.35"))

# --- Head tracking for waist control ---
HEAD_ORIENTATION: np.ndarray | None = None  # [yaw, pitch] in rad, MuJoCo frame

# --- Mode system ---
MODE = "realtime"  # idle | realtime | recording | playback
RECORDING_BUFFER: list[dict[str, Any]] = []
PLAYBACK_DATA: list[dict[str, Any]] = []
PLAYBACK_IDX = 0
PLAYBACK_LOOP = False

# Cached actuator IDs for hand joints (populated on model load)
_HAND_ACT_CACHE: dict[str, list[tuple[int, float, float]]] | None = None


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


def _build_hand_actuator_cache(M: mujoco.MjModel) -> dict[str, list[tuple[int, float, float]]]:
    """Map hand joint names to (actuator_id, range_lo, range_hi)."""
    cache: dict[str, list[tuple[int, float, float]]] = {}
    for side, joints in [("left", LEFT_HAND_JOINTS), ("right", RIGHT_HAND_JOINTS)]:
        entries: list[tuple[int, float, float]] = []
        for name in joints:
            aid = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_ACTUATOR, name)
            if aid < 0:
                print(f"  [warn] hand actuator {name!r} not found, skipping finger control for it")
                entries.append((-1, 0.0, 0.0))
                continue
            jid = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_JOINT, name)
            lo, hi = 0.0, 1.0
            if jid >= 0:
                lo, hi = float(M.jnt_range[jid][0]), float(M.jnt_range[jid][1])
                if lo == 0.0 and hi == 0.0:
                    lo, hi = 0.0, 1.0
            entries.append((aid, lo, hi))
        cache[side] = entries
    return cache


def load_model() -> None:
    global MODEL, DATA, REF_CTRL, _HAND_ACT_CACHE, GEOM_MANIFEST, VIZ_MESH_CACHE, _PELVIS_HOME
    if MODEL is not None:
        return
    if not SCENE.is_file():
        raise FileNotFoundError(f"Manca MJCF. Esegui SETUP.ps1: {SCENE}")
    MODEL = mujoco.MjModel.from_xml_path(str(SCENE))
    DATA = mujoco.MjData(MODEL)
    _find_free_joint()
    mujoco.mj_resetDataKeyframe(MODEL, DATA, 0)
    REF_CTRL = DATA.ctrl.copy()
    global VIZ_GEOM_INDICES
    VIZ_GEOM_INDICES = _robot_visual_mesh_geom_indices(MODEL)
    VIZ_MESH_CACHE = None
    GEOM_MANIFEST = _build_geom_manifest(MODEL)
    _HAND_ACT_CACHE = _build_hand_actuator_cache(MODEL)
    pelvis_bid = mujoco.mj_name2id(MODEL, mujoco.mjtObj.mjOBJ_BODY, "pelvis")
    _PELVIS_HOME = np.asarray(DATA.xpos[pelvis_bid], dtype=np.float64).copy() if pelvis_bid >= 0 else None
    print(f"  Modello caricato: {MODEL.njnt} joints, {MODEL.nu} actuators, {len(VIZ_GEOM_INDICES)} viz geoms")
    print(f"  STL files: {len(set(GEOM_MANIFEST))} unique")
    mujoco.mj_forward(MODEL, DATA)


def _robot_visual_mesh_geom_indices(M: mujoco.MjModel) -> list[int]:
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


def _T_geom_to_world(d: mujoco.MjData, gi: int) -> np.ndarray:
    """World transform for geom gi (geom-local -> world). Use with mesh_vert compilati."""
    R_g = np.asarray(d.geom_xmat[gi], dtype=np.float64).reshape(3, 3)
    t_g = np.asarray(d.geom_xpos[gi], dtype=np.float64)
    T = np.eye(4, dtype=np.float64)
    T[:3, :3] = R_g
    T[:3, 3] = t_g
    return T


def _T_stl_to_world(M: mujoco.MjModel, d: mujoco.MjData, gi: int) -> np.ndarray:
    """Vertici come nel file STL -> mondo MuJoCo (mesh_pos/quat/scale + geom_xmat). Per viewer leggero (STL)."""
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


GEOM_MANIFEST: list[str] | None = None


def _build_geom_manifest(M: mujoco.MjModel) -> list[str]:
    """Return the STL filename for each viz geom, in VIZ_GEOM_INDICES order."""
    import xml.etree.ElementTree as ET
    xml_path = SCENE
    tree = ET.parse(xml_path)
    root = tree.getroot()
    name_to_file: dict[str, str] = {}
    for inc in root.findall(".//include"):
        inc_file = inc.get("file", "")
        if inc_file:
            inc_path = xml_path.parent / inc_file
            if inc_path.is_file():
                inc_tree = ET.parse(inc_path)
                for mesh_el in inc_tree.findall(".//mesh"):
                    mname = mesh_el.get("name") or mesh_el.get("file", "").replace(".STL", "").replace(".stl", "")
                    mfile = mesh_el.get("file", "")
                    if mname and mfile:
                        name_to_file[mname] = mfile
    for mesh_el in root.findall(".//mesh"):
        mname = mesh_el.get("name") or mesh_el.get("file", "").replace(".STL", "").replace(".stl", "")
        mfile = mesh_el.get("file", "")
        if mname and mfile:
            name_to_file[mname] = mfile
    out: list[str] = []
    for gi in VIZ_GEOM_INDICES:
        mid = int(M.geom_dataid[gi])
        mname = mujoco.mj_id2name(M, mujoco.mjtObj.mjOBJ_MESH, mid) or ""
        out.append(name_to_file.get(mname, f"{mname}.STL"))
    return out


def _body_mat4_three(M: mujoco.MjModel, d: mujoco.MjData, bi: int) -> tuple[str, list[float]]:
    name = mujoco.mj_id2name(M, mujoco.mjtObj.mjOBJ_BODY, bi) or (f"body_{bi}" if bi else "world")
    R = np.asarray(d.xmat[bi], dtype=np.float64).reshape(9).reshape(3, 3)
    t = np.asarray(d.xpos[bi], dtype=np.float64)
    Rt = _MJ_TO_THREE_B @ R @ _MJ_TO_THREE_BT
    tt = (_MJ_TO_THREE_B @ t).tolist()
    M4 = np.eye(4, dtype=np.float64)
    M4[:3, :3] = Rt
    M4[:3, 3] = tt
    return name, M4.flatten("F").tolist()


def snapshot() -> dict[str, Any]:
    assert MODEL is not None and DATA is not None
    out: dict[str, Any] = {"time": float(DATA.time)}
    bodies: list[dict[str, Any]] = []
    for bi in range(MODEL.nbody):
        nm, m4 = _body_mat4_three(MODEL, DATA, bi)
        bodies.append({"name": nm, "mat4": m4})
    out["bodies"] = bodies
    if VIZ_GEOM_INDICES:
        gm: list[list[float]] = []
        for gi in VIZ_GEOM_INDICES:
            T = _T_geom_to_world(DATA, gi)
            R_w = T[:3, :3]
            t_w = T[:3, 3]
            Rt = _MJ_TO_THREE_B @ R_w
            tt = (_MJ_TO_THREE_B @ t_w).tolist()
            M4 = np.eye(4, dtype=np.float64)
            M4[:3, :3] = Rt
            M4[:3, 3] = tt
            gm.append(M4.flatten("F").tolist())
        out["geom_mat4"] = gm
    return out


# --------------- Teleop ---------------

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


# --------------- Arm IK ---------------

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
        roll_joint = joint_names[1] if len(joint_names) > 1 else ""
        roll_seed = None
        roll_aid = -1
        if roll_joint.endswith("_shoulder_roll_joint"):
            side_left = roll_joint.startswith("left_")
            jid_roll = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, roll_joint)
            adr_roll = qadrs[1]
            roll_aid = aids[1]
            lo, hi = model.jnt_range[jid_roll]
            dy = float(tgt[1] - sh[1])
            dy_scaled = float(np.clip(dy * 2.5, -2.0, 2.0))
            if side_left:
                roll_seed = float(np.clip(0.2 + max(0.0, dy_scaled), lo, hi))
            else:
                roll_seed = float(np.clip(-0.2 + min(0.0, dy_scaled), lo, hi))
            data.qpos[adr_roll] = roll_seed
            mujoco.mj_forward(model, data)
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
            dq = np.clip(dq, -0.15, 0.15)
            for k, dqk in enumerate(dq):
                adr = qadrs[k]
                jn = joint_names[k]
                jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, jn)
                lo, hi = model.jnt_range[jid]
                if lo == 0.0 and hi == 0.0:
                    data.qpos[adr] += float(0.45 * dqk)
                else:
                    data.qpos[adr] = float(np.clip(data.qpos[adr] + 0.45 * dqk, lo, hi))
            mujoco.mj_forward(model, data)
        if roll_seed is not None and roll_aid >= 0:
            ik_roll = float(data.qpos[qadrs[1]])
            data.ctrl[roll_aid] = float(0.2 * roll_seed + 0.8 * ik_roll)
        for k, aid in enumerate(aids):
            if aid == roll_aid:
                continue
            data.ctrl[aid] = float(data.qpos[qadrs[k]])
    finally:
        data.qpos[:] = q_backup
        mujoco.mj_forward(model, data)


def _smooth_vec(cur: np.ndarray | None, nxt: np.ndarray, alpha: float) -> np.ndarray:
    if cur is None:
        return nxt.copy()
    return (1.0 - alpha) * cur + alpha * nxt


def _pelvis_adjusted_target(target: np.ndarray | None) -> np.ndarray | None:
    """Optional: shift IK targets with pelvis drift (locomotion). Off by default."""
    if target is None or not _HAND_FOLLOW_PELVIS or MODEL is None or DATA is None or _PELVIS_HOME is None:
        return target
    pelvis_bid = mujoco.mj_name2id(MODEL, mujoco.mjtObj.mjOBJ_BODY, "pelvis")
    if pelvis_bid < 0:
        return target
    delta = np.asarray(DATA.xpos[pelvis_bid], dtype=np.float64) - _PELVIS_HOME
    return target + delta


def reset_sim_state() -> None:
    """Keyframe pose, clear teleop buffers, zero stick cmd."""
    global HAND_LEFT, HAND_RIGHT, FINGERS_LEFT, FINGERS_RIGHT, HEAD_ORIENTATION, _PELVIS_HOME
    assert MODEL is not None and DATA is not None and REF_CTRL is not None
    mujoco.mj_resetDataKeyframe(MODEL, DATA, 0)
    DATA.ctrl[:] = REF_CTRL
    mujoco.mj_forward(MODEL, DATA)
    HAND_LEFT = HAND_RIGHT = None
    FINGERS_LEFT = FINGERS_RIGHT = None
    HEAD_ORIENTATION = None
    for k in CMD:
        CMD[k] = 0.0
    pelvis_bid = mujoco.mj_name2id(MODEL, mujoco.mjtObj.mjOBJ_BODY, "pelvis")
    if pelvis_bid >= 0:
        _PELVIS_HOME = np.asarray(DATA.xpos[pelvis_bid], dtype=np.float64).copy()


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
        _ik_arm_to_target_clean(M, d, l_wrist, l_sh, LEFT_ARM_JOINTS, ld, lq, la, _pelvis_adjusted_target(HAND_LEFT))
    if HAND_RIGHT is not None:
        _ik_arm_to_target_clean(M, d, r_wrist, r_sh, RIGHT_ARM_JOINTS, rd, rq, ra, _pelvis_adjusted_target(HAND_RIGHT))


# --------------- Finger retargeting ---------------

def apply_fingers() -> None:
    """Map normalized curl values (0=open, 1=closed) to Dex3-1 hand actuators."""
    if MODEL is None or DATA is None or _HAND_ACT_CACHE is None:
        return
    for side, curls in [("left", FINGERS_LEFT), ("right", FINGERS_RIGHT)]:
        if curls is None:
            continue
        entries = _HAND_ACT_CACHE.get(side)
        if not entries:
            continue
        for i, (aid, lo, hi) in enumerate(entries):
            if aid < 0 or i >= len(curls):
                continue
            c = float(np.clip(curls[i], 0.0, 1.0))
            DATA.ctrl[aid] = lo + c * (hi - lo)


# --------------- Head -> Waist ---------------

def apply_head_to_waist() -> None:
    """Map head yaw/pitch to waist joints."""
    if MODEL is None or DATA is None or HEAD_ORIENTATION is None:
        return
    yaw, pitch = float(HEAD_ORIENTATION[0]), float(HEAD_ORIENTATION[1])
    waist_gain = 0.5
    for name, target in [("waist_yaw_joint", yaw * waist_gain), ("waist_pitch_joint", pitch * waist_gain)]:
        aid = mujoco.mj_name2id(MODEL, mujoco.mjtObj.mjOBJ_ACTUATOR, name)
        if aid < 0:
            continue
        jid = mujoco.mj_name2id(MODEL, mujoco.mjtObj.mjOBJ_JOINT, name)
        if jid >= 0:
            lo, hi = float(MODEL.jnt_range[jid][0]), float(MODEL.jnt_range[jid][1])
            if lo != 0.0 or hi != 0.0:
                target = float(np.clip(target, lo, hi))
        DATA.ctrl[aid] = target


# --------------- Input handling ---------------

_HAND_DBG_COUNT = 0

def _apply_hand_msg(h: Any) -> None:
    global HAND_LEFT, HAND_RIGHT, _HAND_DBG_COUNT
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
    _HAND_DBG_COUNT += 1
    if _HAND_DBG_COUNT <= 3 or _HAND_DBG_COUNT % 60 == 0:
        print(f"  [HAND #{_HAND_DBG_COUNT}] L={HAND_LEFT} R={HAND_RIGHT}", flush=True)


def _apply_fingers_msg(f: Any) -> None:
    global FINGERS_LEFT, FINGERS_RIGHT
    if not isinstance(f, dict):
        return
    a = _FINGER_SMOOTH
    for side in ("left", "right"):
        raw = f.get(side)
        if raw is None:
            continue
        thumb = raw.get("thumb", [0, 0, 0])
        index = raw.get("index", [0, 0])
        middle = raw.get("middle", [0, 0])
        vals = np.array(
            [float(thumb[0]), float(thumb[1]), float(thumb[2]),
             float(index[0]), float(index[1]),
             float(middle[0]), float(middle[1])],
            dtype=np.float64,
        )
        if side == "left":
            FINGERS_LEFT = _smooth_vec(FINGERS_LEFT, vals, a)
        else:
            FINGERS_RIGHT = _smooth_vec(FINGERS_RIGHT, vals, a)


def _apply_head_msg(h: Any) -> None:
    global HEAD_ORIENTATION
    if not isinstance(h, (list, tuple)) or len(h) < 7:
        return
    qx, qy, qz, qw = float(h[3]), float(h[4]), float(h[5]), float(h[6])
    yaw = math.atan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))
    pitch = math.asin(max(-1.0, min(1.0, 2.0 * (qw * qy - qz * qx))))
    tgt = np.array([yaw, pitch], dtype=np.float64)
    HEAD_ORIENTATION = _smooth_vec(HEAD_ORIENTATION, tgt, 0.3)


# --------------- Recording ---------------

def _recording_start() -> None:
    global MODE, RECORDING_BUFFER
    RECORDING_BUFFER = []
    MODE = "recording"


def _recording_stop() -> str | None:
    global MODE
    MODE = "idle"
    if not RECORDING_BUFFER:
        return None
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    fname = f"{ts}.jsonl"
    path = RECORDINGS_DIR / fname
    with open(path, "w") as fp:
        for frame in RECORDING_BUFFER:
            fp.write(json.dumps(frame) + "\n")
    return fname


def _record_frame() -> None:
    if MODEL is None or DATA is None:
        return
    RECORDING_BUFFER.append({
        "t": float(DATA.time),
        "qpos": DATA.qpos.copy().tolist(),
        "ctrl": DATA.ctrl.copy().tolist(),
    })


# --------------- Playback ---------------

def _playback_start(name: str) -> bool:
    global MODE, PLAYBACK_DATA, PLAYBACK_IDX
    path = RECORDINGS_DIR / name
    if not path.is_file():
        return False
    frames: list[dict[str, Any]] = []
    with open(path) as fp:
        for line in fp:
            line = line.strip()
            if line:
                frames.append(json.loads(line))
    if not frames:
        return False
    PLAYBACK_DATA = frames
    PLAYBACK_IDX = 0
    MODE = "playback"
    if MODEL is not None and DATA is not None:
        mujoco.mj_resetDataKeyframe(MODEL, DATA, 0)
        mujoco.mj_forward(MODEL, DATA)
    return True


def _playback_stop() -> None:
    global MODE
    MODE = "idle"


def _playback_step() -> None:
    global PLAYBACK_IDX, MODE
    if MODEL is None or DATA is None:
        return
    if PLAYBACK_IDX >= len(PLAYBACK_DATA):
        if PLAYBACK_LOOP:
            PLAYBACK_IDX = 0
            mujoco.mj_resetDataKeyframe(MODEL, DATA, 0)
            mujoco.mj_forward(MODEL, DATA)
        else:
            MODE = "idle"
            return
    frame = PLAYBACK_DATA[PLAYBACK_IDX]
    qpos = frame.get("qpos")
    ctrl = frame.get("ctrl")
    if qpos is not None and len(qpos) == MODEL.nq:
        DATA.qpos[:] = np.array(qpos, dtype=np.float64)
    if ctrl is not None and len(ctrl) == MODEL.nu:
        DATA.ctrl[:] = np.array(ctrl, dtype=np.float64)
    mujoco.mj_step(MODEL, DATA)
    PLAYBACK_IDX += 1


# --------------- Simulation step ---------------

def step_sim(dt: float) -> None:
    assert MODEL is not None and DATA is not None
    if MODE == "playback":
        _playback_step()
        return
    if REF_CTRL is not None:
        DATA.ctrl[:] = REF_CTRL
    apply_hands_ik()
    apply_fingers()
    apply_head_to_waist()
    apply_teleop(dt)
    if MODE == "recording":
        _record_frame()
    mujoco.mj_step(MODEL, DATA)




# =============== FastAPI ===============

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
        "mode": MODE,
        "http_only": http_only,
        "listen_port": port,
        "hand_follow_pelvis": _HAND_FOLLOW_PELVIS,
    }


@app.post("/api/sim/reset")
async def sim_reset() -> dict[str, Any]:
    async with SIM_LOCK:
        if MODEL is None:
            return {"error": "no model"}
        reset_sim_state()
        return {"ok": True, "mode": MODE, "sim": snapshot()}


@app.post("/api/sim/hand_follow_pelvis")
async def sim_hand_follow_pelvis(request: Request) -> dict[str, Any]:
    global _HAND_FOLLOW_PELVIS
    body = await request.json()
    _HAND_FOLLOW_PELVIS = bool(body.get("enabled", False))
    return {"ok": True, "hand_follow_pelvis": _HAND_FOLLOW_PELVIS}


@app.post("/api/client_log")
async def client_log(request: Request) -> dict[str, bool]:
    """Receive console log lines from the Quest client so we can debug without USB."""
    try:
        body = await request.json()
        lines = body.get("lines", [])
        for line in lines[:40]:
            print(f"  [CLIENT] {line}", flush=True)
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/sim_state")
async def sim_state() -> dict[str, Any]:
    async with SIM_LOCK:
        if MODEL is None:
            return {"error": "no model"}
        return {"sim": snapshot(), "mode": MODE}


@app.get("/api/g1_manifest")
async def g1_manifest() -> dict[str, Any]:
    """Return the list of STL filenames (one per viz geom) so the client can load them."""
    if GEOM_MANIFEST is None:
        return {"error": "no model", "geoms": []}
    return {"geoms": GEOM_MANIFEST}


def viz_meshes_payload() -> list[dict[str, Any]]:
    """Vertici compilati da MuJoCo (mesh_vert + mesh_face), allineati a geom_mat4 da snapshot."""
    global VIZ_MESH_CACHE
    if VIZ_MESH_CACHE is not None and VIZ_MESH_CACHE and "v" in VIZ_MESH_CACHE[0]:
        return VIZ_MESH_CACHE
    assert MODEL is not None
    M = MODEL
    out: list[dict[str, Any]] = []
    for gi in VIZ_GEOM_INDICES:
        mid = int(M.geom_dataid[gi])
        va = int(M.mesh_vertadr[mid])
        vn = int(M.mesh_vertnum[mid])
        verts = np.asarray(M.mesh_vert[va : va + vn], dtype=np.float64).reshape(-1).tolist()
        fa = int(M.mesh_faceadr[mid])
        fn = int(M.mesh_facenum[mid])
        faces = np.asarray(M.mesh_face[fa : fa + fn], dtype=np.int32).reshape(-1).tolist()
        mname = mujoco.mj_id2name(M, mujoco.mjtObj.mjOBJ_MESH, mid) or ""
        out.append({"v": verts, "i": faces, "name": mname})
    VIZ_MESH_CACHE = out
    return out


@app.get("/api/g1_viz_meshes")
async def g1_viz_meshes() -> dict[str, Any]:
    async with SIM_LOCK:
        if MODEL is None:
            return {"error": "no model", "meshes": []}
        return {"meshes": viz_meshes_payload()}


@app.get("/api/g1_arm_meshes")
async def g1_arm_meshes() -> dict[str, Any]:
    return await g1_viz_meshes()


def _mesh_piece_dict(idx: int) -> dict[str, Any]:
    assert MODEL is not None
    if idx < 0 or idx >= len(VIZ_GEOM_INDICES):
        return {"error": "bad index"}
    gi = VIZ_GEOM_INDICES[idx]
    M = MODEL
    mid = int(M.geom_dataid[gi])
    va = int(M.mesh_vertadr[mid])
    vn = int(M.mesh_vertnum[mid])
    verts = np.asarray(M.mesh_vert[va : va + vn], dtype=np.float64).reshape(-1).tolist()
    fa = int(M.mesh_faceadr[mid])
    fn = int(M.mesh_facenum[mid])
    faces = np.asarray(M.mesh_face[fa : fa + fn], dtype=np.int32).reshape(-1).tolist()
    mname = mujoco.mj_id2name(M, mujoco.mjtObj.mjOBJ_MESH, mid) or ""
    return {"v": verts, "i": faces, "name": mname, "idx": idx}


@app.get("/api/g1_mesh_count")
async def g1_mesh_count() -> dict[str, Any]:
    async with SIM_LOCK:
        if MODEL is None:
            return {"error": "no model", "count": 0}
        return {"count": len(VIZ_GEOM_INDICES)}


@app.get("/api/g1_mesh_piece/{idx}")
async def g1_mesh_piece(idx: int) -> dict[str, Any]:
    async with SIM_LOCK:
        if MODEL is None:
            return {"error": "no model"}
        d = _mesh_piece_dict(idx)
        if "error" in d:
            return d
        return d


# --- Recording REST endpoints ---

@app.get("/api/recordings")
async def list_recordings() -> dict[str, Any]:
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(
        [f.name for f in RECORDINGS_DIR.iterdir() if f.suffix == ".jsonl"],
        reverse=True,
    )
    return {"recordings": files}


@app.post("/api/recording/start")
async def recording_start() -> dict[str, Any]:
    async with SIM_LOCK:
        if MODEL is None:
            return {"error": "no model"}
        _recording_start()
        return {"ok": True, "mode": MODE}


@app.post("/api/recording/stop")
async def recording_stop() -> dict[str, Any]:
    async with SIM_LOCK:
        fname = _recording_stop()
        return {"ok": True, "mode": MODE, "file": fname, "frames": len(RECORDING_BUFFER)}


@app.post("/api/playback/start")
async def playback_start(request: Request) -> dict[str, Any]:
    body = await request.json()
    name = body.get("name", "")
    async with SIM_LOCK:
        if not _playback_start(name):
            return {"error": f"recording {name!r} not found or empty"}
        return {"ok": True, "mode": MODE, "frames": len(PLAYBACK_DATA)}


@app.post("/api/playback/stop")
async def playback_stop_ep() -> dict[str, Any]:
    async with SIM_LOCK:
        _playback_stop()
        return {"ok": True, "mode": MODE}


@app.post("/api/playback/loop")
async def playback_loop_ep(request: Request) -> dict[str, Any]:
    global PLAYBACK_LOOP
    body = await request.json()
    PLAYBACK_LOOP = bool(body.get("loop", False))
    return {"ok": True, "loop": PLAYBACK_LOOP}


@app.post("/api/mode")
async def set_mode(request: Request) -> dict[str, Any]:
    global MODE
    body = await request.json()
    new_mode = body.get("mode", "idle")
    async with SIM_LOCK:
        if new_mode == "recording":
            _recording_start()
        elif new_mode == "idle":
            if MODE == "recording":
                _recording_stop()
            elif MODE == "playback":
                _playback_stop()
            else:
                MODE = "idle"
        elif new_mode == "realtime":
            if MODE == "recording":
                _recording_stop()
            elif MODE == "playback":
                _playback_stop()
            MODE = "realtime"
        return {"ok": True, "mode": MODE}


@app.delete("/api/recordings/{name}")
async def delete_recording(name: str) -> dict[str, Any]:
    path = RECORDINGS_DIR / name
    if path.is_file():
        path.unlink()
        return {"ok": True}
    return {"error": "not found"}


# --- WebSocket ---

_WS_MSG_COUNT = 0


def _process_ws_message(raw: str) -> None:
    """Parse one incoming WS text message and update global state."""
    global MODE, _WS_MSG_COUNT
    _WS_MSG_COUNT += 1
    if _WS_MSG_COUNT <= 5 or _WS_MSG_COUNT % 300 == 0:
        print(f"  [ws#{_WS_MSG_COUNT}] {raw[:300]}", flush=True)
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return
    mtype = msg.get("type", "")

    if mtype == "ready":
        print("  [ws] client ready", flush=True)
        return

    if mtype == "input" and MODE in ("realtime", "recording", "idle"):
        ax = msg.get("axes") or {}
        CMD["lx"] = float(ax.get("lx", 0.0))
        CMD["ly"] = float(ax.get("ly", 0.0))
        CMD["rx"] = float(ax.get("rx", 0.0))
        CMD["ry"] = float(ax.get("ry", 0.0))
        CMD["left_trig"] = float(ax.get("left_trig", 0.0))
        CMD["right_trig"] = float(ax.get("right_trig", 0.0))
        if "hands" in msg:
            _apply_hand_msg(msg["hands"])
        if "fingers" in msg:
            _apply_fingers_msg(msg["fingers"])
        if "head" in msg:
            _apply_head_msg(msg["head"])

    elif mtype == "mode":
        new_mode = msg.get("mode", "idle")
        if new_mode == "recording":
            _recording_start()
        elif new_mode == "realtime":
            if MODE == "recording":
                _recording_stop()
            MODE = "realtime"
        elif new_mode == "idle":
            if MODE == "recording":
                _recording_stop()
            elif MODE == "playback":
                _playback_stop()
            MODE = "idle"

    elif mtype == "playback_start":
        _playback_start(msg.get("name", ""))

    elif mtype == "playback_stop":
        _playback_stop()


async def _ws_reader(ws: WebSocket, done: asyncio.Event) -> None:
    """Continuously read WS messages until disconnect, run as a task."""
    try:
        while not done.is_set():
            raw = await ws.receive_text()
            _process_ws_message(raw)
    except WebSocketDisconnect:
        done.set()
    except Exception as exc:
        print(f"  [ws-reader] error: {exc}", flush=True)
        done.set()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    hz = float(os.environ.get("WS_HZ", "30"))
    print(f"  [ws] accepted @ {hz}Hz", flush=True)

    done = asyncio.Event()
    reader = asyncio.create_task(_ws_reader(ws, done))

    try:
        while not done.is_set():
            async with SIM_LOCK:
                if MODEL is None or DATA is None:
                    await asyncio.sleep(1.0 / hz)
                    continue
                dt = float(MODEL.opt.timestep)
                sub = max(1, int(round(1.0 / (hz * dt))))
                for _ in range(sub):
                    step_sim(dt)
                snap = snapshot()
            payload: dict[str, Any] = {"type": "state", "sim": snap, "mode": MODE}
            if MODE == "recording":
                payload["rec_frames"] = len(RECORDING_BUFFER)
            if MODE == "playback":
                payload["playback_progress"] = {"idx": PLAYBACK_IDX, "total": len(PLAYBACK_DATA)}
            try:
                await ws.send_text(json.dumps(payload))
            except (WebSocketDisconnect, RuntimeError):
                break
            await asyncio.sleep(1.0 / hz)
    except WebSocketDisconnect:
        pass
    finally:
        done.set()
        reader.cancel()
        try:
            await reader
        except (asyncio.CancelledError, Exception):
            pass


MESH_ASSETS_DIR = SCENE.parent / "assets"
app.mount("/assets", StaticFiles(directory=str(MESH_ASSETS_DIR)), name="assets")
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


# =============== SSL / startup ===============

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
    print(f"Modalita' iniziale: {MODE}", flush=True)

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
