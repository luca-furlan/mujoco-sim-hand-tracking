export UNITREE_ROBOT_IP=192.168.123.161         # your G1's IP
export UNITREE_DDS_INTERFACE=lan2                # the NIC on the 192.168.123.x subnet
export PYTHONPATH=/home/lab/Desktop/G1-TalkModule-OpenAiAPI:$PYTHONPATH

./START_JETSON.sh &
.venv/bin/python robot_relay.py --send --no-hands --hz 50
