package opentalk.welcome;

import org.json.JSONArray;
import org.json.JSONObject;
import android.database.sqlite.SQLiteDatabase;

public final class WelcomeReaderContractTest {
    private static final String ROOM = "12345000000000001", BOT = "9001";
    private static final long NOW = 1790188000000L;
    private static int checks;
    private static void check(boolean ok) { checks++; if (!ok) throw new AssertionError("check " + checks); }
    private static JSONObject row() throws Exception {
        return new JSONObject().put("chat_id", ROOM).put("id", "9007199254740993")
            .put("created_at", Long.toString(NOW / 1000)).put("type", "0")
            .put("v", "{\"origin\":\"NEWMEM\",\"enc\":31}")
            .put("message", "{\"feedType\":4,\"members\":[{\"userId\":9007199254740995,\"nickName\":\"회원\"}]}");
    }
    private static void rejected(JSONObject row) throws Exception {
        try { WelcomeReader.normalize(row, ROOM, BOT, NOW - 1000, NOW); throw new AssertionError("accepted invalid feed"); }
        catch (IllegalArgumentException expected) { checks++; }
    }
    public static void main(String[] args) throws Exception {
        JSONObject event = WelcomeReader.normalize(row(), ROOM, BOT, NOW - 1000, NOW);
        check("9007199254740993".equals(event.getString("eventId")));
        check("9007199254740995".equals(event.getJSONArray("members").getJSONObject(0).getString("id")));
        check(!event.has("user_id") && !event.has("message") && !event.has("attachment"));
        check(WelcomeReader.normalize(row().put("v", "{\"origin\":\"MSG\"}"), ROOM, BOT, NOW-1000, NOW) == null);
        check(WelcomeReader.normalize(row().put("created_at", Long.toString(NOW/1000-121)), ROOM, BOT, NOW-200000, NOW) == null);
        check(WelcomeReader.normalize(row(), ROOM, BOT, NOW+1000, NOW) == null);
        check(WelcomeReader.normalize(row().put("message", "{\"feedType\":2}"), ROOM, BOT, NOW-1000, NOW) == null);
        check(WelcomeReader.normalize(row().put("message", "{\"feedType\":4.5,\"members\":[{\"userId\":1,\"nickName\":\"a\"}]}"), ROOM, BOT, NOW-1000, NOW) == null);
        check(WelcomeReader.normalize(row(), "2", BOT, NOW-1000, NOW) == null);
        rejected(row().put("created_at", Long.toString(NOW/1000+6)));
        rejected(row().put("message", "{\"feedType\":4,\"members\":[]}"));
        rejected(row().put("message", "{\"feedType\":4,\"members\":[{\"userId\":1.5,\"nickName\":\"a\"}]}"));
        rejected(row().put("message", "{\"feedType\":4,\"members\":[{\"userId\":\"9223372036854775808\",\"nickName\":\"a\"}]}"));
        rejected(row().put("message", "{\"feedType\":4,\"members\":[{\"userId\":1,\"nickName\":\"a\\nb\"}]}"));
        rejected(row().put("message", "{\"feedType\":4,\"members\":[{\"userId\":1,\"nickName\":\"a\"},{\"userId\":1,\"nickName\":\"b\"}]}"));
        JSONObject self = WelcomeReader.normalize(row().put("message", "{\"feedType\":4,\"members\":[{\"userId\":9001,\"nickName\":\"bot\"}]}"), ROOM, BOT, NOW-1000, NOW);
        check(self == null);
        check(WelcomeReader.hash("hello").equals("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"));
        check(WelcomeReader.validAppFileContext("u:object_r:app_data_file:s0:c66,c257,c512,c768"));
        check(!WelcomeReader.validAppFileContext("u:object_r:system_data_file:s0"));
        check(!WelcomeReader.validAppFileContext("u:r:magisk:s0"));
        check(WelcomeReader.decryptionUserId("0") == 0);
        check(WelcomeReader.decryptionUserId("-1") == -1);
        check(WelcomeReader.decryptionUserId("9007199254740995") == 9007199254740995L);
        if (args.length == 1 && "--android".equals(args[0])) {
            try (SQLiteDatabase db = SQLiteDatabase.create(null)) {
                db.execSQL("CREATE TABLE chat_logs (_id INTEGER PRIMARY KEY,user_id TEXT,v TEXT)");
                db.execSQL("INSERT INTO chat_logs VALUES (1,'42','{\"isMine\":true}')");
                for (int i = 2; i < 205; i++) db.execSQL("INSERT INTO chat_logs VALUES (?, '7', '{\"isMine\":false}')", new Object[]{i});
                check("42".equals(WelcomeReader.resolveBotId(db)));
                db.execSQL("INSERT INTO chat_logs VALUES (205,'43','{\"isMine\": true}')");
                check("43".equals(WelcomeReader.resolveBotId(db)));
            }
        }
        System.out.println("Welcome reader contract: " + checks + " passed");
    }
}
