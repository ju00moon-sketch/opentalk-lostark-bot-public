from contextlib import closing
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent


class UpgradeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = None
        path = HERE / 'upgrade.py'
        if path.exists():
            spec = importlib.util.spec_from_file_location('web_upgrade', path)
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)

    def implementation(self):
        self.assertIsNotNone(self.module, 'Upgrade implementation is missing')
        return self.module

    def archive(self, root, entries):
        path = root / 'payload.tar.gz'
        rows = []
        with tarfile.open(path, 'w:gz') as out:
            for name, value, kind in entries:
                member = tarfile.TarInfo(name)
                member.type, member.size = kind, len(value) if kind == tarfile.REGTYPE else 0
                member.linkname = '/etc/passwd' if kind != tarfile.REGTYPE else ''
                out.addfile(member, io.BytesIO(value) if kind == tarfile.REGTYPE else None)
                rows.append({'path': name, 'size': len(value), 'sha256': hashlib.sha256(value).hexdigest()})
        return path, {'archive_sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'files': rows}

    def test_accepts_hash_bound_regular_archive(self):
        module = self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            path, index = self.archive(Path(folder), [('web/src/start.js', b'code', tarfile.REGTYPE)])
            self.assertEqual(module.read_archive(path, index, {'web/src/start.js'}), {'web/src/start.js': b'code'})
            index['files'][0]['sha256'] = '0' * 64
            with self.assertRaises(RuntimeError):
                module.read_archive(path, index, {'web/src/start.js'})

    def test_rejects_duplicate_traversal_symlink_and_secret_payloads(self):
        module = self.implementation()
        entries = [('../escape', b'x', tarfile.REGTYPE), ('/etc/passwd', b'x', tarfile.REGTYPE),
                   ('web/.env', b'x', tarfile.REGTYPE), ('web/src/start.js', b'', tarfile.SYMTYPE),
                   ('web/src/start.js', b'', tarfile.LNKTYPE)]
        for item in entries:
            with self.subTest(item=item), tempfile.TemporaryDirectory() as folder:
                path, index = self.archive(Path(folder), [item])
                with self.assertRaises(RuntimeError):
                    module.read_archive(path, index, {'web/src/start.js'})
        with tempfile.TemporaryDirectory() as folder:
            path, index = self.archive(Path(folder), [('web/src/start.js', b'x', tarfile.REGTYPE)] * 2)
            with self.assertRaises(RuntimeError):
                module.read_archive(path, index, {'web/src/start.js'})

    def test_pack_binds_explicit_inventory_tool_unit_and_archive(self):
        module = self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source'
            for name in module.CODE | module.PUBLIC | {'ops/web/opentalk-web.service'}:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'{"type":"module"}' if name == 'web/package.json' else b'fixture')
            bundle = root / 'bundle'
            sha = module.pack(source, bundle)
            payload, index = module.load_bundle(bundle, sha)
            self.assertEqual(set(payload['code']), module.CODE)
            self.assertEqual(set(payload['static']), module.PUBLIC)
            self.assertEqual(index['unit_sha256'], module.digest(b'fixture'))
            with self.assertRaises(RuntimeError):
                module.load_bundle(bundle, '0' * 64)
            (bundle / 'code.tar.gz').write_bytes(b'changed')
            with self.assertRaises(RuntimeError):
                module.load_bundle(bundle, sha)
            (source / 'web/src/unreviewed.js').write_bytes(b'new')
            with self.assertRaises(RuntimeError):
                module.pack(source, root / 'second-bundle')

    def test_environment_append_keeps_existing_secrets_and_fixed_settings(self):
        module = self.implementation()
        original = (b'WEB_ORIGIN=https://opentalk.example.invalid\nWEB_HOST=127.0.0.1\n'
                    b'WEB_PORT=8090\nWEB_DB_PATH=/var/lib/opentalk-web/auth.sqlite\n'
                    b'DISCORD_OAUTH_CLIENT_ID=123\nDISCORD_OAUTH_CLIENT_SECRET=private\n'
                    b'KAKAO_OAUTH_CLIENT_ID=456\nKAKAO_OAUTH_CLIENT_SECRET=private\n'
                    b'KAKAO_ADMIN_KEY=private\nKAKAO_APP_ID=789\n')
        self.assertEqual(module.extend_environment(original, {}), original)
        for settings in [{'WEB_PORT': '8091'}, {'DISCORD_OAUTH_CLIENT_SECRET': 'replace'},
                         {'UNREVIEWED_KEY': 'secret'}]:
            with self.assertRaises(RuntimeError):
                module.extend_environment(original, settings)
        settings = {'GUILD_AUTO_APPROVAL_ENABLED': 'true', 'GUILD_AUTO_DISCORD_GUILD_ID': '111110000000000005',
                    'GUILD_AUTO_DISCORD_ROLE_ID': '111110000000000006', 'LOSTARK_API_KEY': 'synthetic.token'}
        result = module.extend_environment(original, settings)
        self.assertTrue(result.startswith(original))
        self.assertIn(b'GUILD_AUTO_APPROVAL_ENABLED=true\n', result)
        with self.assertRaises(RuntimeError):
            module.extend_environment(original, {'GUILD_AUTO_APPROVAL_ENABLED': 'true'})

    def test_health_waits_for_service_listener_to_become_ready(self):
        module = self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'proc/77').mkdir(parents=True)
            (root / 'proc/77/status').write_text('Uid:\t995\t995\t995\t995\nGid:\t987\t987\t987\t987\n')
            attempts = []

            def runner(args):
                if args[0] == 'ss':
                    attempts.append(1)
                    return '' if len(attempts) == 1 else 'LISTEN 0 10 127.0.0.1:8090 0.0.0.0:* users:((node,pid=77,fd=1))'
                return 'active' if args[-1] == 'ActiveState' else '77'

            class Response:
                status = 200

                def read(self, size):
                    return b'{"ok":true}' if self.path.endswith('health') else b'{"authenticated":false,"providers":{"discord":true,"kakao":true}}'

                def getheader(self, key):
                    return 'no-store'

            class Connection:
                def __init__(self, *args, **kwargs):
                    pass

                def request(self, method, path):
                    self.path = path

                def getresponse(self):
                    response = Response()
                    response.path = self.path
                    return response

                def close(self):
                    pass

            release = module.Release('web-guild-20260910-2200', root=root, runner=runner)
            with patch.object(module.http.client, 'HTTPConnection', Connection), patch.object(module.time, 'sleep'):
                release.health()
            self.assertEqual(len(attempts), 2)
            (root / 'proc/77/status').write_text('Uid:\t995\t995\t995\t995\nGid:\t995\t995\t995\t995\n')
            with patch.object(module.http.client, 'HTTPConnection', Connection), patch.object(module.time, 'sleep'):
                with self.assertRaises(RuntimeError):
                    release.health()

    def fixture(self, folder, fail_start=False, profile='guild', import_failure=None, signup_failure=None):
        module = self.implementation()
        commands = []

        class LocalRelease(module.Release):
            def link(self, path, target):
                if os.name == 'nt':
                    module.write(path, str(target).encode(), 0o644)
                else:
                    super().link(path, target)

            def target(self, path, parent):
                if os.name == 'nt':
                    target = Path(path.read_text())
                    module.require(target.parent == parent and target.is_dir(), 'Unsafe link target')
                    return target
                return super().target(path, parent)

            def check_native(self):
                return 995

            def protected(self):
                return {'bot': module.digest(b'unchanged')}

            def health(self):
                return None

            def permissions(self):
                return None

        running = {'active': True, 'failed_once': False}

        def runner(args):
            commands.append(args)
            if args[:2] == ['systemctl', 'stop']:
                running['active'] = False
            elif args[:2] == ['systemctl', 'start']:
                new = release.target(release.current, release.code_releases) == release.code_release
                if new:
                    if signup_failure == 'before-migration' and not running['failed_once']:
                        running['failed_once'] = True
                        raise RuntimeError('Simulated startup failure before migration')
                    with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                        db.execute('CREATE TABLE IF NOT EXISTS extra (user_id TEXT REFERENCES users(id) ON DELETE CASCADE)')
                        if profile == 'kakao-signup':
                            db.execute('CREATE TABLE IF NOT EXISTS kakao_profiles ('
                                       'user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, nickname TEXT)')
                            if signup_failure == 'after-profile-table' and not running['failed_once']:
                                running['failed_once'] = True
                                raise RuntimeError('Simulated startup failure after profile table creation')
                        db.execute('PRAGMA user_version=' + str(release.target_schema))
                    if fail_start and not running['failed_once']:
                        running['failed_once'] = True
                        raise RuntimeError('Simulated startup failure after migration')
                running['active'] = True
            elif args[-1] == 'ActiveState':
                return 'active' if running['active'] else 'inactive'
            elif args[-1] == 'MainPID':
                return '7' if running['active'] else '0'
            return ''

        def private_runner(args, seed):
            commands.append(['private-import', *args])
            self.assertFalse(running['active'])
            self.assertEqual(release.target(release.current, release.code_releases).name, 'old')
            self.assertEqual(release.target(release.static, release.static_releases).name, 'old')
            self.assertEqual(args[:7], ['/usr/sbin/runuser', '-u', 'opentalk-web', '-g', 'opentalk-web', '--', '/usr/bin/node'])
            if import_failure == 'before':
                raise RuntimeError('Simulated import failure before migration')
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                if '--preserve-existing' in args:
                    self.assertIsNone(seed)
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM guild_schedule_sheets').fetchone()[0], 1)
                    db.execute('PRAGMA user_version=5')
                    return {'preserved': True, 'sheets': 1, 'groups': 1}
                self.assertIn('--source', args)
                db.execute('CREATE TABLE IF NOT EXISTS guild_schedule_metadata (id INTEGER PRIMARY KEY, title TEXT)')
                db.execute('CREATE TABLE IF NOT EXISTS guild_schedule_sheets (id TEXT PRIMARY KEY, title TEXT)')
                db.execute('CREATE TABLE IF NOT EXISTS guild_schedule_entries (id TEXT PRIMARY KEY, label TEXT)')
                if db.execute('SELECT COUNT(*) FROM guild_schedule_metadata').fetchone()[0]:
                    raise RuntimeError('Existing schedule import refused')
                db.execute('PRAGMA user_version=5')
                if import_failure == 'after-migration':
                    raise RuntimeError('Simulated import failure after migration')
                db.execute("INSERT INTO guild_schedule_metadata VALUES (1, 'private title')")
                db.execute("INSERT INTO guild_schedule_sheets VALUES ('sheet', 'private sheet')")
                db.execute("INSERT INTO guild_schedule_entries VALUES ('group', 'original')")
            if import_failure == 'after-import':
                raise RuntimeError('Simulated import failure after committing schedule')
            return {'imported': True, 'sheets': 1, 'groups': 1, 'sourceSha256': module.digest(seed)}

        release = LocalRelease('web-guild-20260910-2200', root=Path(folder), runner=runner,
                               profile=profile, private_runner=private_runner)
        for path in [release.code_releases / 'old', release.static_releases / 'old', release.state, release.unit.parent]:
            path.mkdir(parents=True, exist_ok=True)
        (release.code_releases / 'old/start.js').write_bytes(b'oldcode')
        (release.static_releases / 'old/index.html').write_bytes(b'oldstatic')
        for path in [release.code_releases / 'old', release.static_releases / 'old']:
            path.chmod(0o755)
            for entry in path.rglob('*'):
                entry.chmod(0o644)
        release.link(release.current, release.code_releases / 'old')
        release.link(release.static, release.static_releases / 'old')
        release.environment.write_bytes(b'unchanged-private-environment')
        release.unit.write_bytes(b'unchanged-unit')
        with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
            db.execute('CREATE TABLE users (id TEXT PRIMARY KEY)')
            db.execute("INSERT INTO users VALUES ('before')")
            db.execute('PRAGMA user_version=' + str(release.source_schema))
        inbox = release.state / 'unlink-inbox'
        inbox.mkdir()
        (inbox / 'pending.json').write_bytes(b'pending-event')
        before = release.snapshot(release.source_schema)
        payload = {'code': {'web/package.json': b'{"type":"module"}', 'web/src/start.js': b'newcode'},
                   'static': {'docs/index.html': b'newstatic'}}
        release.expected_bundle = 'f' * 64
        release.expected_seed = module.digest(b'private-seed') if profile == 'native-schedule' else None
        return release, before, payload, commands

    def test_native_pack_binds_schema_inventory_and_private_seed_digest_only(self):
        module = self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source'
            contract = module.PROFILES['native-schedule']
            for name in contract['code'] | contract['static'] | {'ops/web/opentalk-web.service'}:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'{"type":"module"}' if name == 'web/package.json' else b'fixture')
            seed_digest = module.digest(b'private-seed')
            with self.assertRaisesRegex(RuntimeError, 'seed digest'):
                module.pack(source, root / 'no-seed', 'native-schedule')
            bundle = root / 'bundle'
            pin = module.pack(source, bundle, 'native-schedule', seed_digest)
            payload, index = module.load_bundle(bundle, pin)
            self.assertEqual((index['source_schema'], index['target_schema'], index['rollback_schema']), (4, 5, 4))
            self.assertEqual((len(payload['code']), len(payload['static'])), (13, 32))
            self.assertTrue({'docs/terms.html', 'docs/theme.js', 'docs/theme.css'} <= set(payload['static']))
            self.assertEqual(index['seed_sha256'], seed_digest)
            self.assertEqual({p.name for p in bundle.iterdir()}, {'release.json', 'code.json', 'code.tar.gz', 'static.json', 'static.tar.gz'})
            self.assertNotIn(b'private-seed', (bundle / 'release.json').read_bytes())
            (source / 'docs/seed.json').write_bytes(b'private-seed')
            with self.assertRaisesRegex(RuntimeError, 'static allowlist'):
                module.pack(source, root / 'public-seed', 'native-schedule', seed_digest)

    def test_native_import_precedes_visibility_and_rollback_reupgrade_preserves_current_schedule(self):
        self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            release, before, payload, commands = self.fixture(folder, profile='native-schedule')
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                db.execute('CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE)')
                db.execute("INSERT INTO sessions VALUES ('old-session', 'before')")
            release.apply(payload, before, 5, release.environment.read_bytes(), b'private-seed')
            self.assertEqual(release.schema(), 5)
            record = json.loads((release.backup / 'transaction.json').read_bytes())
            self.assertEqual(record['schedule_import'], {'imported': True, 'sheets': 1, 'groups': 1,
                                                        'sourceSha256': release.expected_seed})
            self.assertNotIn(b'private-seed', (release.backup / 'transaction.json').read_bytes())
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                db.execute('PRAGMA foreign_keys=ON')
                db.execute("DELETE FROM users WHERE id='before'")
                db.execute("INSERT INTO users VALUES ('new-member')")
                db.execute("INSERT INTO sessions VALUES ('new-session', 'new-member')")
                db.execute("UPDATE guild_schedule_entries SET label='edited-after-release'")
            (release.state / 'unlink-inbox/pending.json').unlink()
            (release.state / 'unlink-inbox/new.json').write_bytes(b'new-event')
            release.rollback()
            self.assertEqual(release.schema(), 4)
            with closing(sqlite3.connect(release.database)) as db:
                self.assertEqual(db.execute('SELECT * FROM sessions').fetchall(), [('new-session', 'new-member')])
                self.assertEqual(db.execute('SELECT label FROM guild_schedule_entries').fetchall(), [('edited-after-release',)])
            self.assertFalse((release.state / 'unlink-inbox/pending.json').exists())
            self.assertTrue((release.state / 'unlink-inbox/new.json').exists())
            release.release = 'web-guild-20260914-0101'
            release.code_release = release.code_releases / release.release
            release.static_release = release.static_releases / release.release
            release.backup = release.backup.parent / release.release
            before_again = release.snapshot(4)
            release.apply(payload, before_again, 5, release.environment.read_bytes(), preserve_schedule=True)
            self.assertEqual(release.schema(), 5)
            with closing(sqlite3.connect(release.database)) as db:
                self.assertEqual(db.execute('SELECT label FROM guild_schedule_entries').fetchall(), [('edited-after-release',)])
            self.assertFalse(any('daemon-reload' in row or 'enable' in row or 'restart' in row or 'pm2' in row for row in commands))

    def test_native_import_and_start_failures_restore_v4_without_replacing_current_data(self):
        for failure in ['before', 'after-migration', 'after-import', 'start']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                release, before, payload, commands = self.fixture(folder, profile='native-schedule',
                    import_failure=None if failure == 'start' else failure, fail_start=failure == 'start')
                with self.assertRaisesRegex(RuntimeError, 'Simulated'):
                    release.apply(payload, before, 5, release.environment.read_bytes(), b'private-seed')
                self.assertEqual(release.schema(), 4)
                self.assertEqual(release.target(release.current, release.code_releases).name, 'old')
                self.assertEqual(release.target(release.static, release.static_releases).name, 'old')
                self.assertTrue(json.loads((release.backup / 'rollback.json').read_bytes())['completed'])
                with closing(sqlite3.connect(release.database)) as db:
                    self.assertEqual(db.execute('SELECT id FROM users').fetchall(), [('before',)])
                    if failure in ['after-import', 'start']:
                        self.assertEqual(db.execute('SELECT label FROM guild_schedule_entries').fetchall(), [('original',)])

    def test_native_wrong_seed_and_environment_fail_before_staging_or_service_stop(self):
        for seed, preserve, environment in [(b'wrong', False, None), (None, False, None),
                                             (b'private-seed', True, None), (b'private-seed', False, b'changed')]:
            with self.subTest(seed=seed, preserve=preserve), tempfile.TemporaryDirectory() as folder:
                release, before, payload, commands = self.fixture(folder, profile='native-schedule')
                with self.assertRaises(RuntimeError):
                    release.apply(payload, before, 5, environment or release.environment.read_bytes(), seed, preserve)
                self.assertEqual(commands, [])
                self.assertFalse(release.code_release.exists())

    def test_private_import_errors_never_expose_diagnostics(self):
        module = self.implementation()
        response = types.SimpleNamespace(returncode=1, stdout=b'private workbook data', stderr=b'secret token')
        with patch.object(module.subprocess, 'run', return_value=response):
            with self.assertRaisesRegex(RuntimeError, '^Private schedule import failed; current data retained for inspection$'):
                module.run_private(['import'], b'private seed')

    def test_signup_pack_binds_schema_and_complete_inventory_without_seed(self):
        module = self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source'
            contract = module.PROFILES['kakao-signup']
            for name in contract['code'] | contract['static'] | {'ops/web/opentalk-web.service'}:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'{"type":"module"}' if name == 'web/package.json' else b'fixture')
            bundle = root / 'bundle'
            pin = module.pack(source, bundle, 'kakao-signup')
            payload, index = module.load_bundle(bundle, pin)
            self.assertEqual((index['source_schema'], index['target_schema'], index['rollback_schema']), (5, 6, 5))
            self.assertEqual((len(payload['code']), len(payload['static'])), (15, 32))
            self.assertTrue({'web/src/character-profile.js', 'web/src/signup-store.js'} <= set(payload['code']))
            self.assertNotIn('seed_sha256', index)
            with self.assertRaisesRegex(RuntimeError, 'does not import'):
                module.pack(source, root / 'seed-bundle', 'kakao-signup', 'a' * 64)
            index['seed_sha256'] = 'a' * 64
            raw = module.encoded(index)
            (bundle / 'release.json').write_bytes(raw)
            with self.assertRaisesRegex(RuntimeError, 'Private seed contract'):
                module.load_bundle(bundle, module.digest(raw))
            (source / 'docs/unreviewed.json').write_bytes(b'private-profile')
            with self.assertRaisesRegex(RuntimeError, 'static allowlist'):
                module.pack(source, root / 'extra-static', 'kakao-signup')

    def test_signup_upgrade_rollback_reapply_retains_current_profiles_sessions_guild_and_schedule(self):
        with tempfile.TemporaryDirectory() as folder:
            release, before, payload, commands = self.fixture(folder, profile='kakao-signup')
            original_env = release.environment.read_bytes()
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                db.execute('CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE)')
                db.execute("INSERT INTO sessions VALUES ('old-session', 'before')")
                db.execute('CREATE TABLE guild_memberships (user_id TEXT REFERENCES users(id) ON DELETE CASCADE, status TEXT)')
                db.execute("INSERT INTO guild_memberships VALUES ('before', 'approved')")
                db.execute('CREATE TABLE guild_schedule_entries (label TEXT, owner TEXT REFERENCES users(id) ON DELETE SET NULL)')
                db.execute("INSERT INTO guild_schedule_entries VALUES ('original', 'before')")
            release.apply(payload, before, 6, original_env)
            self.assertEqual(release.schema(), 6)
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                db.execute('PRAGMA foreign_keys=ON')
                db.execute("INSERT INTO kakao_profiles VALUES ('before', 'deleted-nickname')")
                db.execute("DELETE FROM users WHERE id='before'")
                db.execute("INSERT INTO users VALUES ('new-member')")
                db.execute("INSERT INTO sessions VALUES ('new-session', 'new-member')")
                db.execute("INSERT INTO kakao_profiles VALUES ('new-member', 'chosen-nickname')")
                db.execute("INSERT INTO guild_memberships VALUES ('new-member', 'pending')")
                db.execute("UPDATE guild_schedule_entries SET label='edited-after-release'")
            (release.state / 'unlink-inbox/pending.json').unlink()
            (release.state / 'unlink-inbox/new.json').write_bytes(b'current-event')
            release.rollback()
            release.rollback()
            self.assertEqual(release.schema(), 5)
            self.assertEqual(release.environment.read_bytes(), original_env)
            with closing(sqlite3.connect(release.database)) as db:
                self.assertEqual(db.execute('SELECT * FROM sessions').fetchall(), [('new-session', 'new-member')])
                self.assertEqual(db.execute('SELECT * FROM kakao_profiles').fetchall(), [('new-member', 'chosen-nickname')])
                self.assertEqual(db.execute('SELECT * FROM guild_memberships').fetchall(), [('new-member', 'pending')])
                self.assertEqual(db.execute('SELECT * FROM guild_schedule_entries').fetchall(), [('edited-after-release', None)])
            self.assertFalse((release.state / 'unlink-inbox/pending.json').exists())
            self.assertEqual((release.state / 'unlink-inbox/new.json').read_bytes(), b'current-event')
            release.release = 'web-guild-20260915-2201'
            release.code_release = release.code_releases / release.release
            release.static_release = release.static_releases / release.release
            release.backup = release.backup.parent / release.release
            release.apply(payload, release.snapshot(5), 6, original_env)
            self.assertEqual(release.schema(), 6)
            with closing(sqlite3.connect(release.database)) as db:
                self.assertEqual(db.execute('SELECT * FROM kakao_profiles').fetchall(), [('new-member', 'chosen-nickname')])
                self.assertEqual(db.execute('SELECT * FROM guild_schedule_entries').fetchall(), [('edited-after-release', None)])
            self.assertFalse(any('private-import' in row or 'daemon-reload' in row or 'enable' in row or
                                 'restart' in row or 'pm2' in row for row in commands))

    def test_signup_failures_restore_schema5_without_restoring_stale_data(self):
        for failure in ['before-migration', 'after-profile-table', 'after-migration']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                release, before, payload, commands = self.fixture(folder, profile='kakao-signup',
                    fail_start=failure == 'after-migration', signup_failure=failure)
                with self.assertRaisesRegex(RuntimeError, 'Simulated startup failure'):
                    release.apply(payload, before, 6, release.environment.read_bytes())
                self.assertEqual(release.schema(), 5)
                self.assertEqual(release.target(release.current, release.code_releases).name, 'old')
                self.assertEqual(release.target(release.static, release.static_releases).name, 'old')
                self.assertTrue(json.loads((release.backup / 'rollback.json').read_bytes())['completed'])
                with closing(sqlite3.connect(release.database)) as db:
                    self.assertEqual(db.execute('SELECT id FROM users').fetchall(), [('before',)])
                    if failure != 'before-migration':
                        self.assertEqual(db.execute('SELECT * FROM kakao_profiles').fetchall(), [])

    def test_signup_rejects_settings_and_seed_before_staging_or_service_stop(self):
        for environment, seed, preserve in [(b'changed', None, False), (None, b'seed', False), (None, None, True)]:
            with self.subTest(environment=environment, seed=seed, preserve=preserve), tempfile.TemporaryDirectory() as folder:
                release, before, payload, commands = self.fixture(folder, profile='kakao-signup')
                with self.assertRaises(RuntimeError):
                    release.apply(payload, before, 6, environment or release.environment.read_bytes(), seed, preserve)
                self.assertEqual(commands, [])
                self.assertFalse(release.code_release.exists())

    def test_real_native_importer_stdin_and_preserve_contract(self):
        module = self.implementation()
        try:
            version = subprocess.check_output(['node', '--version'], text=True).strip()
        except (OSError, subprocess.CalledProcessError):
            self.skipTest('Node24 is required for the real importer integration')
        if not version.startswith('v24.'):
            self.skipTest('Node24 is required for the real importer integration')
        source = HERE.parent.parent / 'web/src'
        seed = json.dumps({'schema': 1, 'title': 'Synthetic schedule', 'sheets': [{
            'id': 'sheet-one', 'title': 'Synthetic sheet', 'hidden': False,
            'layout': {'rowCount': 1, 'columnCount': 1, 'columnWidths': [100], 'rowHeights': [20],
                'styles': [{}], 'cells': {'A1': {'s': 0, 'v': 'first'}}, 'merges': [],
                'hiddenRows': [], 'hiddenColumns': [], 'groups': [{'id': 'entry-one', 'kind': 'entry',
                    'cells': [{'address': 'A1', 'label': 'Name'}]}]}}]}).encode()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            root.chmod(0o700)
            database = root / 'auth.sqlite'
            bootstrap = 'import { createStore } from ' + json.dumps((source / 'store.js').as_uri()) + '; createStore(process.argv[1]).close();'
            completed = subprocess.run(['node', '--input-type=module', '--eval', bootstrap, str(database)], capture_output=True)
            self.assertEqual(completed.returncode, 0, 'Actual authentication store bootstrap failed')
            with closing(sqlite3.connect(database, isolation_level=None)) as db:
                for table in ['guild_schedule_entries', 'guild_schedule_sheets', 'guild_schedule_metadata']:
                    db.execute('DROP TABLE ' + table)
                db.execute('PRAGMA user_version=4')
            command = ['node', str(source / 'schedule-import.js'), '--database', str(database), '--service-stopped']
            result = module.run_private(command + ['--source', '-'], seed)
            self.assertEqual(result, {'imported': True, 'sheets': 1, 'groups': 1, 'sourceSha256': module.digest(seed)})
            with closing(sqlite3.connect(database, isolation_level=None)) as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 8)
                db.execute('UPDATE guild_schedule_entries SET values_json=?', ('{"A1":"edited"}',))
                expected = db.execute('SELECT * FROM guild_schedule_entries').fetchall()
            with self.assertRaisesRegex(RuntimeError, 'Private schedule import failed'):
                module.run_private(command + ['--source', '-'], seed)
            with closing(sqlite3.connect(database, isolation_level=None)) as db:
                self.assertEqual(db.execute('SELECT * FROM guild_schedule_entries').fetchall(), expected)
                db.execute('PRAGMA user_version=4')
            self.assertEqual(module.run_private(command + ['--preserve-existing'], None),
                             {'preserved': True, 'sheets': 1, 'groups': 1})
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 8)
                self.assertEqual(db.execute('SELECT * FROM guild_schedule_entries').fetchall(), expected)

    def test_real_signup_migration_restores_canonical_nickname_after_schema5_rollback(self):
        try:
            version = subprocess.check_output(['node', '--version'], text=True).strip()
        except (OSError, subprocess.CalledProcessError):
            self.skipTest('Node24 is required for real signup migration')
        if not version.startswith('v24.'):
            self.skipTest('Node24 is required for real signup migration')
        store_uri = (HERE.parent.parent / 'web/src/store.js').as_uri()
        prelude = 'import assert from "node:assert/strict"; import { createStore } from ' + json.dumps(store_uri) + ''';
            const store = createStore(process.argv[1]);
            const login = (id, token) => {
              assert.equal(store.createSession({provider:'kakao', providerId:id, displayName:'provider-name',
                tokenHash:token, expiresAt:100000, epoch:0}, 100), null);
              return store.getSession(token, 100);
            };
        '''
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            root.chmod(0o700)
            database = root / 'auth.sqlite'

            def run_store(body):
                result = subprocess.run(['node', '--input-type=module', '--eval', prelude + body,
                                         str(database)], capture_output=True)
                self.assertEqual(result.returncode, 0, 'Actual signup store compatibility check failed: ' +
                                 result.stderr.decode(errors='replace'))

            run_store("login('legacy', 'legacy-session'); store.close();")
            with closing(sqlite3.connect(database, isolation_level=None)) as db:
                legacy = db.execute('SELECT id FROM users').fetchone()[0]
                db.execute('DROP TABLE kakao_profiles')
                db.execute('PRAGMA user_version=5')
                db.execute("INSERT INTO guild_memberships VALUES (?, 'old-character', 'approved', 1, 100, 100, NULL)", (legacy,))
                db.execute("INSERT INTO guild_schedule_metadata VALUES (1, 'original schedule', 100)")
                db.execute("INSERT INTO guild_schedule_sheets VALUES ('sheet', 'original sheet', 0, 0, '{}')")
                db.execute("INSERT INTO guild_schedule_entries VALUES ('sheet', 'entry', '{}', ?, 1)", (legacy,))
                protected = {table: db.execute('SELECT * FROM ' + table).fetchall() for table in
                             ['users', 'sessions', 'guild_memberships', 'guild_schedule_metadata',
                              'guild_schedule_sheets', 'guild_schedule_entries']}
            run_store('''
                const legacy = store.getSession('legacy-session', 100);
                assert.equal(store.signup.state(legacy.id).state, 'legacy');
                store.close();
            ''')
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 8)
                for table, rows in protected.items():
                    self.assertEqual(db.execute('SELECT * FROM ' + table).fetchall(), rows)
            run_store('''
                for (const id of ['complete', 'delete-later']) {
                  const user = login(id, id + '-session');
                  assert.equal(store.signup.state(user.id).state, 'pending');
                  store.signup.complete(user.id, 'chosen-nickname', {characterName:'TestHero',
                    serverName:'TestServer', characterClass:'TestClass', itemLevel:1700.25}, 100);
                }
                store.close();
            ''')
            with closing(sqlite3.connect(database, isolation_level=None)) as db:
                db.execute('PRAGMA foreign_keys=ON')
                db.execute('PRAGMA user_version=5')
                # The previous OAuth upsert overwrites only users.display_name; it cannot change the new table.
                db.execute("UPDATE users SET display_name='provider-renamed' WHERE provider_id='complete'")
                db.execute("DELETE FROM users WHERE provider_id='delete-later'")
                db.execute('UPDATE guild_schedule_entries SET values_json=?, revision=2', ('{"edited":true}',))
                profile = db.execute("SELECT * FROM kakao_profiles WHERE state='complete'").fetchall()
                self.assertEqual(len(profile), 1)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions WHERE token_hash='delete-later-session'").fetchone()[0], 0)
            run_store('''
                const current = store.getSession('complete-session', 100);
                assert.equal(current.displayName, 'chosen-nickname');
                assert.equal(store.signup.state(current.id).character.itemLevel, 1700.25);
                assert.equal(login('complete', 'new-session').displayName, 'chosen-nickname');
                assert.equal(store.getSession('delete-later-session', 100), undefined);
                store.close();
            ''')
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 8)
                self.assertEqual(db.execute("SELECT * FROM kakao_profiles WHERE state='complete'").fetchall(), profile)
                self.assertEqual(db.execute('SELECT * FROM guild_memberships').fetchall(), protected['guild_memberships'])
                self.assertEqual(db.execute('SELECT values_json, revision FROM guild_schedule_entries').fetchall(),
                                 [('{"edited":true}', 2)])
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_upgrade_and_rollback_preserve_current_data_and_inbox(self):
        module = self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            release, before, payload, commands = self.fixture(folder)
            release.apply(payload, before, 4, release.environment.read_bytes())
            self.assertEqual(release.schema(), 4)
            self.assertTrue((release.backup / 'state/auth.sqlite').is_file())
            self.assertEqual((release.backup / 'state/unlink-inbox/pending.json').read_bytes(), b'pending-event')
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                db.execute("DELETE FROM users WHERE id='before'")
                db.execute("INSERT INTO users VALUES ('after')")
            (release.state / 'unlink-inbox/pending.json').unlink()
            (release.state / 'unlink-inbox/new.json').write_bytes(b'new-event')
            release.rollback()
            self.assertEqual(release.schema(), 1)
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                self.assertEqual(db.execute('SELECT id FROM users').fetchall(), [('after',)])
            self.assertFalse((release.state / 'unlink-inbox/pending.json').exists())
            self.assertTrue((release.state / 'unlink-inbox/new.json').exists())
            self.assertEqual(release.environment.read_bytes(), b'unchanged-private-environment')
            self.assertFalse(any('daemon-reload' in row or 'enable' in row or 'restart' in row for row in commands))

    def test_start_failure_restores_code_static_environment_and_current_database(self):
        self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            release, before, payload, commands = self.fixture(folder, fail_start=True)
            with self.assertRaisesRegex(RuntimeError, 'Simulated startup'):
                release.apply(payload, before, 4, b'new-private-environment')
            self.assertEqual(release.target(release.current, release.code_releases).name, 'old')
            self.assertEqual(release.target(release.static, release.static_releases).name, 'old')
            self.assertEqual(release.environment.read_bytes(), b'unchanged-private-environment')
            self.assertEqual(release.schema(), 1)
            self.assertTrue(json.loads((release.backup / 'rollback.json').read_bytes())['completed'])

    def test_partial_environment_write_failure_recovers_without_replacing_database(self):
        module = self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            release, before, payload, commands = self.fixture(folder)
            original = module.write
            failed = [False]

            def failure(path, data, mode=0o600):
                if path == release.environment and data == b'new-private-environment' and not failed[0]:
                    failed[0] = True
                    raise OSError('Simulated atomic write failure')
                return original(path, data, mode)

            with patch.object(module, 'write', failure), self.assertRaisesRegex(OSError, 'Simulated atomic write'):
                release.apply(payload, before, 4, b'new-private-environment')
            self.assertEqual(release.target(release.current, release.code_releases).name, 'old')
            self.assertEqual(release.schema(), 1)

    def test_preflight_drift_stops_before_service_or_files_change(self):
        self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            release, before, payload, commands = self.fixture(folder)
            release.environment.write_bytes(b'changed-externally')
            with self.assertRaisesRegex(RuntimeError, 'Preflight state changed'):
                release.apply(payload, before, 4, b'new')
            self.assertEqual(commands, [])
            self.assertFalse(release.code_release.exists())

    def test_staging_drift_never_stops_or_overwrites_the_live_installation(self):
        self.implementation()
        for changed in ['environment', 'source']:
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as folder:
                release, before, payload, commands = self.fixture(folder)
                stage = release.stage
                path = release.environment if changed == 'environment' else release.code_releases / 'old/start.js'

                def external_change(content):
                    stage(content)
                    path.write_bytes(b'external-change')

                release.stage = external_change
                with self.assertRaisesRegex(RuntimeError, 'Preflight state changed'):
                    release.apply(payload, before, 4, b'approved-environment')
                self.assertEqual(path.read_bytes(), b'external-change')
                self.assertEqual(release.target(release.current, release.code_releases).name, 'old')
                self.assertEqual(commands, [])
                self.assertFalse(release.backup.exists())

    def test_stopped_backup_drift_leaves_external_files_and_service_stopped_for_review(self):
        self.implementation()
        for changed in ['environment', 'source']:
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as folder:
                release, before, payload, commands = self.fixture(folder)
                backup = release.backup_state
                path = release.environment if changed == 'environment' else release.code_releases / 'old/start.js'

                def external_change():
                    result = backup()
                    path.write_bytes(b'external-change')
                    return result

                release.backup_state = external_change
                with self.assertRaisesRegex(RuntimeError, 'before transition'):
                    release.apply(payload, before, 4, b'approved-environment')
                self.assertEqual(path.read_bytes(), b'external-change')
                self.assertEqual(release.target(release.current, release.code_releases).name, 'old')
                self.assertEqual(release.schema(), 1)
                self.assertFalse(any(row[:2] == ['systemctl', 'start'] for row in commands))
                report = json.loads((release.backup / 'aborted.json').read_bytes())
                self.assertTrue(report['inspection_required'])
                self.assertTrue(report['live_files_untouched'])

    def test_rollback_refuses_external_links_or_schema_and_can_be_retried(self):
        self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            release, before, payload, commands = self.fixture(folder)
            release.apply(payload, before, 4, release.environment.read_bytes())
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                db.execute('PRAGMA user_version=9')
            with self.assertRaises(RuntimeError):
                release.rollback()
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                db.execute('PRAGMA user_version=4')
            release.rollback()
            release.rollback()
            self.assertEqual(release.schema(), 1)

    @unittest.skipUnless(os.name == 'posix', 'POSIX owner and mode verification requires Linux')
    def test_public_tree_refuses_writable_code_and_symlinks(self):
        module = self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            root.chmod(0o755)
            code = root / 'start.js'
            code.write_bytes(b'code')
            code.chmod(0o644)
            self.assertEqual(module.tree(root, True), {'start.js': module.digest(b'code')})
            code.chmod(0o666)
            with self.assertRaises(RuntimeError):
                module.tree(root, True)
            code.chmod(0o644)
            (root / 'linked.js').symlink_to(code)
            with self.assertRaises(RuntimeError):
                module.tree(root, True)

    @unittest.skipUnless(os.name == 'posix', 'POSIX ownership and account checks require Linux')
    def test_native_checks_reject_redirected_parent_without_rejecting_service_owned_state(self):
        module = self.implementation()
        import pwd
        import grp
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            release = module.Release('web-guild-20260910-2200', root=root)
            for path in [release.code_releases, release.static_releases, release.unit.parent, root / 'var/lib']:
                path.mkdir(parents=True, exist_ok=True)
            release.state.mkdir()
            release.state.chmod(0o700)
            os.chown(release.state, 995, 987)
            release.environment.write_bytes(b'env')
            release.unit.write_bytes(b'unit')

            def parents(path):
                for entry in [path, *path.parents]:
                    if entry == root.parent:
                        break
                    if entry.exists() or entry.is_symlink():
                        module.require(not entry.is_symlink(), 'Symlink in deployment path')
                        module.require(entry.stat().st_uid == 0 and not entry.stat().st_mode & 0o022, 'Unsafe parent')

            def runner(args):
                if args[0] == '/usr/bin/node':
                    return 'v24.19.0'
                return str(release.unit) if args[-1] == 'FragmentPath' else ''

            release.run = runner
            account = types.SimpleNamespace(pw_uid=995, pw_gid=987, pw_shell='/usr/sbin/nologin')
            group = types.SimpleNamespace(gr_gid=987)
            with patch.object(module, 'safe_parents', parents), patch.object(pwd, 'getpwnam', return_value=account), \
                    patch.object(grp, 'getgrnam', return_value=group):
                self.assertEqual(release.check_native(), 995)
                account.pw_gid = 995
                with self.assertRaisesRegex(RuntimeError, 'identity'):
                    release.check_native()
                account.pw_gid = 987
                group.gr_gid = 995
                with self.assertRaisesRegex(RuntimeError, 'identity'):
                    release.check_native()
                group.gr_gid = 987
                redirected = root / 'redirected'
                (root / 'var/lib').rename(redirected)
                (root / 'var/lib').symlink_to(redirected, target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError, 'Symlink'):
                    release.check_native()

    @unittest.skipUnless(os.name == 'posix', 'POSIX state ownership verification requires Linux')
    def test_state_permissions_require_exact_uid995_gid987(self):
        module = self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            release = module.Release('web-guild-20260910-2200', root=Path(folder))
            release.unit.parent.mkdir(parents=True)
            release.unit.write_bytes(b'unit')
            release.unit.chmod(0o644)
            release.environment.write_bytes(b'env')
            release.environment.chmod(0o600)
            release.state.mkdir(parents=True)
            release.state.chmod(0o700)
            os.chown(release.state, 995, 987)
            release.database.write_bytes(b'fixture')
            release.database.chmod(0o600)
            os.chown(release.database, 995, 987)
            release.permissions()
            os.chown(release.database, 995, 995)
            with self.assertRaisesRegex(RuntimeError, 'dedicated-user'):
                release.permissions()

    def test_rollback_keeps_foreign_key_corruption_stopped_for_review(self):
        self.implementation()
        with tempfile.TemporaryDirectory() as folder:
            release, before, payload, commands = self.fixture(folder)
            release.apply(payload, before, 4, release.environment.read_bytes())
            with closing(sqlite3.connect(release.database, isolation_level=None)) as db:
                db.execute("INSERT INTO extra VALUES ('missing')")
            with self.assertRaisesRegex(RuntimeError, 'foreign key'):
                release.rollback()
            self.assertFalse(json.loads((release.backup / 'rollback.json').read_bytes())['completed'])
            self.assertEqual(commands[-3:], [['systemctl', 'stop', 'opentalk-web.service'],
                ['systemctl', 'show', 'opentalk-web.service', '--value', '-p', 'ActiveState'],
                ['systemctl', 'show', 'opentalk-web.service', '--value', '-p', 'MainPID']])


if __name__ == '__main__':
    unittest.main(verbosity=2)
