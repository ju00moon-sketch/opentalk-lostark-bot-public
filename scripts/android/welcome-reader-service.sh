#!/system/bin/sh
# Install into Magisk service.d only after observation and activation approval.
umask 077
WAITED=0
while [ "$(getprop sys.boot_completed)" != 1 ] && [ "$WAITED" -lt 120 ]; do
  sleep 2
  WAITED=$((WAITED + 2))
done
[ "$(getprop sys.boot_completed)" = 1 ] || exit 1
[ ! -e /data/local/opentalk-welcome/STOP ] || exit 0
# Wait for credential-encrypted app storage to be available after device unlock.
while [ ! -d /data/user/0/com.kakao.talk/databases ] && [ "$WAITED" -lt 600 ]; do
  sleep 5
  WAITED=$((WAITED + 5))
done
[ -d /data/user/0/com.kakao.talk/databases ] || exit 1
/system/bin/sh /data/local/opentalk-welcome/start-welcome-reader.sh \
  >"/data/local/opentalk-welcome/reader-$(date +%Y%m%dT%H%M%S).log" 2>&1 </dev/null &
