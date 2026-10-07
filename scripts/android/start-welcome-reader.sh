#!/system/bin/sh
# Invoked by the approved root service or an explicit maintenance command.
umask 077
ROOT=/data/local/opentalk-welcome
[ "$(id -u)" = 0 ] || exit 1
[ ! -e "$ROOT/STOP" ] || exit 0
[ -r "$ROOT/config.json" ] && [ -r "$ROOT/reader.jar" ] || exit 1
IRIS_SHA=00eaa7800f904b7e3082277525adbbc0581ffe9efdb1c7a475561361f918eab0
ACTUAL_SHA=$(sha256sum "$ROOT/Iris.apk") || exit 1
[ "${ACTUAL_SHA%% *}" = "$IRIS_SHA" ] || exit 1
# The Java file lock prevents a second reader; no existing process is killed.
export CLASSPATH="$ROOT/reader.jar:$ROOT/Iris.apk"
exec /system/bin/app_process / --nice-name=opentalk-welcome-reader opentalk.welcome.WelcomeReader
