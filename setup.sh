#!/bin/bash

# Install gclone static binary
wget -q https://github.com/xhghs/files/releases/download/0.1/gclone.zip
unzip -q gclone.zip
export PATH=$PWD:$PATH
chmod 777 /app/rclone

# Install aria2c static binary
wget -q https://github.com/q3aql/aria2-static-builds/releases/download/v1.35.0/aria2-1.35.0-linux-gnu-64bit-build1.tar.bz2
tar xf aria2-1.35.0-linux-gnu-64bit-build1.tar.bz2
export PATH=$PWD/aria2-1.35.0-linux-gnu-64bit-build1:$PATH

# Create download folder
mkdir -p downloads

# DHT
wget -q https://github.com/P3TERX/aria2.conf/raw/master/dht.dat
wget -q https://github.com/P3TERX/aria2.conf/raw/master/dht6.dat

# Tracker
tracker_list=$(wget -qO- https://trackerslist.com/all.txt |awk NF|sed ":a;N;s/\n/,/g;ta")
echo "bt-tracker=$tracker_list" >> aria2c.conf
