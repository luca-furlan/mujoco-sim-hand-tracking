#!/usr/bin/env python3
"""Apply Jetson/full-teleop patches on top of lucaDev branch."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "static" / "app.js"
SRV = ROOT / "server.py"
G1 = Path("/home/lab/g1-teleop")


def patch_server() -> None:
    text = SRV.read_text()
    text = text.replace(
        'SCENE = (ROOT / "vendor" / "mujoco_menagerie" / "unitree_g1" / "scene.xml").resolve()',
        '_SCENE_DEFAULT = ROOT / "vendor" / "mujoco_menagerie" / "unitree_g1" / "scene_with_hands.xml"\n'
        'SCENE = Path(os.environ.get("MJCF_SCENE", str(_SCENE_DEFAULT))).resolve()',
    )
    if "LEFT_HAND_JOINTS" not in text:
        hand_block = G1.joinpath("server.py").read_text()
        start = hand_block.index("LEFT_HAND_JOINTS = [")
        end = hand_block.index("WAIST_JOINTS = [")
        joints = hand_block[start:end].rstrip() + "\n"
        text = text.replace(
            '"right_wrist_yaw_joint",\n]\n\n_MJ_TO_THREE_B',
            '"right_wrist_yaw_joint",\n]\n' + joints + "\n_MJ_TO_THREE_B",
        )
    if "FINGERS_LEFT" not in text:
        text = text.replace(
            "VIZ_MESH_CACHE: list[dict[str, Any]] | None = None\n",
            "VIZ_MESH_CACHE: list[dict[str, Any]] | None = None\n"
            "FINGERS_LEFT: np.ndarray | None = None\n"
            "FINGERS_RIGHT: np.ndarray | None = None\n"
            "_FINGER_SMOOTH = float(os.environ.get(\"FINGER_SMOOTH\", \"0.35\"))\n"
            "_HAND_ACT_CACHE: dict[str, list[tuple[int, float, float]]] | None = None\n",
        )
    if "_build_hand_actuator_cache" not in text:
        fn = '''
def _build_hand_actuator_cache(M: mujoco.MjModel) -> dict[str, list[tuple[int, float, float]]]:
    cache: dict[str, list[tuple[int, float, float]]] = {}
    for side, joints in [("left", LEFT_HAND_JOINTS), ("right", RIGHT_HAND_JOINTS)]:
        entries: list[tuple[int, float, float]] = []
        for name in joints:
            aid = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_ACTUATOR, name)
            if aid < 0:
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


def apply_fingers() -> None:
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
            [
                float(thumb[0] if len(thumb) > 0 else 0),
                float(thumb[1] if len(thumb) > 1 else 0),
                float(thumb[2] if len(thumb) > 2 else 0),
                float(index[0] if len(index) > 0 else 0),
                float(index[1] if len(index) > 1 else 0),
                float(middle[0] if len(middle) > 0 else 0),
                float(middle[1] if len(middle) > 1 else 0),
            ],
            dtype=np.float64,
        )
        if side == "left":
            FINGERS_LEFT = _smooth_vec(FINGERS_LEFT, vals, a)
        else:
            FINGERS_RIGHT = _smooth_vec(FINGERS_RIGHT, vals, a)

'''
        text = text.replace("def _smooth_vec(cur:", fn + "def _smooth_vec(cur:")
    if "_HAND_ACT_CACHE = _build_hand_actuator_cache" not in text:
        text = text.replace(
            "    global VIZ_GEOM_INDICES, VIZ_MESH_CACHE\n"
            "    VIZ_GEOM_INDICES = _robot_visual_mesh_geom_indices(MODEL)\n"
            "    VIZ_MESH_CACHE = None\n"
            "    mujoco.mj_forward(MODEL, DATA)\n",
            "    global VIZ_GEOM_INDICES, VIZ_MESH_CACHE, _HAND_ACT_CACHE\n"
            "    VIZ_GEOM_INDICES = _robot_visual_mesh_geom_indices(MODEL)\n"
            "    VIZ_MESH_CACHE = None\n"
            "    _HAND_ACT_CACHE = _build_hand_actuator_cache(MODEL)\n"
            "    mujoco.mj_forward(MODEL, DATA)\n",
        )
    if "apply_fingers()" not in text:
        text = text.replace(
            "    apply_hands_ik()\n    _rate_limit_arm_actuators()",
            "    apply_hands_ik()\n    apply_fingers()\n    _rate_limit_arm_actuators()",
        )
    if '"fingers" in msg' not in text:
        text = text.replace(
            '        if "hands" in msg:\n            _apply_hand_msg(msg.get("hands"))\n',
            '        if "hands" in msg:\n            _apply_hand_msg(msg.get("hands"))\n'
            '        if "fingers" in msg:\n            _apply_fingers_msg(msg.get("fingers"))\n',
        )
    SRV.write_text(text)
    print("patched server.py")


def patch_app() -> None:
    text = APP.read_text()

    if "ROBOT_STAGE_DIST" not in text:
        text = text.replace(
            "const BG_NORMAL = new THREE.Color(0x080c14);\n",
            "const BG_NORMAL = new THREE.Color(0x080c14);\n"
            "const ROBOT_STAGE_DIST = 2.05;\n"
            "const ROBOT_STAGE_YAW = Math.PI / 2;\n"
            "const _matWorld = new THREE.Matrix4();\n"
            "const _matInvRobotStage = new THREE.Matrix4();\n",
        )

    old_robot = """const robotGroup = new THREE.Group();
scene.add(robotGroup);
let robotMeshes = [];"""
    new_robot = """const robotStage = new THREE.Group();
robotStage.position.set(0, 0.9, -(ROBOT_STAGE_DIST + 1.3));
robotStage.rotation.y = ROBOT_STAGE_YAW;
scene.add(robotStage);

const robotGroup = new THREE.Group();
robotStage.add(robotGroup);

const robotMirrorDeskGroup = new THREE.Group();
robotMirrorDeskGroup.position.set(0, 0, -ROBOT_STAGE_DIST);
scene.add(robotMirrorDeskGroup);

(function buildRobotMirrorDesk() {
  const TZ = -0.72;
  const TY = 0.82;
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a3525, roughness: 0.9, metalness: 0.04 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.045, 0.88), wood);
  top.position.set(0, TY - 0.0225, TZ);
  top.receiveShadow = true;
  robotMirrorDeskGroup.add(top);
  const pl = new THREE.PointLight(0xffeedd, 9, 3.2, 1.25);
  pl.position.set(0, TY + 0.48, TZ);
  robotMirrorDeskGroup.add(pl);
  const pm = (c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.22, roughness: 0.38 });
  const put = (mesh, x, y, z) => {
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    robotMirrorDeskGroup.add(mesh);
  };
  put(new THREE.Mesh(new THREE.SphereGeometry(0.055, 24, 18), pm(0xf97316)), -0.32, TY + 0.055, TZ + 0.06);
  put(new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), pm(0x22d3ee)), 0.02, TY + 0.055, TZ - 0.04);
  put(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 20), pm(0xeab308)), 0.32, TY + 0.06, TZ + 0.05);
  put(new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.018, 10, 24), pm(0xd946ef)), -0.08, TY + 0.055, TZ - 0.12);
})();

let robotMeshes = [];"""
    if old_robot in text:
        text = text.replace(old_robot, new_robot)

    old_passthrough = """function applyPassthroughVisuals() {
  const on = passthroughWanted && renderer.xr.isPresenting;
  if (on) {
    roomShell.visible = false;
    conveyorGroup.visible = true;
    scene.background = null;
    scene.fog = null;
    renderer.setClearColor(0x000000, 0);
    robotGroup.visible = false;
  } else {
    roomShell.visible = true;
    conveyorGroup.visible = true;
    scene.background = BG_NORMAL.clone();
    scene.fog = new THREE.Fog(BG_NORMAL.getHex(), 5.5, 38);
    renderer.setClearColor(0x000000, 1);
    robotGroup.visible = true;
  }
}"""
    new_passthrough = """function applyPassthroughVisuals() {
  const on = passthroughWanted && renderer.xr.isPresenting;
  if (on) {
    roomShell.visible = false;
    conveyorGroup.visible = true;
    scene.background = null;
    scene.fog = null;
    renderer.setClearColor(0x000000, 0);
  } else {
    roomShell.visible = true;
    conveyorGroup.visible = true;
    scene.background = BG_NORMAL.clone();
    scene.fog = new THREE.Fog(BG_NORMAL.getHex(), 5.5, 38);
    renderer.setClearColor(0x000000, 1);
  }
  robotStage.visible = robotMeshes.length > 0;
  robotGroup.visible = robotMeshes.length > 0;
  robotMirrorDeskGroup.visible = true;
}"""
    text = text.replace(old_passthrough, new_passthrough)

    old_apply = """function applyRobotMatrices(geomMat4List) {
  if (!geomMat4List?.length || !robotMeshes.length) return;
  const n = Math.min(geomMat4List.length, robotMeshes.length);
  for (let i = 0; i < n; i++) {
    robotMeshes[i].matrix.fromArray(geomMat4List[i]);
    robotMeshes[i].updateMatrixWorld(true);
  }
}"""
    new_apply = """function applyRobotMatrices(geomMat4List) {
  if (!geomMat4List?.length || !robotMeshes.length) return;
  robotStage.updateWorldMatrix(true, false);
  _matInvRobotStage.copy(robotStage.matrixWorld).invert();
  const n = Math.min(geomMat4List.length, robotMeshes.length);
  for (let i = 0; i < n; i++) {
    const mesh = robotMeshes[i];
    if (!mesh) continue;
    _matWorld.fromArray(geomMat4List[i]);
    mesh.matrix.multiplyMatrices(_matInvRobotStage, _matWorld);
    mesh.updateMatrixWorld(true);
  }
}"""
    text = text.replace(old_apply, new_apply)

    if "function readFingers" not in text:
        g1app = G1.joinpath("static/app.js").read_text()
        start = g1app.index("// =============== Finger tracking ===============")
        end = g1app.index("// =============== Head tracking ===============")
        finger_block = g1app[start:end]
        text = text.replace(
            "function handSide(src) {",
            finger_block + "\nfunction handSide(src) {",
        )

    text = text.replace(
        "function sendInput(axes, hands) {",
        "function sendInput(axes, hands, fingers) {",
    )
    text = text.replace(
        "  if (hands !== undefined) o.hands = applyHandCalibToHands(hands);\n  ws.send(JSON.stringify(o));",
        "  if (hands !== undefined) o.hands = applyHandCalibToHands(hands);\n"
        "  if (fingers !== undefined) o.fingers = fingers;\n  ws.send(JSON.stringify(o));",
    )

    old_animate = """    const hands = readHands(frame, refSpace);
    const hk = Object.keys(hands);
    sendInput(ax, hk.length ? hands : undefined);"""
    new_animate = """    const hands = readHands(frame, refSpace);
    const fingers = readFingers(frame, refSpace);
    const hk = Object.keys(hands);
    const fk = Object.keys(fingers);
    sendInput(ax, hk.length ? hands : undefined, fk.length ? fingers : undefined);"""
    if old_animate in text:
        text = text.replace(old_animate, new_animate)

    APP.write_text(text)
    print("patched app.js")


def main() -> None:
    patch_server()
    patch_app()


if __name__ == "__main__":
    main()
