#!/usr/bin/env python3
"""
robot_relay.py — mirror the sim's hand-tracking-driven joints onto the real G1.

Standalone. Does NOT import or modify the MuJoCo sim server. It polls the sim's
read-only /api/joint_state endpoint and republishes the arm + waist angles via
talk_module.arm_sdk (rt/arm_sdk) and the fingers via Dex3 HandCmd (rt/dex3/*).

    Quest hand tracking -> sim IK -> /api/joint_state -> [this relay] -> real G1

SAFETY:
  - Runs in dry-run by default (prints, no DDS writes). Pass --send to publish.
  - Only arms (15-28) + waist (12-14) + Dex3 hands. Legs are never commanded.
  - Weight ramp / CRC / DDS handled by G1ArmSDK.
  - Ctrl-C -> ramp down and release.

Usage:
  python3 robot_relay.py                      # dry-run against local sim
  python3 robot_relay.py --send               # publish to the real robot
  python3 robot_relay.py --url http://HOST:8000/api/joint_state --send
"""
from __future__ import annotations

import argparse
import json
import signal
import ssl
import time
import urllib.request

# --- Joint order MUST match unitree_sdk2 G1_29 / arm_sdk.ALL_CONTROLLED ---
WAIST_JOINTS = ["waist_yaw_joint", "waist_roll_joint", "waist_pitch_joint"]
LEFT_ARM_JOINTS = [
    "left_shoulder_pitch_joint", "left_shoulder_roll_joint", "left_shoulder_yaw_joint",
    "left_elbow_joint", "left_wrist_roll_joint", "left_wrist_pitch_joint", "left_wrist_yaw_joint",
]
RIGHT_ARM_JOINTS = [
    "right_shoulder_pitch_joint", "right_shoulder_roll_joint", "right_shoulder_yaw_joint",
    "right_elbow_joint", "right_wrist_roll_joint", "right_wrist_pitch_joint", "right_wrist_yaw_joint",
]
# arm_sdk ALL_CONTROLLED = waist(12-14) + left arm(15-21) + right arm(22-28) = 17
CONTROLLED_GROUPS = [("waist", WAIST_JOINTS), ("left_arm", LEFT_ARM_JOINTS), ("right_arm", RIGHT_ARM_JOINTS)]

# Dex3 open/closed reference (from talk_module.hand_grasp). curl 0..1 -> q.
DEX3_OPEN = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
DEX3_CLOSE = [0.75, 0.55, 0.35, 0.85, 0.45, 0.85, 0.45]


# ----------------------------- data source -----------------------------

class JointFeed:
    """Polls the sim's /api/joint_state endpoint."""

    def __init__(self, url: str, timeout: float = 0.5):
        self.url = url
        self.timeout = timeout
        # self-signed HTTPS on the sim -> don't verify (localhost / LAN).
        self._ctx = ssl.create_default_context()
        self._ctx.check_hostname = False
        self._ctx.verify_mode = ssl.CERT_NONE

    def read(self) -> dict | None:
        try:
            ctx = self._ctx if self.url.startswith("https") else None
            with urllib.request.urlopen(self.url, timeout=self.timeout, context=ctx) as r:
                data = json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"[relay] feed error: {e}", flush=True)
            return None
        return data.get("joints")


def controlled_vector(joints: dict) -> list[float] | None:
    """Flatten joint dict into the 17-value ALL_CONTROLLED order. None if incomplete."""
    q: list[float] = []
    for group, names in CONTROLLED_GROUPS:
        g = joints.get(group) or {}
        for n in names:
            if n not in g:
                return None
            q.append(float(g[n]))
    return q


def curl_to_dex3(curls: list[float] | None) -> list[float] | None:
    """Map curl 0..1 -> Dex3 q by interpolating open->closed (hardware-tuned)."""
    if not curls or len(curls) < 7:
        return None
    return [DEX3_OPEN[i] + max(0.0, min(1.0, curls[i])) * (DEX3_CLOSE[i] - DEX3_OPEN[i]) for i in range(7)]


# ------------------------------- sink -------------------------------

class RealG1Sink:
    def __init__(self, dry_run: bool = True, kp: float = 60.0, kd: float = 1.5,
                 dex3_kp: float = 1.5, dex3_kd: float = 0.2):
        self.dry_run = dry_run
        self.kp, self.kd = kp, kd
        self.dex3_kp, self.dex3_kd = dex3_kp, dex3_kd
        self._arm = None
        self._dex_pub: dict[str, object] = {}

    def start(self) -> None:
        if self.dry_run:
            print("[relay] DRY-RUN: no DDS writes (use --send to publish)", flush=True)
            return
        from talk_module.arm_sdk import G1ArmSDK
        self._arm = G1ArmSDK()
        self._arm.set_gains([self.kp] * 17, [self.kd] * 17)
        self._arm.start("active")  # weight ramp; holds current pose before tracking

    def send_arms(self, q17: list[float]) -> None:
        if self.dry_run:
            print("[arms]", " ".join(f"{v:+.2f}" for v in q17), flush=True)
            return
        self._arm.set_targets(q17)

    def send_fingers(self, side: str, q7: list[float]) -> None:
        if self.dry_run:
            print(f"[dex3:{side}]", " ".join(f"{v:+.2f}" for v in q7), flush=True)
            return
        self._publish_dex3(side, q7)

    def _publish_dex3(self, side: str, q7: list[float]) -> None:
        from unitree_sdk2py.core.channel import ChannelPublisher
        from unitree_sdk2py.idl.default import unitree_hg_msg_dds__HandCmd_
        from unitree_sdk2py.idl.unitree_hg.msg.dds_ import HandCmd_
        if side not in self._dex_pub:
            pub = ChannelPublisher(f"rt/dex3/{side}/cmd", HandCmd_)
            pub.Init()
            self._dex_pub[side] = pub
        msg = unitree_hg_msg_dds__HandCmd_()
        for i in range(7):
            msg.motor_cmd[i].mode = (i & 0x0F) | (0x01 << 4)  # ris mode, per hand_grasp.py
            msg.motor_cmd[i].q = float(q7[i])
            msg.motor_cmd[i].dq = 0.0
            msg.motor_cmd[i].tau = 0.0
            msg.motor_cmd[i].kp = self.dex3_kp
            msg.motor_cmd[i].kd = self.dex3_kd
        self._dex_pub[side].Write(msg)

    def stop(self) -> None:
        if self._arm is not None:
            self._arm.stop()


# ------------------------------- main -------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Relay sim joint angles onto the real G1.")
    ap.add_argument("--url", default="https://127.0.0.1:8443/api/joint_state",
                    help="sim joint_state endpoint")
    ap.add_argument("--hz", type=float, default=50.0, help="publish rate (Hz)")
    ap.add_argument("--send", action="store_true", help="actually publish (default dry-run)")
    ap.add_argument("--no-hands", action="store_true", help="arms/waist only")
    ap.add_argument("--use-hand-angles", action="store_true",
                    help="send sim Dex3 joint angles instead of curl->open/close mapping")
    args = ap.parse_args()

    feed = JointFeed(args.url)
    sink = RealG1Sink(dry_run=not args.send)

    running = {"on": True}
    signal.signal(signal.SIGINT, lambda *_: running.update(on=False))

    sink.start()
    period = 1.0 / max(1.0, args.hz)
    last_warn = 0.0
    try:
        while running["on"]:
            t0 = time.time()
            joints = feed.read()
            if joints is None:
                time.sleep(period)
                continue

            q17 = controlled_vector(joints)
            if q17 is not None:
                sink.send_arms(q17)
            elif t0 - last_warn > 2.0:
                print("[relay] incomplete arm/waist data; skipping frame", flush=True)
                last_warn = t0

            if not args.no_hands:
                for side, group, curl_key in (
                    ("left", "left_hand", "left_hand_curl"),
                    ("right", "right_hand", "right_hand_curl"),
                ):
                    if args.use_hand_angles:
                        g = joints.get(group) or {}
                        q7 = list(g.values())[:7] if len(g) >= 7 else None
                    else:
                        q7 = curl_to_dex3(joints.get(curl_key))
                    if q7 is not None:
                        sink.send_fingers(side, q7)

            dt = time.time() - t0
            if dt < period:
                time.sleep(period - dt)
    finally:
        print("\n[relay] stopping", flush=True)
        sink.stop()


if __name__ == "__main__":
    main()
