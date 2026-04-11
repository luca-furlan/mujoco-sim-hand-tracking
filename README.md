# G1 local — teleoperazione VR (WebXR)

Server Python (FastAPI + MuJoCo) con pagina **Three.js** per controllare il robot **Unitree G1** in simulazione, con **hand tracking**, pinch su oggetti sul tavolo e opzione passthrough.

## Requisiti

- Windows 10/11 (percorsi pensati per PowerShell; il server è Python standard)
- Python 3.10+ con `py` o `python` nel PATH
- Git (per `SETUP.ps1`, clone di MuJoCo Menagerie)

## Setup (una tantum)

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\SETUP.ps1
```

Crea `.venv`, installa le dipendenze e scarica **solo** `unitree_g1` da [mujoco_menagerie](https://github.com/google-deepmind/mujoco_menagerie) in `vendor/mujoco_menagerie/`.

## Avvio

```powershell
.\START.ps1
```

Poi apri **https://127.0.0.1:8443/** (accetta il certificato autofirmato). Per **Meta Quest**: stessa rete Wi‑Fi, `https://<IP-del-PC>:8443/`.

Istruzioni dettagliate in italiano: [COME_USARE.txt](COME_USARE.txt).

## Licenze / asset

- MuJoCo Menagerie: vedi il repository DeepMind collegato sopra.
- Mani WebXR (`static/hand-xr/*.glb`): profilo [WebXR Input Profiles / generic-hand](https://github.com/immersive-web/webxr-input-profiles).

## English (short)

Local MuJoCo + FastAPI backend with a WebXR (Quest) front-end for G1 teleop. Run `SETUP.ps1` then `START.ps1`; HTTPS on port **8443**.
