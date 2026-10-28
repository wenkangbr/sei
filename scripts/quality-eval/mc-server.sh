#!/usr/bin/env bash
# scripts/quality-eval/mc-server.sh: the local Minecraft server the nightly
# companion-quality eval plays on. Vanilla, offline mode, fixed seed.
#
#   mc-server.sh setup        download the server jar, write eula/properties
#   mc-server.sh start        start in the background, wait for "Done"
#   mc-server.sh stop         graceful stop (save + exit)
#   mc-server.sh reset        stop, then restore the world from the pristine
#                             snapshot (the first reset generates it)
#   mc-server.sh cmd "<cmd>"  run a console command (no leading slash)
#   mc-server.sh status
#
# Everything lives under $QE_MC_DIR (default ~/suisei/eval/mc-server), never
# in git. Env: QE_MC_VERSION (1.21.11), QE_MC_PORT (25590), QE_MC_SEED,
# QE_MC_HEAP (1792M).
set -euo pipefail

DIR="${QE_MC_DIR:-$HOME/suisei/eval/mc-server}"
VERSION="${QE_MC_VERSION:-1.21.11}"
PORT="${QE_MC_PORT:-25590}"
SEED="${QE_MC_SEED:-sei-companion-eval-1}"
HEAP="${QE_MC_HEAP:-1792M}"
JAVA="${QE_JAVA:-java}"

mkdir -p "$DIR"
cd "$DIR"

log() { echo "[mc-server] $*" >&2; }

is_running() {
  [[ -f server.pid ]] && kill -0 "$(cat server.pid)" 2>/dev/null
}

setup() {
  if [[ ! -f "server-$VERSION.jar" ]]; then
    log "downloading vanilla server $VERSION"
    local vurl jurl sha
    vurl=$(curl -fsSL https://piston-meta.mojang.com/mc/game/version_manifest_v2.json |
      python3 -c "import json,sys;d=json.load(sys.stdin);print([v['url'] for v in d['versions'] if v['id']=='$VERSION'][0])")
    read -r jurl sha < <(curl -fsSL "$vurl" |
      python3 -c "import json,sys;s=json.load(sys.stdin)['downloads']['server'];print(s['url'],s['sha1'])")
    curl -fsSL -o "server-$VERSION.jar.tmp" "$jurl"
    echo "$sha  server-$VERSION.jar.tmp" | sha1sum -c - >/dev/null
    mv "server-$VERSION.jar.tmp" "server-$VERSION.jar"
  fi
  # Running a server requires accepting the Minecraft EULA.
  echo "eula=true" > eula.txt
  # Kept small for a 4 vCPU / 8 GB box. spawn-protection=0 so the (non-op)
  # companion can dig near spawn, as it can in a LAN world.
  cat > server.properties <<EOF
online-mode=false
enforce-secure-profile=false
server-port=$PORT
server-ip=127.0.0.1
level-seed=$SEED
level-name=world
gamemode=survival
difficulty=normal
spawn-protection=0
view-distance=6
simulation-distance=6
max-players=6
white-list=false
motd=Sei Quality Eval
pause-when-empty-seconds=-1
sync-chunk-writes=false
enable-command-block=false
allow-flight=true
spawn-monsters=true
EOF
  log "setup ok ($DIR, $VERSION, port $PORT, seed $SEED)"
}

start() {
  [[ -f "server-$VERSION.jar" ]] || setup
  if is_running; then log "already running (pid $(cat server.pid))"; return 0; fi
  : > console.in
  : > server.log
  # The console is a file the server's stdin tails, so any process can send
  # commands with `mc-server.sh cmd`. setsid puts tail + java in one process
  # group so stop can reap both.
  setsid bash -c "tail -n0 -F console.in | exec $JAVA -Xms512M -Xmx$HEAP -XX:+UseSerialGC -jar server-$VERSION.jar nogui >> server.log 2>&1" </dev/null >/dev/null 2>&1 &
  local pgid=$!
  echo "$pgid" > server.pgid
  # Find the java pid inside the group.
  for _ in $(seq 1 50); do
    local jp
    jp=$(pgrep -g "$pgid" -f "server-$VERSION.jar" | grep -v "^$pgid$" | head -1 || true)
    if [[ -n "$jp" ]] && [[ "$(cat /proc/$jp/comm 2>/dev/null)" == java ]]; then echo "$jp" > server.pid; break; fi
    sleep 0.2
  done
  is_running || { log "java did not start"; tail -20 server.log >&2; exit 1; }
  log "starting (pid $(cat server.pid)), waiting for Done"
  for _ in $(seq 1 600); do
    if grep -q 'Done (' server.log; then log "ready on 127.0.0.1:$PORT"; return 0; fi
    is_running || { log "server exited during startup"; tail -30 server.log >&2; exit 1; }
    sleep 0.5
  done
  log "timed out waiting for Done"; exit 1
}

stop() {
  if ! is_running; then
    [[ -f server.pgid ]] && kill -TERM -- "-$(cat server.pgid)" 2>/dev/null || true
    rm -f server.pid server.pgid
    log "not running"; return 0
  fi
  local pid; pid=$(cat server.pid)
  echo "stop" >> console.in
  for _ in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then log "forcing kill"; kill -9 "$pid" 2>/dev/null || true; fi
  [[ -f server.pgid ]] && kill -TERM -- "-$(cat server.pgid)" 2>/dev/null || true
  rm -f server.pid server.pgid
  log "stopped"
}

reset() {
  stop
  if [[ -d world.pristine ]]; then
    rm -rf world
    cp -a world.pristine world
    log "world restored from pristine snapshot"
  else
    log "no pristine snapshot yet: generating the world from seed $SEED"
    rm -rf world
    start
    stop
    cp -a world world.pristine
    log "pristine snapshot saved"
  fi
  rm -f ops.json usercache.json banned-players.json banned-ips.json whitelist.json
}

cmd() {
  is_running || { log "not running"; exit 1; }
  echo "$*" >> console.in
}

case "${1:-}" in
  setup) setup ;;
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  cmd) shift; cmd "$@" ;;
  status) if is_running; then echo "running pid $(cat server.pid) port $PORT"; else echo "stopped"; fi ;;
  *) echo "usage: $0 setup|start|stop|reset|cmd <command>|status" >&2; exit 2 ;;
esac
