package opentalk.welcome;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.lang.reflect.Method;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Narrow, read-only entry observer. No network listener or message sender. */
public final class WelcomeReader implements AutoCloseable {
    private static final String ROOT = "/data/local/opentalk-welcome";
    private static final String DB = "/data/user/0/com.kakao.talk/databases/KakaoTalk.db";
    private static final String APP = "/data/user/0/com.xfl.msgbot";
    private final SQLiteDatabase db;
    private final Object decryptor;
    private final Method decrypt;
    private final String botId;
    private final String[] rooms;
    private final long startedAt;
    private final String generation = UUID.randomUUID().toString();
    private final String baseline;

    private static void require(boolean ok, String code) {
        if (!ok) throw new IllegalArgumentException(code);
    }
    static String id(Object value) {
        require(value instanceof String || value instanceof Long || value instanceof Integer, "INVALID_ID_TYPE");
        String s = String.valueOf(value);
        require(s.matches("[1-9][0-9]{0,18}") && (s.length() < 19 || s.compareTo("9223372036854775807") <= 0), "INVALID_ID");
        return s;
    }
    private static String name(Object value) {
        require(value instanceof String, "INVALID_NAME");
        String s = (String) value;
        require(!s.trim().isEmpty() && s.length() <= 100 && !s.matches("(?s).*[\\x00-\\x1f\\x7f-\\x9f\\ufffd].*"), "INVALID_NAME");
        return s;
    }
    static String hash(String text) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return hex.toString();
    }
    static long decryptionUserId(String value) {
        require(value != null && value.matches("-?[0-9]{1,19}"), "INVALID_DECRYPTION_AUTHOR");
        return Long.parseLong(value); // System feed authors may be zero; entrant IDs may not.
    }
    static JSONObject normalize(JSONObject row, String roomId, String botId, long startedAt, long now) throws Exception {
        if (!roomId.equals(row.getString("chat_id"))) return null;
        JSONObject metadata = new JSONObject(row.getString("v"));
        if (!"NEWMEM".equals(metadata.optString("origin")) || !"0".equals(row.getString("type"))) return null;
        String seconds = row.getString("created_at");
        require(seconds.matches("[0-9]{10}"), "INVALID_TIME");
        long at = Long.parseLong(seconds) * 1000;
        require(at <= now + 5000, "FUTURE_EVENT");
        if (at < startedAt || now - at > 120000) return null;
        JSONObject feed = new JSONObject(row.getString("message"));
        Object feedType = feed.opt("feedType");
        if (!Integer.valueOf(4).equals(feedType) && !Long.valueOf(4).equals(feedType) && !"4".equals(feedType)) return null;
        JSONArray input = feed.getJSONArray("members");
        require(input.length() > 0 && input.length() <= 100, "INVALID_MEMBERS");
        JSONArray members = new JSONArray();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < input.length(); i++) {
            JSONObject member = input.getJSONObject(i);
            String memberId = id(member.get("userId"));
            String nickname = name(member.get("nickName"));
            require(seen.add(memberId), "DUPLICATE_MEMBER");
            if (!memberId.equals(botId)) members.put(new JSONObject().put("id", memberId).put("name", nickname));
        }
        if (members.length() == 0) return null;
        return new JSONObject().put("roomId", id(roomId)).put("eventId", id(row.get("id")))
            .put("at", at).put("members", members);
    }
    private static String[] roomIds(JSONArray input) throws Exception {
        require(input.length() > 0 && input.length() <= 128, "ROOMS_REQUIRED");
        String[] rooms = new String[input.length()];
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < rooms.length; i++) { rooms[i] = id(input.get(i)); require(seen.add(rooms[i]), "DUPLICATE_ROOM"); }
        Arrays.sort(rooms);
        return rooms;
    }
    private WelcomeReader(String expectedBotId, String[] configuredRooms) throws Exception {
        db = SQLiteDatabase.openDatabase(DB, null, SQLiteDatabase.OPEN_READONLY);
        try {
            require(db.isReadOnly(), "READ_ONLY_REQUIRED");
            botId = actualBotId();
            require(expectedBotId == null || botId.equals(expectedBotId), "ACCOUNT_CHANGED");
            rooms = configuredRooms;
            verifyRooms();
            startedAt = System.currentTimeMillis();
            try (Cursor cursor = db.rawQuery("SELECT COALESCE(MAX(_id),0) FROM chat_logs", null)) {
                require(cursor.moveToFirst(), "CURSOR_REQUIRED"); baseline = cursor.getString(0);
            }
            Class<?> klass = Class.forName("party.qwer.iris.KakaoDecrypt");
            decryptor = klass.getField("Companion").get(null);
            decrypt = decryptor.getClass().getMethod("decrypt", int.class, String.class, long.class);
        } catch (Exception e) { db.close(); throw e; }
    }
    private String actualBotId() throws Exception {
        return resolveBotId(db);
    }
    static String resolveBotId(SQLiteDatabase db) throws Exception {
        // Only identity metadata is read; ordinary incoming message bodies are never selected.
        try (Cursor cursor = db.rawQuery("SELECT user_id,v FROM chat_logs WHERE "
            + "replace(replace(replace(replace(v,' ',''),char(9),''),char(10),''),char(13),'') "
            + "LIKE '%\"isMine\":true%' ORDER BY _id DESC LIMIT 100", null)) {
            while (cursor.moveToNext()) {
                JSONObject metadata = new JSONObject(cursor.getString(1));
                if (Boolean.TRUE.equals(metadata.opt("isMine"))) return id(cursor.getString(0));
            }
        }
        throw new IllegalArgumentException("BOT_ID_NOT_OBSERVED");
    }
    private void verifyRooms() throws Exception {
        for (String room : rooms) {
            try (Cursor cursor = db.rawQuery("SELECT type,link_id FROM chat_rooms WHERE id=?", new String[]{room})) {
                require(cursor.getCount() == 1 && cursor.moveToFirst(), "ROOM_NOT_FOUND");
                require("OM".equals(cursor.getString(0)), "OPEN_GROUP_REQUIRED");
                id(cursor.getString(1));
            }
        }
    }
    private String plaintext(String value, JSONObject metadata, String author) throws Exception {
        int enc = metadata.getInt("enc");
        if (enc == 0) return value;
        String result = (String) decrypt.invoke(decryptor, enc, value, decryptionUserId(author == null ? botId : author));
        require(result != null && !result.equals(value) && result.length() <= 65536, "DECRYPT_FAILED");
        return result;
    }
    private JSONObject row(Cursor cursor) throws Exception {
        JSONObject row = new JSONObject();
        for (String column : new String[]{"id","chat_id","type","created_at","v"})
            row.put(column, cursor.getString(cursor.getColumnIndexOrThrow(column)));
        JSONObject metadata = new JSONObject(row.getString("v"));
        String body = plaintext(cursor.getString(cursor.getColumnIndexOrThrow("message")), metadata,
            cursor.getString(cursor.getColumnIndexOrThrow("user_id")));
        row.put("message", body);
        return row;
    }
    private JSONObject snapshot() throws Exception {
        require(actualBotId().equals(botId), "ACCOUNT_CHANGED");
        verifyRooms();
        long now = System.currentTimeMillis();
        JSONArray events = new JSONArray(), outgoing = new JSONArray();
        for (String room : rooms) {
            try (Cursor cursor = db.rawQuery("SELECT id,chat_id,user_id,type,message,created_at,v FROM chat_logs "
                + "WHERE chat_id=? AND type=0 AND _id>? AND created_at>=? ORDER BY _id ASC LIMIT 101",
                new String[]{room, baseline, Long.toString((now-120000)/1000)})) {
                while (cursor.moveToNext()) {
                    JSONObject meta = new JSONObject(cursor.getString(cursor.getColumnIndexOrThrow("v")));
                    if (!"NEWMEM".equals(meta.optString("origin"))) continue;
                    JSONObject event = normalize(row(cursor), room, botId, startedAt, now);
                    if (event != null) events.put(event);
                    require(events.length() <= 100, "EVENT_LIMIT");
                }
            }
            try (Cursor cursor = db.rawQuery("SELECT _id,message,created_at,v FROM chat_logs "
                + "WHERE chat_id=? AND user_id=? AND type=1 AND created_at>=? ORDER BY _id DESC LIMIT 129",
                new String[]{room, botId, Long.toString((now-15000)/1000)})) {
                while (cursor.moveToNext()) {
                    JSONObject meta = new JSONObject(cursor.getString(3));
                    if (!Boolean.TRUE.equals(meta.opt("isMine"))) continue;
                    String message = plaintext(cursor.getString(1), meta, botId);
                    outgoing.put(new JSONObject().put("roomId", room).put("logId", id(cursor.getString(0)))
                        .put("at", cursor.getLong(2)*1000).put("hash", hash(message)));
                    require(outgoing.length() <= 128, "OUTGOING_LIMIT");
                }
            }
        }
        require(actualBotId().equals(botId), "ACCOUNT_CHANGED");
        return new JSONObject().put("version", 1).put("generation", generation).put("at", now)
            .put("botId", botId).put("rooms", new JSONArray(Arrays.asList(rooms))).put("events", events).put("outgoing", outgoing);
    }
    private JSONObject probe() throws Exception {
        int samples = 0, ownSamples = 0;
        for (String room : rooms) {
            try (Cursor cursor = db.rawQuery("SELECT id,chat_id,user_id,type,message,created_at,v FROM chat_logs "
                + "WHERE chat_id=? AND type=0 ORDER BY _id DESC LIMIT 50", new String[]{room})) {
                while (cursor.moveToNext()) {
                    JSONObject meta = new JSONObject(cursor.getString(cursor.getColumnIndexOrThrow("v")));
                    if (!"NEWMEM".equals(meta.optString("origin"))) continue;
                    JSONObject raw = row(cursor);
                    long at = Long.parseLong(raw.getString("created_at"))*1000;
                    if (normalize(raw, room, botId, 0, at) != null) { samples++; break; }
                }
            }
            try (Cursor cursor = db.rawQuery("SELECT message,v FROM chat_logs WHERE chat_id=? AND user_id=? AND type=1 ORDER BY _id DESC LIMIT 1", new String[]{room,botId})) {
                if (cursor.moveToFirst()) {
                    JSONObject metadata = new JSONObject(cursor.getString(1));
                    require(Boolean.TRUE.equals(metadata.opt("isMine")), "OWN_MESSAGE_REQUIRED");
                    String message = plaintext(cursor.getString(0), metadata, botId);
                    require(!message.isEmpty() && message.indexOf('\ufffd') == -1, "INVALID_OWN_MESSAGE");
                    ownSamples++;
                }
            }
        }
        return new JSONObject().put("ok", true).put("readOnly", db.isReadOnly()).put("botId", botId)
            .put("roomsVerified", rooms.length).put("historicalJoinSamplesVerified", samples)
            .put("ownOutgoingSamplesVerified", ownSamples).put("appFileContextAvailable", validAppFileContext(appFileContext()))
            .put("sending", false);
    }
    private static void secureFile(File file, int uid, int gid, int permissions) throws Exception {
        StructStat stat = Os.lstat(file.getPath());
        require(OsConstants.S_ISREG(stat.st_mode) && stat.st_uid == uid && stat.st_gid == gid
            && (stat.st_mode & 0777) == permissions && stat.st_nlink == 1, "UNSAFE_FILE");
    }
    static boolean validAppFileContext(String context) {
        return context != null && context.matches("u:object_r:app_data_file:s0(:c[0-9]+(,c[0-9]+)*)?");
    }
    private static String appFileContext() throws Exception {
        Class<?> selinux = Class.forName("android.os.SELinux");
        String context = (String) selinux.getMethod("getFileContext", String.class).invoke(null, APP);
        require(validAppFileContext(context), "APP_FILE_CONTEXT_REQUIRED");
        return context;
    }
    private static void labelSnapshot(File file) throws Exception {
        Class<?> selinux = Class.forName("android.os.SELinux");
        String context = appFileContext();
        require(Boolean.TRUE.equals(selinux.getMethod("setFileContext", String.class, String.class)
            .invoke(null, file.getPath(), context)), "SNAPSHOT_LABEL_FAILED");
        require(context.equals(selinux.getMethod("getFileContext", String.class).invoke(null, file.getPath())), "SNAPSHOT_LABEL_MISMATCH");
    }
    private static void writeSnapshot(JSONObject value, int appUid) throws Exception {
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        require(bytes.length <= 262144, "SNAPSHOT_TOO_LARGE");
        File pending = new File(ROOT, "events." + UUID.randomUUID().toString() + ".tmp");
        require(pending.createNewFile(), "SNAPSHOT_CREATE_FAILED");
        Os.chmod(pending.getPath(), 0600);
        try (FileOutputStream output = new FileOutputStream(pending)) { output.write(bytes); output.getFD().sync(); }
        Os.chown(pending.getPath(), 0, appUid); Os.chmod(pending.getPath(), 0640);
        labelSnapshot(pending);
        secureFile(pending, 0, appUid, 0640);
        Os.rename(pending.getPath(), ROOT + "/events.json");
    }
    public void close() { db.close(); }
    public static void main(String[] args) {
        int appUid = -1;
        boolean ownsLock = false;
        try {
            if (args.length == 2 && "--probe".equals(args[0])) {
                String[] rooms = roomIds(new JSONArray(Arrays.asList(args[1].split(","))));
                try (WelcomeReader reader = new WelcomeReader(null, rooms)) { System.out.println(reader.probe()); }
                return;
            }
            require(args.length == 0, "UNSUPPORTED_ARGUMENTS");
            StructStat app = Os.stat(APP);
            appUid = app.st_uid;
            require(appUid >= 10000, "APP_UID_REQUIRED");
            StructStat dir = Os.lstat(ROOT);
            require(OsConstants.S_ISDIR(dir.st_mode) && dir.st_uid == 0 && dir.st_gid == appUid
                && (dir.st_mode & 0777) == 0710, "UNSAFE_DIRECTORY");
            require(appFileContext().equals(Class.forName("android.os.SELinux").getMethod("getFileContext", String.class)
                .invoke(null, ROOT)), "DIRECTORY_LABEL_MISMATCH");
            File configFile = new File(ROOT, "config.json");
            secureFile(configFile, 0, 0, 0600);
            require(configFile.length() <= 8192, "CONFIG_TOO_LARGE");
            JSONObject config = new JSONObject(new String(Files.readAllBytes(configFile.toPath()), StandardCharsets.UTF_8));
            require(config.getInt("appUid") == appUid, "APP_UID_CHANGED");
            String bot = id(config.get("botId"));
            String[] rooms = roomIds(config.getJSONArray("rooms"));
            File lockFile = new File(ROOT, "reader.lock");
            if (lockFile.createNewFile()) { Os.chmod(lockFile.getPath(), 0600); Os.chown(lockFile.getPath(), 0, 0); }
            secureFile(lockFile, 0, 0, 0600);
            try (RandomAccessFile file = new RandomAccessFile(lockFile, "rw"); FileLock lock = file.getChannel().tryLock()) {
                require(lock != null, "ALREADY_RUNNING"); ownsLock = true;
                try (WelcomeReader reader = new WelcomeReader(bot, rooms)) {
                    while (!new File(ROOT, "STOP").exists()) {
                        writeSnapshot(reader.snapshot(), appUid);
                        Thread.sleep(1000);
                    }
                    writeSnapshot(new JSONObject().put("version", 1).put("error", "STOPPED"), appUid);
                }
            }
        } catch (Throwable error) {
            // No paths, account identifiers, chat contents or exception strings in routine diagnostics.
            if (ownsLock && appUid >= 10000) {
                try { writeSnapshot(new JSONObject().put("version", 1).put("error", "READER_STOPPED"), appUid); }
                catch (Throwable ignored) { }
            }
            System.err.println("WELCOME_READER_STOPPED: " + error.getClass().getSimpleName());
            System.exit(1);
        }
    }
}
