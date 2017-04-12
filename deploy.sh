#!/bin/bash

DAEMON="node index.js"

echo
echo "☢  THiNX RE-DEPLOYMENT STARTED ☢"
echo
echo "» Checking environment..."

if [[ $(uname) == "Darwin" ]]; then
	echo "» SERVER ONLY: This script is not intended to run on workstation."
	echo
	exit 1
fi

echo
echo "» Checking if node.js is running..."

NODEZ=$(ps -ax | grep "$DAEMON")

echo "${NODEZ}" | while IFS="pts" read A B ; do 
	NODE=$($A | tr -d ' ')
	echo "Killing: " $NODE $B
	kill "$NODE"
done

echo
echo "» Fetching current app version from GIT..."

git pull origin master

echo
echo "☢  Running node.js as a background process..."

nohup node index.js > thinx.log &

echo
echo "» Monitoring log. You can exit any time by pressing ^C and logout. Node.js will be still running."
echo

tail -f thinx.log

